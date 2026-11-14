// Smoke tests: is the stack that `make deploy` put into AWS Emulator alive and
// wired together? Quick checks of each deployed piece, that the API takes only
// signed-in requests that came through CloudFront, that each user sees only
// their own vendors, plus an authenticated round trip through API Gateway ->
// Lambda -> DynamoDB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { after, before, describe, it } from 'node:test';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { distributionUrl, emulatorEndpoint, stackOutputs } from '../../scripts/lib/emulator.ts';
import type { StackOutputs } from '../../scripts/lib/emulator.ts';
import { startGateway } from '../../scripts/local-gateway.ts';
import type { Gateway } from '../../scripts/local-gateway.ts';
import { createUser, deleteUser, idTokenFor } from '../helpers/users.ts';

/**
 * A request to the emulator's endpoint: to `url`, or to `path` with a `host`
 * header that picks the service (such as an API Gateway stage).
 */
const send = (
  options: { url?: string; host?: string; path?: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> => {
  const url = new URL(options.url ?? emulatorEndpoint().href);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: options.path ?? url.pathname + url.search,
        method: options.method ?? 'GET',
        // The emulator's certificate is for localhost.
        servername: 'localhost',
        ca: readFileSync(process.env.AWS_CA_BUNDLE!),
        headers: { ...(options.host && { host: options.host }), ...options.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
};

describe('deployed stack', () => {
  const cognito = new CognitoIdentityProviderClient({});
  const dynamodb = new DynamoDBClient({});
  const s3 = new S3Client({});
  let outputs: StackOutputs;
  let gateway: Gateway;

  before(async () => {
    outputs = await stackOutputs();
    gateway = await startGateway({ port: 0 });
  });

  after(async () => {
    await gateway?.close();
    for (const client of [cognito, dynamodb, s3]) client.destroy();
  });

  it('has every stack output', () => {
    for (const key of ['ApiEndpoint', 'UserPoolId', 'UserPoolClientId', 'OriginSecretArn', 'TableName', 'SiteBucketName', 'CloudFrontURL', 'DistributionId'] as const) {
      assert.ok(outputs[key], `missing output ${key}`);
    }
    assert.match(outputs.ApiEndpoint, /^https:\/\/[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com\/prod\/$/);
  });

  it('has an active vendor table keyed by owner and vendor', async () => {
    const { Table } = await dynamodb.send(new DescribeTableCommand({ TableName: outputs.TableName }));
    assert.equal(Table?.TableStatus, 'ACTIVE');
    assert.deepEqual(Table?.KeySchema, [
      { AttributeName: 'ownerId', KeyType: 'HASH' },
      { AttributeName: 'vendorId', KeyType: 'RANGE' },
    ]);
    assert.equal(Table?.BillingModeSummary?.BillingMode, 'PAY_PER_REQUEST');
  });

  it('has the frontend in the site bucket', async () => {
    const { Contents } = await s3.send(new ListObjectsV2Command({ Bucket: outputs.SiteBucketName }));
    const keys = (Contents ?? []).map((object) => object.Key);
    for (const key of ['index.html', 'app.js', 'styles.css', 'config.json']) {
      assert.ok(keys.includes(key), `missing ${key} in the site bucket`);
    }
  });

  it('serves the site', async () => {
    const page = await fetch(gateway.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /<vendor-app>/);

    const script = await fetch(`${gateway.url}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /javascript/);
  });

  it('serves index.html for unknown paths, like the CloudFront error response', async () => {
    const page = await fetch(`${gateway.url}/some/client/route`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<vendor-app>/);
  });

  it('serves the runtime config for this deployment', async () => {
    const config = (await (await fetch(`${gateway.url}/config.json`)).json()) as Record<string, string>;
    assert.equal(config.userPoolId, outputs.UserPoolId);
    assert.equal(config.userPoolClientId, outputs.UserPoolClientId);
    assert.equal(config.apiUrl, '/api');
  });

  it('serves the site from the private bucket through CloudFront (origin access control)', async () => {
    // The emulator's CloudFront ignores DefaultRootObject, so ask for the file.
    const page = await send({ url: distributionUrl(outputs, '/index.html') });
    assert.equal(page.status, 200);
    assert.match(page.body, /<vendor-app>/);
  });

  for (const method of ['GET', 'POST', 'DELETE']) {
    it(`rejects ${method} /api/vendors without a token`, async () => {
      const response = await fetch(`${gateway.url}/api/vendors`, { method });
      assert.equal(response.status, 401);
    });
  }

  it('rejects a forged token', async () => {
    const forged = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.`;
    const response = await fetch(`${gateway.url}/api/vendors`, { headers: { Authorization: forged } });
    assert.equal(response.status, 401);
  });

  it('blocks a signed-in request that skips CloudFront (no origin secret)', async () => {
    const email = await createUser(cognito, outputs, 'direct');
    try {
      const api = new URL(outputs.ApiEndpoint);
      const response = await send({
        host: api.host,
        path: `${api.pathname}api/vendors`,
        headers: { Authorization: await idTokenFor(cognito, outputs, email) },
      });
      assert.equal(response.status, 403);
      assert.match(response.body, /Forbidden/, 'blocked by the WAF web ACL, before the authorizer');
    } finally {
      await deleteUser(cognito, outputs, email);
    }
  });

  it('lets CloudFront through to the API (it adds the origin secret)', async () => {
    // No token, so the Cognito authorizer answers 401; a WAF block would be 403.
    const response = await send({ url: distributionUrl(outputs, '/api/vendors') });
    assert.equal(response.status, 401);
  });

  /** Calls /api/vendors through the gateway with the user's ID token. */
  const caller = (token: string) => (method: string, body?: unknown) =>
    fetch(`${gateway.url}/api/vendors`, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  it('creates, lists and deletes a vendor for a signed-in user', async () => {
    const email = await createUser(cognito, outputs, 'smoke');
    try {
      const call = caller(await idTokenFor(cognito, outputs, email));
      const name = `Smoke ${email}`;

      const created = await call('POST', { name, category: 'Smoke', contactEmail: email });
      assert.equal(created.status, 201);
      assert.equal(created.headers.get('access-control-allow-origin'), null, 'same-origin: no CORS headers');
      const { vendorId } = (await created.json()) as { vendorId: string };

      const listed = await call('GET');
      assert.equal(listed.status, 200);
      const vendors = (await listed.json()) as { vendorId: string; name: string }[];
      assert.equal(vendors.find((vendor) => vendor.vendorId === vendorId)?.name, name);

      const invalid = await call('POST', { name });
      assert.equal(invalid.status, 400);

      const deleted = await call('DELETE', { vendorId });
      assert.equal(deleted.status, 200);
      const remaining = (await (await call('GET')).json()) as { vendorId: string }[];
      assert.ok(!remaining.some((vendor) => vendor.vendorId === vendorId));
    } finally {
      await deleteUser(cognito, outputs, email);
    }
  });

  it("shows each user only their own vendors, and won't delete another user's", async () => {
    const alice = await createUser(cognito, outputs, 'alice');
    const bob = await createUser(cognito, outputs, 'bob');
    try {
      const asAlice = caller(await idTokenFor(cognito, outputs, alice));
      const asBob = caller(await idTokenFor(cognito, outputs, bob));
      const created = await asAlice('POST', { name: `Alice's vendor`, category: 'Private', contactEmail: alice });
      const { vendorId } = (await created.json()) as { vendorId: string };

      const bobsList = (await (await asBob('GET')).json()) as { vendorId: string }[];
      assert.deepEqual(bobsList, [], "Bob sees none of Alice's vendors");

      assert.equal((await asBob('DELETE', { vendorId })).status, 200, 'answers like a delete of a missing vendor');
      const alicesList = (await (await asAlice('GET')).json()) as { vendorId: string; name: string }[];
      assert.deepEqual(alicesList.map((vendor) => vendor.vendorId), [vendorId], "Bob's delete did nothing");
      assert.ok(!('ownerId' in alicesList[0]!), 'the owner is not returned');

      await asAlice('DELETE', { vendorId });
    } finally {
      await deleteUser(cognito, outputs, alice);
      await deleteUser(cognito, outputs, bob);
    }
  });
});
