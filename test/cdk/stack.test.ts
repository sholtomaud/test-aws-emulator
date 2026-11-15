// CDK tests: assertions on the synthesized CloudFormation template. No emulator.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GitHubDeployStack } from '../../infra/github-deploy-stack.ts';
import { VendorStack, stageSettings } from '../../infra/vendor-stack.ts';
import type { VendorStackProps } from '../../infra/vendor-stack.ts';
import { testApp } from './app.ts';

const synth = (emulator: boolean, props: VendorStackProps = {}): Template => {
  const frontendDir = mkdtempSync(join(tmpdir(), 'vendor-frontend-'));
  writeFileSync(join(frontendDir, 'index.html'), '<vendor-app></vendor-app>');
  const app = testApp({ outdir: mkdtempSync(join(tmpdir(), 'vendor-cdk-')) });
  return Template.fromStack(new VendorStack(app, 'VendorStack', { frontendDir, emulator, ...props }));
};

describe('VendorStack', () => {
  let template: Template;
  before(() => {
    template = synth(false);
  });

  it("creates an on-demand DynamoDB table with one partition per user (ownerId, vendorId)", () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'ownerId', KeyType: 'HASH' },
        { AttributeName: 'vendorId', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: 'ownerId', AttributeType: 'S' },
        { AttributeName: 'vendorId', AttributeType: 'S' },
      ]),
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
    assert.ok(reader.includes('dynamodb:Query'));
    assert.ok(!reader.some((action) => /Put|Delete|Update|Write/.test(action)), 'reader must not write');
    for (const writer of ['CreateVendorHandler', 'DeleteVendorHandler']) {
      const actions = actionsFor(writer);
      assert.ok(actions.includes('dynamodb:PutItem') && actions.includes('dynamodb:DeleteItem'));
      assert.ok(!actions.some((action) => /Scan|Query|GetItem/.test(action)), 'writers must not read');
    }
  });

  it('protects GET, POST and DELETE /api/vendors with the Cognito authorizer', () => {
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 1);
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'COGNITO_USER_POOLS',
      IdentitySource: 'method.request.header.Authorization',
    });
    for (const HttpMethod of ['GET', 'POST', 'DELETE']) {
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod,
        AuthorizationType: 'COGNITO_USER_POOLS',
        Integration: { Type: 'AWS_PROXY' },
      });
    }
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'api' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'vendors' });
  });

  it('has no unauthenticated methods and no CORS preflight (the API is same-origin)', () => {
    const methods = Object.values(template.findResources('AWS::ApiGateway::Method'));
    assert.equal(methods.length, 3);
    for (const method of methods) assert.equal(method.Properties.AuthorizationType, 'COGNITO_USER_POOLS');
  });

  it('has no identity pool and no IAM permission to invoke the API', () => {
    template.resourceCountIs('AWS::Cognito::IdentityPool', 0);
    const invoke = Object.values(template.findResources('AWS::IAM::Policy')).flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.filter((statement: { Action: string }) => statement.Action === 'execute-api:Invoke'),
    );
    assert.equal(invoke.length, 0);
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
          HeadersConfig: { HeaderBehavior: 'whitelist', Headers: ['Authorization'] },
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

  it('deploys the content-hashed assets first, cached for a year and never deleted', () => {
    const deployments = template.findResources('Custom::CDKBucketDeployment');
    assert.equal(Object.keys(deployments).length, 2);
    const [assetsId, assets] = Object.entries(deployments).find(([id]) => id.startsWith('DeployAssets'))!;
    assert.equal(assets.Properties.Prune, false, 'old assets must stay for pages of earlier releases');
    assert.deepEqual(assets.Properties.SystemMetadata, { 'cache-control': 'public, max-age=31536000, immutable' });
    assert.equal(assets.Properties.DistributionPaths, undefined, 'assets are never invalidated');
    const [, page] = Object.entries(deployments).find(([id]) => id.startsWith('DeployPage'))!;
    assert.ok([page.DependsOn].flat().includes(assetsId), 'the page is published after its assets');
  });

  it('then the page and config.json, uncached, invalidating only those paths', () => {
    const page = Object.entries(template.findResources('Custom::CDKBucketDeployment')).find(([id]) => id.startsWith('DeployPage'))![1];
    assert.equal(page.Properties.Prune, false);
    assert.deepEqual(page.Properties.SystemMetadata, { 'cache-control': 'no-cache' });
    assert.deepEqual(page.Properties.DistributionPaths, ['/', '/index.html', '/config.json']);
  });

  it('exports the values the frontend and tests need', () => {
    for (const output of ['ApiEndpoint', 'UserPoolId', 'UserPoolClientId', 'OriginSecretArn', 'TableName', 'SiteBucketName', 'CloudFrontURL', 'DistributionId']) {
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
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
  });
});

