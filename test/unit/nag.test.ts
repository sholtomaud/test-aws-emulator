// Unit tests: cdk-nag's AWS Solutions rules against every stack, as
// infra/app.ts runs them on each synth. A finding must be fixed or
// acknowledged next to its resource with a reason; this lists any that is not.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { App, Validations } from 'aws-cdk-lib';
import type { Stack } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { GitHubDeployStack } from '../../infra/github-deploy-stack.ts';
import { VendorStack } from '../../infra/vendor-stack.ts';
import type { VendorStackProps } from '../../infra/vendor-stack.ts';

interface Violation {
  rule: string;
  severity: string;
  paths: string[];
}

/** Synthesizes `build`'s stacks with cdk-nag and returns the findings left over. */
const findings = (build: (app: App) => Stack[]): Violation[] => {
  const outdir = mkdtempSync(join(tmpdir(), 'vendor-nag-'));
  const app = new App({ outdir });
  build(app);
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  try {
    app.synth();
  } catch (error) {
    if (!existsSync(join(outdir, 'validation-report.json'))) throw error;
  }
  const report = join(outdir, 'validation-report.json');
  if (!existsSync(report)) return [];
  const { pluginReports } = JSON.parse(readFileSync(report, 'utf8')) as {
    pluginReports: { violations: { ruleName: string; severity: string; violatingConstructs: { constructPath: string }[] }[] }[];
  };
  return pluginReports.flatMap((plugin) =>
    plugin.violations.map((v) => ({ rule: v.ruleName, severity: v.severity, paths: v.violatingConstructs.map((c) => c.constructPath) })),
  );
};

const frontendDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-frontend-'));
  writeFileSync(join(dir, 'index.html'), '<vendor-app></vendor-app>');
  return dir;
};

const require = createRequire(import.meta.url);
const env = { account: '111111111111', region: 'us-east-1' };
const stages: [string, VendorStackProps][] = [
  ['dev', { stage: 'dev' }],
  ['test', { stage: 'test' }],
  ['uat', { stage: 'uat' }],
  ['prod', { stage: 'prod', retainData: true }],
  ['AWS Emulator', { emulator: true }],
];

const assertClean = (violations: Violation[]) =>
  assert.deepEqual(
    violations.map((v) => `${v.severity} ${v.rule} at ${v.paths.join(', ')}`),
    [],
    'fix these, or acknowledge them next to the resource with a reason',
  );

describe('cdk-nag AWS Solutions checks', () => {
  for (const [name, props] of stages) {
    it(`pass for the ${name} VendorStack`, () => {
      assertClean(
        findings((app) => [new VendorStack(app, `VendorStack-${name.replace(/\W/g, '')}`, { frontendDir: frontendDir(), env, ...props })]),
      );
    });
  }

  it('pass for the GitHub deploy roles', () => {
    assertClean(
      findings((app) => [new GitHubDeployStack(app, 'Deploy', { repository: 'octo/vendors', environments: ['dev', 'test', 'uat', 'prod'], env })]),
    );
  });

  it('catch a new finding that nobody acknowledged', () => {
    // A guard on the guard: the checks are live, not silently passing.
    const violations = findings((app) => {
      const stack = new VendorStack(app, 'VendorStack-canary', { frontendDir: frontendDir(), env, stage: 'dev' });
      new (require('aws-cdk-lib').aws_s3.Bucket)(stack, 'Unprotected');
      return [stack];
    });
    const rules = violations.map((v) => v.rule);
    assert.ok(rules.includes('AwsSolutions-S10'), `expected S10 (no SSL enforcement), got ${rules.join(', ')}`);
  });
});
