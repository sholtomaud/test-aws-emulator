// Smoke tests: is the stack that `make deploy` put into AWS Emulator alive and
// wired together? Quick checks of each deployed piece plus one authenticated
// round trip through API Gateway -> Lambda -> DynamoDB.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { stackOutputs } from '../../scripts/lib/emulator.ts';
import type { StackOutputs } from '../../scripts/lib/emulator.ts';
import { startGateway } from '../../scripts/local-gateway.ts';
import type { Gateway } from '../../scripts/local-gateway.ts';
import { createUser, deleteUser, idTokenFor } from '../helpers/users.ts';

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
    for (const key of ['ApiEndpoint', 'UserPoolId', 'UserPoolClientId', 'TableName', 'SiteBucketName', 'CloudFrontURL'] as const) {
      assert.ok(outputs[key], `missing output ${key}`);
    }
    assert.match(outputs.ApiEndpoint, /^https:\/\/[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com\/prod\/$/);
  });

  it('has an active vendor table keyed by vendorId', async () => {
    const { Table } = await dynamodb.send(new DescribeTableCommand({ TableName: outputs.TableName }));
    assert.equal(Table?.TableStatus, 'ACTIVE');
    assert.deepEqual(Table?.KeySchema, [{ AttributeName: 'vendorId', KeyType: 'HASH' }]);
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
  });

  for (const method of ['GET', 'POST', 'DELETE']) {
    it(`rejects ${method} /vendors without a token`, async () => {
      const response = await fetch(`${gateway.url}/api/vendors`, { method });
      assert.equal(response.status, 401);
    });
  }

  it('rejects a forged token', async () => {
    const forged = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.`;
    const response = await fetch(`${gateway.url}/api/vendors`, { headers: { Authorization: forged } });
    assert.equal(response.status, 401);
  });

  it('creates, lists and deletes a vendor for a signed-in user', async () => {
    const email = await createUser(cognito, outputs, 'smoke');
    try {
      const headers = { Authorization: await idTokenFor(cognito, outputs, email), 'Content-Type': 'application/json' };
      const url = `${gateway.url}/api/vendors`;
      const name = `Smoke ${email}`;

      const created = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, category: 'Smoke', contactEmail: email }),
      });
      assert.equal(created.status, 201);
      assert.equal(created.headers.get('access-control-allow-origin'), '*');
      const { vendorId } = (await created.json()) as { vendorId: string };

      const listed = await fetch(url, { headers });
      assert.equal(listed.status, 200);
      const vendors = (await listed.json()) as { vendorId: string; name: string }[];
      assert.equal(vendors.find((vendor) => vendor.vendorId === vendorId)?.name, name);

      const invalid = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ name }) });
      assert.equal(invalid.status, 400);

      const deleted = await fetch(url, { method: 'DELETE', headers, body: JSON.stringify({ vendorId }) });
      assert.equal(deleted.status, 200);
      const remaining = (await (await fetch(url, { headers })).json()) as { vendorId: string }[];
      assert.ok(!remaining.some((vendor) => vendor.vendorId === vendorId));
    } finally {
      await deleteUser(cognito, outputs, email);
    }
  });
});
