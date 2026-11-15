// CDK tests: cdk-nag's AWS Solutions rules against every stack, as
// infra/app.ts runs them on each synth. A finding must be fixed or
// acknowledged next to its resource with a reason; this lists any that is not.
//
// It also writes reports/cdk-nag.json, every stack's leftover and acknowledged
// findings with their reasons, which scripts/ci-report.ts puts in the job summary.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { after, describe, it } from 'node:test';
import { Validations } from 'aws-cdk-lib';
import type { App, Stack } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { GitHubDeployStack } from '../../infra/github-deploy-stack.ts';
import { STAGES, VendorStack, stageSettings } from '../../infra/vendor-stack.ts';
import type { VendorStackProps } from '../../infra/vendor-stack.ts';
import { quietly, testApp } from './app.ts';

interface Violation {
  rule: string;
  severity: string;
  paths: string[];
}

interface Acknowledged {
  rule: string;
  path: string;
  reason: string;
}

/** What each stack's run found, for reports/cdk-nag.json. */
const results: { stack: string; violations: Violation[]; acknowledged: Acknowledged[] }[] = [];

/**
 * Synthesizes `build`'s stacks with cdk-nag and returns the findings left
 * over. The acknowledgements are recorded too, once each, at the construct
 * they were made on (CDK keeps them there as metadata).
 */
const findings = (build: (app: App) => Stack[], { record = true, quiet = false } = {}): Violation[] => {
  const outdir = mkdtempSync(join(tmpdir(), 'vendor-nag-'));
  const app = testApp({ outdir });
  const stacks = build(app);
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
  const synth = () => {
    try {
      app.synth();
    } catch (error) {
      if (!existsSync(join(outdir, 'validation-report.json'))) throw error;
    }
  };
  // cdk-nag prints its findings during synth; `quiet` keeps expected ones out of the log.
  if (quiet) quietly(synth);
  else synth();
  const report = join(outdir, 'validation-report.json');
  const violations: Violation[] = [];
  if (existsSync(report)) {
    const { pluginReports } = JSON.parse(readFileSync(report, 'utf8')) as {
      pluginReports: { violations: { ruleName: string; severity: string; violatingConstructs: { constructPath: string }[] }[] }[];
    };
    violations.push(
      ...pluginReports.flatMap((plugin) =>
        plugin.violations.map((v) => ({ rule: v.ruleName, severity: v.severity, paths: v.violatingConstructs.map((c) => c.constructPath) })),
      ),
    );
  }
  if (record) {
    for (const stack of stacks) {
      const acknowledged: Acknowledged[] = [];
      for (const construct of stack.node.findAll()) {
        for (const entry of construct.node.metadata) {
          if (entry.type !== Validations.ACKNOWLEDGED_RULES_METADATA_KEY) continue;
          // { "Annotation::<rule id>": "<reason>", ... }
          for (const [key, reason] of Object.entries(entry.data as Record<string, string>)) {
            acknowledged.push({
              rule: key.replace(/^(?:Annotation|AwsSolutions)::/, ''),
              path: construct.node.path.slice(stack.node.path.length + 1) || '(stack)',
              reason,
            });
          }
        }
      }
      results.push({
        stack: stack.stackName,
        violations: violations.filter((v) => v.paths.some((path) => path.startsWith(`${stack.node.path}/`))),
        acknowledged,
      });
    }
  }
  return violations;
};

after(() => {
  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(join(REPORTS, 'cdk-nag.json'), `${JSON.stringify({ pack: 'AwsSolutions', stacks: results }, null, 2)}\n`);
});

const frontendDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-frontend-'));
  writeFileSync(join(dir, 'index.html'), '<vendor-app></vendor-app>');
  return dir;
};

const require = createRequire(import.meta.url);
const REPORTS = fileURLToPath(new URL('../../reports/', import.meta.url));
const env = { account: '111111111111', region: 'us-east-1' };
const stages: [string, VendorStackProps][] = [
  ...STAGES.map((stage): [string, VendorStackProps] => [stage, stageSettings(stage)]),
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

  it('pass for a prod VendorStack on a custom domain (TLS 1.2, so CFR4 needs no acknowledgement)', () => {
    const violations = findings((app) => [
      new VendorStack(app, 'VendorStack-proddomain', {
        frontendDir: frontendDir(),
        env,
        ...stageSettings('prod'),
        domain: { domainName: 'vendors.example.com', hostedZone: { id: 'Z0123456789ABC', name: 'example.com' } },
      }),
    ]);
    assertClean(violations);
    const recorded = results.find((r) => r.stack === 'VendorStack-proddomain')!;
    assert.ok(!recorded.acknowledged.some((a) => a.rule === 'AwsSolutions-CFR4'), 'CFR4 should pass, not be acknowledged');
  });

  it('pass for the GitHub deploy roles', () => {
    assertClean(
      findings((app) => [new GitHubDeployStack(app, 'VendorTrackerGitHubDeploy', { repository: 'octo/vendors', environments: ['dev', 'test', 'uat', 'prod'], env })]),
    );
  });

  it('catch a new finding that nobody acknowledged', (t) => {
    // A guard on the guard: the checks are live, not silently passing. The
    // canary's findings are expected, so they are kept out of the log.
    const violations = findings(
      (app) => {
        const stack = new VendorStack(app, 'VendorStack-canary', { frontendDir: frontendDir(), env, stage: 'dev' });
        new (require('aws-cdk-lib').aws_s3.Bucket)(stack, 'Unprotected');
        return [stack];
      },
      { record: false, quiet: true },
    );
    const rules = [...new Set(violations.map((v) => v.rule))].sort();
    assert.ok(rules.includes('AwsSolutions-S10'), `expected S10 (no SSL enforcement), got ${rules.join(', ')}`);
    t.diagnostic(`canary: cdk-nag caught ${rules.join(' and ')} on an unprotected bucket, as expected (output hidden)`);
  });
});
