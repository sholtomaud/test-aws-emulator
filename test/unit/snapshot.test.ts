// Unit tests: snapshots of each stage's synthesized CloudFormation template.
// Any change to the infrastructure (a property, a policy, a new resource)
// fails here until it is accepted, so it shows up in review as a diff of
// test/unit/__snapshots__/. Accept intended changes with `make snapshots`.
//
// Content hashes (Lambda bundles, the frontend asset) are replaced with a
// placeholder: code changes are covered by the other suites, and would
// otherwise churn every snapshot.
//
// Also checks that every stage synthesizes without CDK warnings or errors.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { GitHubDeployStack } from '../../infra/github-deploy-stack.ts';
import { VendorStack } from '../../infra/vendor-stack.ts';
import type { VendorStackProps } from '../../infra/vendor-stack.ts';

const SNAPSHOTS = fileURLToPath(new URL('./__snapshots__/', import.meta.url));
const update = process.env.UPDATE_SNAPSHOTS === '1';
const env = { account: '111111111111', region: 'us-east-1' };

/** The template as JSON, with content hashes replaced so only infrastructure changes show. */
const normalize = (template: unknown): string =>
  `${JSON.stringify(template, null, 2)
    .replace(/\b[0-9a-f]{64}\b/g, '<asset-hash>')
    .replace(/"aws:asset:path": "[^"]*"/g, '"aws:asset:path": "<asset-path>"')}\n`;

const matchSnapshot = (name: string, actual: string) => {
  const file = join(SNAPSHOTS, `${name}.json`);
  if (update || (!existsSync(file) && !process.env.CI)) {
    mkdirSync(SNAPSHOTS, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.ok(existsSync(file), `no snapshot for ${name}: run \`make snapshots\` and commit test/unit/__snapshots__/${name}.json`);
  // Compare line by line so a failure shows the changed lines, not the whole template.
  assert.deepEqual(
    actual.split('\n'),
    readFileSync(file, 'utf8').split('\n'),
    `the ${name} template changed: review the diff, and if it is intended run \`make snapshots\` and commit the result`,
  );
};

const frontendDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-frontend-'));
  writeFileSync(join(dir, 'index.html'), '<vendor-app></vendor-app>');
  return dir;
};

const stages: [string, VendorStackProps][] = [
  ['dev', { stage: 'dev' }],
  ['test', { stage: 'test' }],
  ['uat', { stage: 'uat' }],
  ['prod', { stage: 'prod', retainData: true }],
  ['emulator', { emulator: true }],
];

describe('template snapshots', () => {
  for (const [name, props] of stages) {
    it(`VendorStack ${name}`, () => {
      const app = new App({ outdir: mkdtempSync(join(tmpdir(), 'vendor-cdk-')) });
      const stack = new VendorStack(app, name === 'emulator' ? 'VendorStack' : `VendorStack-${name}`, {
        frontendDir: frontendDir(),
        env,
        ...props,
      });
      const template = Template.fromStack(stack);
      const annotations = Annotations.fromStack(stack);
      assert.deepEqual(annotations.findError('*', Match.anyValue()), [], 'CDK reported errors');
      assert.deepEqual(annotations.findWarning('*', Match.anyValue()), [], 'CDK reported warnings');
      matchSnapshot(`VendorStack-${name}`, normalize(template.toJSON()));
    });
  }

  it('GitHub deploy roles', () => {
    const stack = new GitHubDeployStack(new App(), 'VendorTrackerGitHubDeploy', {
      repository: 'owner/vendor-tracker',
      environments: ['dev', 'test', 'uat', 'prod'],
      env,
    });
    assert.deepEqual(Annotations.fromStack(stack).findWarning('*', Match.anyValue()), [], 'CDK reported warnings');
    matchSnapshot('GitHubDeployStack', normalize(Template.fromStack(stack).toJSON()));
  });

  it('give dev, test and uat the same resources, and prod the same plus retention', () => {
    const resources = (name: string) => {
      const { Resources } = JSON.parse(readFileSync(join(SNAPSHOTS, `VendorStack-${name}.json`), 'utf8')) as {
        Resources: Record<string, { Type: string; DeletionPolicy?: string }>;
      };
      return Object.values(Resources);
    };
    const types = (name: string) =>
      resources(name)
        .map((resource) => resource.Type)
        .sort();
    for (const stage of ['test', 'uat']) assert.deepEqual(types(stage), types('dev'), `${stage} has different resources from dev`);
    // prod only drops the S3 auto-delete custom resource (it keeps its bucket).
    const prod = types('prod');
    const dev = types('dev').filter((type) => !['Custom::S3AutoDeleteObjects', 'AWS::S3::BucketPolicy', 'AWS::IAM::Role', 'AWS::Lambda::Function'].includes(type));
    for (const type of new Set(dev)) assert.ok(prod.includes(type), `prod lacks ${type}`);
    assert.ok(!prod.includes('Custom::S3AutoDeleteObjects'));
    const retained = resources('prod').filter((resource) => resource.DeletionPolicy === 'Retain').map((resource) => resource.Type);
    for (const type of ['AWS::DynamoDB::Table', 'AWS::Cognito::UserPool', 'AWS::S3::Bucket', 'AWS::Logs::LogGroup']) {
      assert.ok(retained.includes(type), `prod does not retain its ${type}`);
    }
    // Outside prod nothing is kept, except what CDK keeps on purpose in every
    // stage: API Gateway's account-wide CloudWatch role and setting, which
    // other APIs in the account may rely on.
    const accountWide = ['AWS::ApiGateway::Account', 'AWS::IAM::Role'];
    const devRetained = resources('dev').filter((resource) => resource.DeletionPolicy === 'Retain').map((resource) => resource.Type);
    assert.deepEqual(devRetained.filter((type) => !accountWide.includes(type)), [], 'dev retains data');
  });
});
