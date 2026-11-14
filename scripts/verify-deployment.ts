// Post-deploy check of a deployed VendorStack, run by the deploy workflow
// after each `cdk deploy` (and runnable against AWS Emulator). It creates
// nothing and needs only cloudformation:DescribeStacks:
//
//   - the site loads through CloudFront, with a config.json for this stack
//   - /api/* through CloudFront reaches API Gateway: a request without a
//     token gets the Cognito authorizer's 401, not the WAF block (403)
//   - calling execute-api directly, skipping CloudFront, is blocked by WAF
//
//   STACK_NAME=VendorStack-dev node scripts/verify-deployment.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const stackName = process.env.STACK_NAME ?? 'VendorStack';

// Against AWS Emulator, every AWS hostname is served on its one endpoint and
// a CloudFront distribution gets a 127.0.0.1 port; the certificate is for localhost.
const emulator = process.env.AWS_ENDPOINT_URL ? new URL(process.env.AWS_ENDPOINT_URL) : undefined;
const local = (host: string) => host === '127.0.0.1' || host === 'localhost';

const get = (target: string): Promise<{ status: number; body: string }> => {
  const url = new URL(target);
  const viaEmulator = emulator && local(emulator.hostname) && !local(url.hostname);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: viaEmulator ? emulator.hostname : url.hostname,
        port: viaEmulator ? emulator.port : url.port || 443,
        path: url.pathname + url.search,
        headers: { host: url.host },
        ...((viaEmulator || local(url.hostname)) && {
          servername: 'localhost',
          ...(process.env.AWS_CA_BUNDLE && { ca: readFileSync(process.env.AWS_CA_BUNDLE) }),
        }),
        timeout: 15_000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out: ${target}`)));
    req.on('error', reject);
    req.end();
  });
};

const cloudformation = new CloudFormationClient({});
const { Stacks } = await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }));
cloudformation.destroy();
const outputs = Object.fromEntries((Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue])) as Record<string, string>;
// The emulator gives each distribution its own random port (CloudFrontURL),
// which a container runtime does not publish; it also serves every
// distribution on its main port under /_aws/cloudfront/<id>/.
const onEmulator = Boolean(emulator && local(emulator.hostname));
const site = onEmulator
  ? `${emulator!.origin}/_aws/cloudfront/${outputs.DistributionId}`
  : outputs.CloudFrontURL!.replace(/\/+$/, '');
const api = outputs.ApiEndpoint!;

const checks: [string, () => Promise<void>][] = [
  [
    'the site loads through CloudFront',
    async () => {
      // AWS Emulator ignores DefaultRootObject (aws/aws-emulator#160), so ask it for the file.
      const page = await get(`${site}${onEmulator ? '/index.html' : '/'}`);
      assert.equal(page.status, 200);
      assert.match(page.body, /<vendor-app>/);
    },
  ],
  [
    'config.json describes this stack',
    async () => {
      const config = JSON.parse((await get(`${site}/config.json`)).body) as Record<string, string>;
      assert.equal(config.apiUrl, '/api');
      assert.equal(config.userPoolId, outputs.UserPoolId);
      assert.equal(config.userPoolClientId, outputs.UserPoolClientId);
    },
  ],
  [
    'CloudFront gets through to the API (the authorizer answers, not WAF)',
    async () => {
      const response = await get(`${site}/api/vendors`);
      assert.equal(response.status, 401);
    },
  ],
  [
    'calling the API directly is blocked by WAF',
    async () => {
      const response = await get(new URL('api/vendors', api).href);
      assert.equal(response.status, 403);
      assert.match(response.body, /Forbidden/);
    },
  ],
];

let failed = 0;
console.log(`Verifying ${stackName} (${site})`);
for (const [name, check] of checks) {
  try {
    await check();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
  }
}
if (failed) {
  console.error(`${failed} of ${checks.length} checks failed`);
  process.exit(1);
}
