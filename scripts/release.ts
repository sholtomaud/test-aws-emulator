// Release steps the deploy workflow runs around a prepared CloudFormation
// change set (`cdk deploy --method=prepare-change-set`):
//
//   check    describes the change set, writes it to the job summary, and fails
//            if it would replace or delete a resource that holds data (the
//            vendor table, the user pool) where data is protected (uat, prod),
//            unless ALLOW_DATA_REPLACEMENT=true
//   execute  executes the change set and waits for the stack to settle. With
//            ALLOW_DATA_REPLACEMENT=true it first lifts the stack policy, which
//            would refuse the replacement; `protect` sets it again afterwards
//   protect  sets a stack policy that denies replacing or deleting those
//            resources, for any later update, from any tool (prod)
//
// Environment: STACK_NAME, CHANGE_SET_NAME, PROTECT_DATA, ALLOW_DATA_REPLACEMENT.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CloudFormationClient,
  DescribeChangeSetCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  SetStackPolicyCommand,
} from '@aws-sdk/client-cloudformation';
import type { Change } from '@aws-sdk/client-cloudformation';

/** Resource types that hold data a replacement or deletion would lose. */
export const STATEFUL_TYPES = ['AWS::DynamoDB::Table', 'AWS::Cognito::UserPool'];

export interface Finding {
  logicalId: string;
  type: string;
  action: string;
  /** True, Conditional or False, as CloudFormation reports it. */
  replacement: string;
}

/**
 * The changes that would lose data: a removal, or a replacement that is
 * certain or conditional (CloudFormation cannot always tell before running).
 */
export const dataLosingChanges = (changes: Change[]): Finding[] =>
  changes
    .map((change) => change.ResourceChange)
    .filter((rc) => rc !== undefined)
    .filter((rc) => STATEFUL_TYPES.includes(rc.ResourceType ?? ''))
    .filter((rc) => rc.Action === 'Remove' || (rc.Action === 'Modify' && (rc.Replacement === 'True' || rc.Replacement === 'Conditional')))
    .map((rc) => ({
      logicalId: rc.LogicalResourceId ?? '?',
      type: rc.ResourceType ?? '?',
      action: rc.Action ?? '?',
      replacement: rc.Replacement ?? '',
    }));

/** The stack policy `protect` sets: every update allowed, except losing data. */
/** The policy that lifts the protection for one deliberate release. */
export const ALLOW_ALL_POLICY = { Statement: [{ Effect: 'Allow', Action: 'Update:*', Principal: '*', Resource: '*' }] };

export const STACK_POLICY = {
  Statement: [
    { Effect: 'Allow', Action: 'Update:*', Principal: '*', Resource: '*' },
    {
      Effect: 'Deny',
      Action: ['Update:Replace', 'Update:Delete'],
      Principal: '*',
      Resource: '*',
      Condition: { StringEquals: { ResourceType: STATEFUL_TYPES } },
    },
  ],
};