describe('VendorStack custom domain', () => {
  const zone = { id: 'Z0123456789ABC', name: 'example.com' };
  const usEast1 = { account: '111111111111', region: 'us-east-1' };
  const sydney = { account: '111111111111', region: 'ap-southeast-2' };
  const certificateArn = 'arn:aws:acm:us-east-1:111111111111:certificate/11111111-2222-3333-4444-555555555555';

  it('in us-east-1 with a Route 53 zone: issues the certificate, requires TLS 1.2 and adds the alias records', () => {
    const template = synth(false, { ...stageSettings('dev'), env: usEast1, domain: { domainName: 'dev.vendors.example.com', hostedZone: zone } });
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'dev.vendors.example.com',
      ValidationMethod: 'DNS',
      DomainValidationOptions: [{ DomainName: 'dev.vendors.example.com', HostedZoneId: zone.id }],
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['dev.vendors.example.com'],
        ViewerCertificate: Match.objectLike({ MinimumProtocolVersion: 'TLSv1.2_2021', SslSupportMethod: 'sni-only' }),
      }),
    });
    for (const Type of ['A', 'AAAA']) {
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: 'dev.vendors.example.com.',
        Type,
        HostedZoneId: zone.id,
        AliasTarget: Match.objectLike({ EvaluateTargetHealth: false }),
      });
    }
    template.hasOutput('SiteURL', { Value: 'https://dev.vendors.example.com' });
  });

  it('in another region: uses the us-east-1 certificate it is given, and still adds the records', () => {
    const template = synth(false, { ...stageSettings('prod'), env: sydney, domain: { domainName: 'vendors.example.com', hostedZone: zone, certificateArn } });
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ ViewerCertificate: Match.objectLike({ AcmCertificateArn: certificateArn }) }),
    });
    template.resourceCountIs('AWS::Route53::RecordSet', 2);
  });

  it('without a hosted zone: leaves DNS to you', () => {
    const template = synth(false, { ...stageSettings('dev'), env: sydney, domain: { domainName: 'vendors.example.org', certificateArn } });
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
    template.hasOutput('SiteURL', { Value: 'https://vendors.example.org' });
  });

  it('without a domain: serves on CloudFront\'s own name', () => {
    const template = synth(false, stageSettings('dev'));
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    template.resourceCountIs('AWS::Route53::RecordSet', 0);
    const config = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0]!.Properties.DistributionConfig;
    assert.equal(config.Aliases, undefined);
  });

  for (const [label, props, message] of [
    ['a certificate it cannot create outside us-east-1', { env: sydney, domain: { domainName: 'vendors.example.com', hostedZone: zone } }, /needs a certificate in us-east-1/],
    ['a certificate outside us-east-1', { env: sydney, domain: { domainName: 'vendors.example.com', certificateArn: certificateArn.replace('us-east-1', 'ap-southeast-2') } }, /must be an ACM certificate in us-east-1/],
    ['a domain outside its hosted zone', { env: usEast1, domain: { domainName: 'vendors.example.org', hostedZone: zone } }, /is not in the hosted zone example\.com/],
    ['neither a hosted zone nor a certificate', { env: usEast1, domain: { domainName: 'vendors.example.com' } }, /needs hostedZone .* or certificateArn/],
  ] as const) {
    it(`refuses ${label}`, () => {
      assert.throws(() => synth(false, { ...stageSettings('dev'), ...props }), message);
    });
  }
});

