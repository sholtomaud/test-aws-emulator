// Functional tests: scripts/release.ts against CloudFormation in AWS Emulator,
// as the deploy workflow runs it: check, execute and protect around a
// prepared change set. Needs a running emulator (`make emulator-up`).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  GetStackPolicyCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { emulatorEndpoint } from '../../scripts/lib/emulator.ts';
import { ALLOW_ALL_POLICY, STACK_POLICY } from '../../scripts/release.ts';

const run = promisify(execFile);
const release = (command: string, extra: Record<string, string> = {}) =>
  run(process.execPath, ['scripts/release.ts', command], { env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...extra } });

const template = (queues: string[]) =>
  JSON.stringify({ Resources: Object.fromEntries(queues.map((name) => [name, { Type: 'AWS::SQS::Queue' }])) });

describe('scripts/release.ts against emulated CloudFormation', () => {
  emulatorEndpoint();
  const cloudformation = new CloudFormationClient({});
  const StackName = `release-${randomUUID().slice(0, 8)}`;
  const settle = async () => {
    for (let i = 0; i < 60; i++) {
      const status = (await cloudformation.send(new DescribeStacksCommand({ StackName }))).Stacks?.[0]?.StackStatus ?? '';
      if (!status.endsWith('_IN_PROGRESS')) return status;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('stack did not settle');
  };

  before(async () => {
    await cloudformation.send(new CreateStackCommand({ StackName, TemplateBody: template(['First']) }));
    assert.equal(await settle(), 'CREATE_COMPLETE');
  });

  after(async () => {
    await cloudformation.send(new DeleteStackCommand({ StackName }));
    cloudformation.destroy();
  });

  it('reports a stack with no change set as having no changes', async () => {
    const { stdout } = await release('check', { STACK_NAME: StackName, CHANGE_SET_NAME: 'never-created', PROTECT_DATA: 'true' });
    assert.match(stdout, /no changes/);
  });

  it('checks a prepared change set, then executes it', async () => {
    const ChangeSetName = 'release-1';
    await cloudformation.send(new CreateChangeSetCommand({ StackName, ChangeSetName, TemplateBody: template(['First', 'Second']) }));
    for (let i = 0; i < 60; i++) {
      const { Status } = await cloudformation.send(new DescribeChangeSetCommand({ StackName, ChangeSetName }));
      if (Status === 'CREATE_COMPLETE') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const env = { STACK_NAME: StackName, CHANGE_SET_NAME: ChangeSetName, PROTECT_DATA: 'true' };

    const { stdout } = await release('check', env);
    assert.match(stdout, /1 change/);
    assert.match(stdout, /\| Add \| Second \| AWS::SQS::Queue \|/);

    await release('execute', env);
    assert.equal(await settle(), 'UPDATE_COMPLETE');
    const { StackResourceSummaries = [] } = await cloudformation.send(new ListStackResourcesCommand({ StackName }));
    assert.deepEqual(StackResourceSummaries.map((r) => r.LogicalResourceId).sort(), ['First', 'Second']);
  });

  it('protects the stack with the stack policy', async () => {
    await release('protect', { STACK_NAME: StackName });
    const { StackPolicyBody } = await cloudformation.send(new GetStackPolicyCommand({ StackName }));
    assert.deepEqual(JSON.parse(StackPolicyBody ?? '{}'), STACK_POLICY);
  });

  it('lifts the policy for a deliberate replacement, and protect restores it', async () => {
    const ChangeSetName = 'release-2';
    const policy = async () => JSON.parse((await cloudformation.send(new GetStackPolicyCommand({ StackName }))).StackPolicyBody ?? '{}');
    await cloudformation.send(new CreateChangeSetCommand({ StackName, ChangeSetName, TemplateBody: template(['First', 'Second', 'Third']) }));
    for (let i = 0; i < 60; i++) {
      if ((await cloudformation.send(new DescribeChangeSetCommand({ StackName, ChangeSetName }))).Status === 'CREATE_COMPLETE') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const { stdout } = await release('execute', { STACK_NAME: StackName, CHANGE_SET_NAME: ChangeSetName, ALLOW_DATA_REPLACEMENT: 'true' });
    assert.match(stdout, /stack policy lifted/);
    assert.equal(await settle(), 'UPDATE_COMPLETE');
    assert.deepEqual(await policy(), ALLOW_ALL_POLICY);
    await release('protect', { STACK_NAME: StackName });
    assert.deepEqual(await policy(), STACK_POLICY);
  });
});