/** Markdown for the job summary. */
export const summarize = (stack: string, changes: Change[], findings: Finding[], blocked: boolean): string => {
  const lines = [`## ${stack}: ${changes.length} change${changes.length === 1 ? '' : 's'}`, ''];
  if (changes.length > 0) {
    lines.push('| Action | Resource | Type | Replacement |', '| --- | --- | --- | --- |');
    for (const { ResourceChange: rc } of changes) {
      if (!rc) continue;
      const risky = findings.some((f) => f.logicalId === rc.LogicalResourceId);
      lines.push(`| ${risky ? '⚠️ ' : ''}${rc.Action} | ${rc.LogicalResourceId} | ${rc.ResourceType} | ${rc.Replacement ?? ''} |`);
    }
    lines.push('');
  }
  if (findings.length > 0) {
    lines.push(
      blocked
        ? `❌ **Blocked**: this would ${findings.map((f) => `${f.action === 'Remove' ? 'delete' : 'replace'} ${f.logicalId} (${f.type})`).join(', ')}, losing its data. Run the workflow by hand with "allow data replacement" only if that is intended and the data is migrated or backed up.`
        : `⚠️ This replaces or deletes a data resource (${findings.map((f) => f.logicalId).join(', ')}); allowed here.`,
      '',
    );
  }
  return lines.join('\n');
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

/** All changes of a change set (it is paged), or undefined if CDK found nothing to change and made none. */
const describeChanges = async (cloudformation: CloudFormationClient, StackName: string, ChangeSetName: string) => {
  const changes: Change[] = [];
  let NextToken: string | undefined;
  do {
    try {
      const page = await cloudformation.send(new DescribeChangeSetCommand({ StackName, ChangeSetName, NextToken }));
      if (page.Status === 'FAILED' && /didn't contain changes|No updates/i.test(page.StatusReason ?? '')) return [];
      if (page.Status !== 'CREATE_COMPLETE') throw new Error(`change set ${ChangeSetName} is ${page.Status}: ${page.StatusReason ?? ''}`);
      changes.push(...(page.Changes ?? []));
      NextToken = page.NextToken;
    } catch (error) {
      if ((error as Error).name === 'ChangeSetNotFoundException' || (error as Error).name === 'ChangeSetNotFound') return undefined;
      throw error;
    }
  } while (NextToken);
  return changes;
};

const main = async (command: string | undefined) => {
  const cloudformation = new CloudFormationClient({});
  const StackName = env('STACK_NAME');
  const summary = (text: string) => {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    console.log(text);
  };
  try {
    if (command === 'check') {
      const changes = await describeChanges(cloudformation, StackName, env('CHANGE_SET_NAME'));
      if (changes === undefined || changes.length === 0) return summary(`## ${StackName}: no changes`);
      const findings = dataLosingChanges(changes);
      const blocked = findings.length > 0 && process.env.PROTECT_DATA === 'true' && process.env.ALLOW_DATA_REPLACEMENT !== 'true';
      summary(summarize(StackName, changes, findings, blocked));
      if (blocked) process.exitCode = 1;
    } else if (command === 'execute') {
      const ChangeSetName = env('CHANGE_SET_NAME');
      const changes = await describeChanges(cloudformation, StackName, ChangeSetName);
      if (changes === undefined || changes.length === 0) return console.log('Nothing to execute: no changes.');
      if (process.env.ALLOW_DATA_REPLACEMENT === 'true') {
        // A stack policy cannot be overridden for a change set execution, so
        // it is lifted for this one; the workflow's `protect` step restores it.
        await cloudformation.send(new SetStackPolicyCommand({ StackName, StackPolicyBody: JSON.stringify(ALLOW_ALL_POLICY) }));
        console.log(`${StackName}: stack policy lifted for this release (ALLOW_DATA_REPLACEMENT)`);
      }
      await cloudformation.send(new ExecuteChangeSetCommand({ StackName, ChangeSetName }));
      // A gradual Lambda release keeps the stack updating while CodeDeploy
      // shifts traffic, so this can take several minutes.
      for (;;) {
        await sleep(10_000);
        const status = (await cloudformation.send(new DescribeStacksCommand({ StackName }))).Stacks?.[0]?.StackStatus ?? 'UNKNOWN';
        if (status.endsWith('_IN_PROGRESS')) continue;
        console.log(`${StackName}: ${status}`);
        if (status !== 'CREATE_COMPLETE' && status !== 'UPDATE_COMPLETE') process.exitCode = 1;
        return;
      }
    } else if (command === 'protect') {
      await cloudformation.send(new SetStackPolicyCommand({ StackName, StackPolicyBody: JSON.stringify(STACK_POLICY) }));
      console.log(`${StackName}: stack policy set (no replacing or deleting ${STATEFUL_TYPES.join(', ')})`);
    } else {
      throw new Error('usage: node scripts/release.ts check|execute|protect');
    }
  } finally {
    cloudformation.destroy();
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv[2]);