describe('VendorStack releases', () => {
  const groups = (template: Template) => Object.values(template.findResources('AWS::CodeDeploy::DeploymentGroup'));

  it('sends API traffic to each function\'s live alias, never to $LATEST', () => {
    const template = synth(false, stageSettings('dev'));
    template.resourceCountIs('AWS::Lambda::Alias', 3);
    template.hasResourceProperties('AWS::Lambda::Alias', { Name: 'live' });
    for (const method of Object.values(template.findResources('AWS::ApiGateway::Method'))) {
      // The integration URI invokes the alias ARN (function:...:live).
      assert.match(JSON.stringify(method.Properties.Integration.Uri), /Live/, 'integration does not target the alias');
    }
  });

  it('rolls each function back automatically on its errors, its throttles or API 5xx', () => {
    const template = synth(false, stageSettings('dev'));
    const all = groups(template);
    assert.equal(all.length, 3);
    for (const group of all) {
      assert.deepEqual(group.Properties.AutoRollbackConfiguration, {
        Enabled: true,
        Events: ['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_REQUEST', 'DEPLOYMENT_STOP_ON_ALARM'],
      });
      assert.equal(group.Properties.AlarmConfiguration.Enabled, true);
      assert.equal(group.Properties.AlarmConfiguration.Alarms.length, 3);
    }
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: '5XXError', Namespace: 'AWS/ApiGateway', Threshold: 1 });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Errors', Namespace: 'AWS/Lambda', Threshold: 1 });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Throttles', Namespace: 'AWS/Lambda', Threshold: 1 });
    // One CodeDeploy role for the three groups.
    assert.equal(new Set(all.map((group) => JSON.stringify(group.Properties.ServiceRoleArn))).size, 1);
  });

  for (const [stage, config] of [
    ['dev', 'CodeDeployDefault.LambdaAllAtOnce'],
    ['test', 'CodeDeployDefault.LambdaAllAtOnce'],
    ['uat', 'CodeDeployDefault.LambdaCanary10Percent5Minutes'],
    ['prod', 'CodeDeployDefault.LambdaCanary10Percent5Minutes'],
  ] as const) {
    it(`${stage} releases ${config.endsWith('AllAtOnce') ? 'all at once' : 'gradually (10%, then the rest after 5 minutes)'}`, () => {
      for (const group of groups(synth(false, stageSettings(stage)))) assert.equal(group.Properties.DeploymentConfigName, config);
    });
  }
});

describe('VendorStack stages', () => {
  it('deletes data with the stack outside production', () => {
    const template = synth(false, stageSettings('dev'));
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
    template.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Delete' });
    template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
  });

  it('keeps and protects the data in production', () => {
    const template = synth(false, stageSettings('prod'));
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
    assert.match(domain(synth(false, stageSettings('uat'))), /vendor-tracker-uat-/);
    assert.match(domain(synth(false)), /"vendor-tracker-"/);
  });
});

describe('GitHubDeployStack', () => {
  const template = Template.fromStack(
    new GitHubDeployStack(testApp(), 'Deploy', { repository: 'octo/vendors', environments: ['dev', 'prod'] }),
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

  it('lets the roles do nothing but assume the CDK bootstrap roles and run the release of their own stack', () => {
    const actions = Object.values(template.findResources('AWS::IAM::Policy')).flatMap((policy) =>
      policy.Properties.PolicyDocument.Statement.flatMap((statement: { Action: string | string[] }) => statement.Action),
    );
    assert.deepEqual([...new Set(actions)].sort(), [
      'cloudformation:DescribeChangeSet',
      'cloudformation:DescribeStacks',
      'cloudformation:ExecuteChangeSet',
      'cloudformation:GetStackPolicy',
      'cloudformation:SetStackPolicy',
      'sts:AssumeRole',
      'sts:TagSession',
    ]);
    // The CloudFormation actions are confined to each environment's own stack.
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    const isCloudFormation = (st: { Action: string | string[] }) => [st.Action].flat().some((action) => action.startsWith('cloudformation:'));
    for (const statement of statements.filter(isCloudFormation)) {
      assert.match(JSON.stringify(statement.Resource), /stack\/VendorStack-(dev|prod)\/\*/);
    }
    assert.match(JSON.stringify(template.toJSON()), /role\/cdk-hnb659fds-\*-/);
  });

  it('refuses a malformed repository', () => {
    assert.throws(() => new GitHubDeployStack(testApp(), 'X', { repository: 'nope', environments: ['dev'] }), /owner\/name/);
  });
});
