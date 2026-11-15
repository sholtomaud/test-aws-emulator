// Unit tests: the release guard's decisions (scripts/release.ts), on change
// sets shaped as CloudFormation describes them. AWS Emulator reports every
// replacement as "False", so the decisions are tested here, not there.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Change } from '@aws-sdk/client-cloudformation';
import { STACK_POLICY, STATEFUL_TYPES, dataLosingChanges, summarize } from '../../scripts/release.ts';

const change = (LogicalResourceId: string, ResourceType: string, Action: string, Replacement?: string): Change =>
  ({ Type: 'Resource', ResourceChange: { Action, LogicalResourceId, ResourceType, ...(Replacement && { Replacement }) } }) as Change;

describe('dataLosingChanges', () => {
  for (const [label, rc] of [
    ['replacing the table', change('VendorTable00B5A738', 'AWS::DynamoDB::Table', 'Modify', 'True')],
    ['a conditional replacement of the user pool', change('VendorUserPool97FFFE54', 'AWS::Cognito::UserPool', 'Modify', 'Conditional')],
    ['removing the table', change('VendorTable00B5A738', 'AWS::DynamoDB::Table', 'Remove')],
  ] as const) {
    it(`flags ${label}`, () => {
      const [finding, ...rest] = dataLosingChanges([rc]);
      assert.equal(rest.length, 0);
      assert.equal(finding?.logicalId, rc.ResourceChange!.LogicalResourceId);
    });
  }

  for (const [label, rc] of [
    ['an in-place update of the table', change('VendorTable00B5A738', 'AWS::DynamoDB::Table', 'Modify', 'False')],
    ['adding a table', change('NewTable', 'AWS::DynamoDB::Table', 'Add')],
    ['replacing a Lambda function', change('GetVendorsHandler1B798460', 'AWS::Lambda::Function', 'Modify', 'True')],
    ['removing a Lambda version', change('GetVendorsHandlerCurrentVersion', 'AWS::Lambda::Version', 'Remove')],
    ['replacing the user pool client', change('VendorUserPoolVendorAppClient', 'AWS::Cognito::UserPoolClient', 'Modify', 'True')],
  ] as const) {
    it(`allows ${label}`, () => assert.deepEqual(dataLosingChanges([rc]), []));
  }

  it('ignores changes without a resource change', () => {
    assert.deepEqual(dataLosingChanges([{ Type: 'Resource' }]), []);
  });
});

describe('summarize', () => {
  const changes = [
    change('VendorTable00B5A738', 'AWS::DynamoDB::Table', 'Modify', 'True'),
    change('GetVendorsHandler1B798460', 'AWS::Lambda::Function', 'Modify', 'False'),
  ];
  const findings = dataLosingChanges(changes);

  it('lists every change and marks the risky one', () => {
    const text = summarize('VendorStack-prod', changes, findings, true);
    assert.match(text, /## VendorStack-prod: 2 changes/);
    assert.match(text, /\| ⚠️ Modify \| VendorTable00B5A738 \| AWS::DynamoDB::Table \| True \|/);
    assert.match(text, /\| Modify \| GetVendorsHandler1B798460 \|/);
  });

  it('says why it blocks, and how to override', () => {
    const text = summarize('VendorStack-prod', changes, findings, true);
    assert.match(text, /❌ \*\*Blocked\*\*: this would replace VendorTable00B5A738/);
    assert.match(text, /allow data replacement/);
  });

  it('only warns where data is not protected', () => {
    assert.match(summarize('VendorStack-dev', changes, findings, false), /⚠️ This replaces or deletes a data resource \(VendorTable00B5A738\); allowed here/);
  });
});

describe('STACK_POLICY', () => {
  it('allows every update but replacing or deleting the data resources', () => {
    const [allow, deny] = STACK_POLICY.Statement;
    assert.deepEqual(allow, { Effect: 'Allow', Action: 'Update:*', Principal: '*', Resource: '*' });
    assert.equal(deny?.Effect, 'Deny');
    assert.deepEqual(deny?.Action, ['Update:Replace', 'Update:Delete']);
    assert.deepEqual(deny?.Condition, { StringEquals: { ResourceType: STATEFUL_TYPES } });
    assert.deepEqual(STATEFUL_TYPES, ['AWS::DynamoDB::Table', 'AWS::Cognito::UserPool']);
  });
});
