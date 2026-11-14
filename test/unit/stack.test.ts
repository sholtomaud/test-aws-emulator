// Unit tests: the synthesized CloudFormation template. No emulator.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GitHubDeployStack } from '../../infra/github-deploy-stack.ts';
import { VendorStack } from '../../infra/vendor-stack.ts';
import type { VendorStackProps } from '../../infra/vendor-stack.ts';

const synth = (emulator: boolean, props: VendorStackProps = {}): Template => {
  const frontendDir = mkdtempSync(join(tmpdir(), 'vendor-frontend-'));
  writeFileSync(join(frontendDir, 'index.html'), '<vendor-app></vendor-app>');
  const app = new App({ outdir: mkdtempSync(join(tmpdir(), 'vendor-cdk-')) });
  return Template.fromStack(new VendorStack(app, 'VendorStack', { frontendDir, emulator, ...props }));
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
    for (const fn of Object.values(functions)) assert.equal(fn.Properties.Runtime, 'nodejs26.x');
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

  it('protects GET, POST and DELETE /api/vendors with IAM auth', () => {
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 0);
    for (const HttpMethod of ['GET', 'POST', 'DELETE']) {
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod,
        AuthorizationType: 'AWS_IAM',
        Integration: { Type: 'AWS_PROXY' },
      });
    }
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'api' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'vendors' });
  });

  it('has no unauthenticated methods and no CORS preflight (the API is same-origin)', () => {
    const methods = Object.values(template.findResources('AWS::ApiGateway::Method'));
    assert.equal(methods.length, 3);
    for (const method of methods) assert.equal(method.Properties.AuthorizationType, 'AWS_IAM');
  });

  it('lets signed-in users, and only them, invoke the vendor routes', () => {
    template.hasResourceProperties('AWS::Cognito::IdentityPool', {
      AllowUnauthenticatedIdentities: false,
      CognitoIdentityProviders: [Match.objectLike({ ProviderName: Match.anyValue(), ClientId: Match.anyValue() })],
    });
    template.hasResourceProperties('AWS::Cognito::IdentityPoolRoleAttachment', {
      Roles: { authenticated: Match.anyValue() },
    });
    const invoke = Object.values(template.findResources('AWS::IAM::Policy')).flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.filter((statement: { Action: string }) => statement.Action === 'execute-api:Invoke'),
    );
    assert.equal(invoke.length, 1, 'one execute-api:Invoke statement, on the authenticated role');
    const resources = JSON.stringify(invoke[0].Resource);
    for (const method of ['GET', 'POST', 'DELETE']) assert.ok(resources.includes(`/${method}/api/vendors`), `${method} missing`);
    assert.ok(!resources.includes('*/*'), 'no wildcard method or path');
  });

  it('blocks API requests that do not come through CloudFront', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      DefaultAction: { Block: {} },
      Rules: [
        Match.objectLike({
          Action: { Allow: {} },
          Statement: {
            ByteMatchStatement: Match.objectLike({
              FieldToMatch: { SingleHeader: { Name: 'X-Origin-Verify' } },
              PositionalConstraint: 'EXACTLY',
            }),
          },
        }),
      ],
    });
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    // The shared secret is generated, and resolved at deploy time: never a literal in the template.
    template.hasResourceProperties('AWS::SecretsManager::Secret', { GenerateSecretString: Match.objectLike({ PasswordLength: 48 }) });
    const acl = Object.values(template.findResources('AWS::WAFv2::WebACL'))[0]!;
    assert.match(JSON.stringify(acl.Properties.Rules[0].Statement.ByteMatchStatement.SearchString), /resolve:secretsmanager/);
  });

  it('serves the API under /api/* through CloudFront with the secret header and no caching', () => {
    const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0]!.Properties.DistributionConfig;
    const apiOrigin = distribution.Origins.find((origin: { CustomOriginConfig?: unknown }) => origin.CustomOriginConfig);
    assert.match(JSON.stringify(apiOrigin.OriginPath), /ApiDeploymentStage/, 'the origin path is the API stage');
    assert.equal(apiOrigin.CustomOriginConfig.OriginProtocolPolicy, 'https-only');
    assert.equal(apiOrigin.OriginCustomHeaders[0].HeaderName, 'X-Origin-Verify');
    assert.match(JSON.stringify(apiOrigin.OriginCustomHeaders[0].HeaderValue), /resolve:secretsmanager/);
    const behavior = distribution.CacheBehaviors.find((b: { PathPattern: string }) => b.PathPattern === '/api/*');
    assert.equal(behavior.TargetOriginId, apiOrigin.Id);
    assert.equal(behavior.ViewerProtocolPolicy, 'https-only');
    assert.deepEqual(behavior.AllowedMethods, ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']);
    // AllViewerExceptHostHeader: API Gateway needs its own Host header.
    assert.equal(behavior.OriginRequestPolicyId, 'b689b0a8-53d0-40ab-baf2-68738e2966ac');
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({
        DefaultTTL: 0,
        MinTTL: 0,
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          HeadersConfig: { HeaderBehavior: 'whitelist', Headers: ['Authorization', 'X-Amz-Date', 'X-Amz-Security-Token'] },
        }),
      }),
    });
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
    for (const output of ['ApiEndpoint', 'UserPoolId', 'UserPoolClientId', 'IdentityPoolId', 'OriginSecretArn', 'TableName', 'SiteBucketName', 'CloudFrontURL']) {
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
    template.resourceCountIs('AWS::Cognito::IdentityPool', 1);
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
  });
});

describe('VendorStack stages', () => {
  it('deletes data with the stack outside production', () => {
    const template = synth(false, { stage: 'dev' });
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
    template.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Delete' });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  it('keeps and protects the data in production', () => {
    const template = synth(false, { stage: 'prod', retainData: true });
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        DeletionProtectionEnabled: true,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }),
    });
    template.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Retain', Properties: Match.objectLike({ DeletionProtection: 'ACTIVE' }) });
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });

  it('gives each stage its own Cognito domain, so stages can share an account', () => {
    const domain = (template: Template) =>
      JSON.stringify(Object.values(template.findResources('AWS::Cognito::UserPoolDomain'))[0]!.Properties.Domain);
    assert.match(domain(synth(false, { stage: 'uat' })), /vendor-tracker-uat-/);
    assert.match(domain(synth(false)), /"vendor-tracker-"/);
  });
});

describe('GitHubDeployStack', () => {
  const template = Template.fromStack(
    new GitHubDeployStack(new App(), 'Deploy', { repository: 'octo/vendors', environments: ['dev', 'prod'] }),
  );

  it('trusts GitHub OIDC tokens only for this repository and each environment', () => {
    template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
    for (const environment of ['dev', 'prod']) {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: `vendor-tracker-deploy-${environment}`,
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                  'token.actions.githubusercontent.com:sub': `repo:octo/vendors:environment:${environment}`,
                },
              },
            }),
          ],
        },
      });
    }
  });

  it('lets the roles do nothing but assume the CDK bootstrap roles and read the stack', () => {
    const actions = Object.values(template.findResources('AWS::IAM::Policy')).flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.flatMap((statement: { Action: string | string[] }) => statement.Action),
    );
    assert.deepEqual([...new Set(actions)].sort(), ['cloudformation:DescribeStacks', 'sts:AssumeRole', 'sts:TagSession']);
    assert.match(JSON.stringify(template.toJSON()), /role\/cdk-hnb659fds-\*-/);
  });

  it('refuses a malformed repository', () => {
    assert.throws(() => new GitHubDeployStack(new App(), 'X', { repository: 'nope', environments: ['dev'] }), /owner\/name/);
  });
});
