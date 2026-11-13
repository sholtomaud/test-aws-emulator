// Unit tests: the synthesized CloudFormation template. No emulator.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VendorStack } from '../../infra/vendor-stack.ts';

const synth = (emulator: boolean): Template => {
  const frontendDir = mkdtempSync(join(tmpdir(), 'vendor-frontend-'));
  writeFileSync(join(frontendDir, 'index.html'), '<vendor-app></vendor-app>');
  const app = new App({ outdir: mkdtempSync(join(tmpdir(), 'vendor-cdk-')) });
  return Template.fromStack(new VendorStack(app, 'VendorStack', { frontendDir, emulator }));
};

describe('VendorStack', () => {
  let template: Template;
  before(() => {
    template = synth(false);
  });

  it('creates an on-demand DynamoDB table keyed by vendorId', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'vendorId', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'vendorId', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('creates the three vendor Lambda functions with the table name', () => {
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: { Environment: { Variables: { TABLE_NAME: Match.anyValue() } } },
    });
    assert.deepEqual(
      Object.keys(functions).map((id) => id.replace(/[0-9A-F]{8}$/, '')).sort(),
      ['CreateVendorHandler', 'DeleteVendorHandler', 'GetVendorsHandler'],
    );
    for (const fn of Object.values(functions)) assert.equal(fn.Properties.Runtime, 'nodejs22.x');
  });

  it('grants least-privilege table access', () => {
    const actionsFor = (role: string): string[] => {
      const policies = template.findResources('AWS::IAM::Policy', {
        Properties: { Roles: [{ Ref: Match.stringLikeRegexp(`^${role}ServiceRole`) }] },
      });
      return Object.values(policies).flatMap((policy) =>
        policy.Properties.PolicyDocument.Statement.flatMap((statement: { Action: string | string[] }) => statement.Action),
      );
    };
    const reader = actionsFor('GetVendorsHandler');
    assert.ok(reader.includes('dynamodb:Scan'));
    assert.ok(!reader.some((action) => /Put|Delete|Update|Write/.test(action)), 'reader must not write');
    for (const writer of ['CreateVendorHandler', 'DeleteVendorHandler']) {
      const actions = actionsFor(writer);
      assert.ok(actions.includes('dynamodb:PutItem') && actions.includes('dynamodb:DeleteItem'));
      assert.ok(!actions.some((action) => /Scan|Query|GetItem/.test(action)), 'writers must not read');
    }
  });

  it('protects GET, POST and DELETE /vendors with the Cognito authorizer', () => {
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 1);
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', { Type: 'COGNITO_USER_POOLS' });
    for (const HttpMethod of ['GET', 'POST', 'DELETE']) {
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod,
        AuthorizationType: 'COGNITO_USER_POOLS',
        Integration: { Type: 'AWS_PROXY' },
      });
    }
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'vendors' });
  });

  it('answers CORS preflight without authorization', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', { HttpMethod: 'OPTIONS', AuthorizationType: 'NONE' });
  });

  it('creates a self-sign-up user pool with email sign-in and a password-auth client', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: ['email'],
      AutoVerifiedAttributes: ['email'],
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH']),
    });
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });

  it('hosts the frontend in a private bucket behind CloudFront', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: { ViewerProtocolPolicy: 'redirect-to-https' },
        CustomErrorResponses: [{ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }],
      },
    });
  });

  it('deploys the frontend and invalidates CloudFront', () => {
    template.hasResourceProperties('Custom::CDKBucketDeployment', { DistributionPaths: ['/*'] });
  });

  it('exports the values the frontend and tests need', () => {
    for (const output of ['ApiEndpoint', 'UserPoolId', 'UserPoolClientId', 'TableName', 'SiteBucketName', 'CloudFrontURL']) {
      template.hasOutput(output, {});
    }
  });

  it('keeps Lambda permission ids within what AWS Emulator accepts', () => {
    // The emulator names the statement "<stack>-<logical id>-<12 chars>" (limit: 100).
    for (const id of Object.keys(template.findResources('AWS::Lambda::Permission'))) {
      const length = `VendorStack-${id}-`.length + 12;
      assert.ok(length <= 100, `${id} gives a ${length}-character statement id`);
    }
  });
});

describe('VendorStack for AWS Emulator', () => {
  it('has no Lambda-backed custom resources but keeps everything else', () => {
    const template = synth(true);
    template.resourceCountIs('Custom::CDKBucketDeployment', 0);
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.resourceCountIs('AWS::Lambda::Function', 3);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('AWS::S3::Bucket', 1);
  });
});
