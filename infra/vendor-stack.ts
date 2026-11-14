import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  aws_apigateway as apigateway,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_secretsmanager as secretsmanager,
  aws_wafv2 as wafv2,
} from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/** Header CloudFront adds to API requests; the API's WAF web ACL requires it. */
export const ORIGIN_VERIFY_HEADER = 'X-Origin-Verify';

const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export interface VendorStackProps extends StackProps {
  /** Directory holding the built frontend. Defaults to dist/frontend. */
  frontendDir?: string;
  /**
   * Set when deploying to AWS Emulator, which (as of 1.0.x) cannot complete
   * Lambda-backed custom resources. Leaves out S3 auto-delete and the
   * BucketDeployment; `scripts/publish-site.ts` uploads the frontend instead.
   */
  emulator?: boolean;
  /**
   * Deployment stage (dev, test, uat, prod): names the Cognito domain so
   * several stages can share an account. Unset for a single deployment.
   */
  stage?: string;
  /**
   * Keep the table, user pool and site bucket when the stack is deleted, and
   * turn on point-in-time recovery and deletion protection. For production.
   */
  retainData?: boolean;
}

export class VendorStack extends Stack {
  constructor(scope: Construct, id: string, props: VendorStackProps = {}) {
    super(scope, id, props);
    // Data survives a stack deletion only where it matters (production).
    const dataRemoval = props.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // 1. DynamoDB table. Each user's vendors are one partition: the owner (the
    //    user's Cognito `sub`) is the partition key, the vendor id the sort key.
    const vendorTable = new dynamodb.Table(this, 'VendorTable', {
      partitionKey: { name: 'ownerId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'vendorId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: dataRemoval,
      ...(props.retainData && {
        deletionProtection: true,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      }),
    });

    // 2. Lambda functions (bundled with esbuild)
    const fn = (name: string, entry: string) =>
      new nodejs.NodejsFunction(this, name, {
        entry: path(`../src/lambda/${entry}.ts`),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_26_X,
        environment: { TABLE_NAME: vendorTable.tableName },
        // The AWS SDK is left external (the CDK default): it comes from the
        // Lambda runtime, on AWS and in AWS Emulator alike.
        bundling: { format: nodejs.OutputFormat.ESM, target: 'node26' },
      });
    const createVendorLambda = fn('CreateVendorHandler', 'createVendor');
    const getVendorsLambda = fn('GetVendorsHandler', 'getVendors');
    const deleteVendorLambda = fn('DeleteVendorHandler', 'deleteVendor');

    // 3. Permissions (least privilege)
    vendorTable.grantWriteData(createVendorLambda);
    vendorTable.grantReadData(getVendorsLambda);
    vendorTable.grantWriteData(deleteVendorLambda);

    // 4. Cognito user pool
    const userPool = new cognito.UserPool(this, 'VendorUserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      userVerification: { emailStyle: cognito.VerificationEmailStyle.CODE },
      removalPolicy: dataRemoval,
      ...(props.retainData && { deletionProtection: true }),
    });
    userPool.addDomain('VendorUserPoolDomain', {
      // Globally unique: one per account, and per stage when stages share one.
      cognitoDomain: { domainPrefix: ['vendor-tracker', props.stage, this.account].filter(Boolean).join('-') },
    });
    // The web components talk to Cognito directly (no Amplify), using the
    // USER_PASSWORD_AUTH flow over HTTPS.
    const userPoolClient = userPool.addClient('VendorAppClient', {
      authFlows: { userPassword: true, userSrp: true },
    });

    // 5. API Gateway with a Cognito user pool authorizer: every method needs a
    //    valid ID token from this user pool in the Authorization header, and
    //    the Lambdas get its claims (the `sub` scopes each user's vendors).
    //
    // Keep the construct id ('Api') short and allowTestInvoke off. AWS Emulator
    // 1.0.x uses "<stack>-<logical id>-<suffix>" as the Lambda permission
    // statement id without truncating it to Lambda's 100-character limit the
    // way CloudFormation does, so longer ids fail to deploy on the emulator.
    //
    // No CORS: the browser reaches the API through CloudFront, on the site's
    // own origin, under /api/*.
    const api = new apigateway.RestApi(this, 'Api', { restApiName: 'Vendor Service' });
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'VendorAuthorizer', {
      cognitoUserPools: [userPool],
    });
    const authOptions = { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO };
    const integration = (handler: lambda.IFunction) =>
      new apigateway.LambdaIntegration(handler, { allowTestInvoke: false });
    // Short construct ids ('A', 'V') for the same reason as 'Api' above: the
    // path /api/vendors would otherwise push one permission id past 100.
    const apiResource = new apigateway.Resource(api.root, 'A', { parent: api.root, pathPart: 'api' });
    const vendors = new apigateway.Resource(apiResource, 'V', { parent: apiResource, pathPart: 'vendors' });
    for (const [method, handler] of [
      ['GET', getVendorsLambda],
      ['POST', createVendorLambda],
      ['DELETE', deleteVendorLambda],
    ] as const) {
      vendors.addMethod(method, integration(handler), authOptions);
    }

    // 6. Only CloudFront may call the API. API Gateway has no origin access
    //    control, so CloudFront adds a secret header to every request it sends
    //    to the API, and a WAF web ACL on the stage blocks requests without it.
    //    The secret is generated in Secrets Manager and resolved by
    //    CloudFormation at deploy time, so it is never in the template.
    const originSecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      description: 'Shared secret CloudFront sends to API Gateway in X-Origin-Verify',
      generateSecretString: { excludePunctuation: true, passwordLength: 48 },
      removalPolicy: RemovalPolicy.DESTROY, // a new secret is generated if the stack is recreated
    });
    const originSecretValue = originSecret.secretValue.unsafeUnwrap();
    const visibility = (metricName: string) => ({
      cloudWatchMetricsEnabled: true,
      sampledRequestsEnabled: true,
      metricName,
    });
    const apiAcl = new wafv2.CfnWebACL(this, 'ApiWebAcl', {
      scope: 'REGIONAL',
      defaultAction: { block: {} },
      visibilityConfig: visibility('VendorApiBlocked'),
      rules: [
        {
          name: 'AllowCloudFront',
          priority: 0,
          action: { allow: {} },
          visibilityConfig: visibility('VendorApiFromCloudFront'),
          statement: {
            byteMatchStatement: {
              fieldToMatch: { singleHeader: { Name: ORIGIN_VERIFY_HEADER } },
              positionalConstraint: 'EXACTLY',
              searchString: originSecretValue,
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'ApiWebAclAssociation', {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: apiAcl.attrArn,
    });

    // 7. S3 bucket for the frontend files (private)
    const siteBucket = new s3.Bucket(this, 'VendorSiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: dataRemoval,
      autoDeleteObjects: !props.emulator && !props.retainData,
    });

    // 8. CloudFront distribution: the site from S3 (origin access control),
    //    and /api/* from API Gateway. CloudFront forwards the Authorization
    //    header (the ID token) only when it is part of the cache key, so the
    //    API behavior keys on it, which also keeps one user's responses from
    //    ever being served to another. The TTL is zero (API Gateway's
    //    responses carry no caching headers), so nothing is cached at all.
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      comment: 'Vendor API: forward the Authorization header, never serve from cache',
      defaultTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    });
    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.RestApiOrigin(api, { customHeaders: { [ORIGIN_VERIFY_HEADER]: originSecretValue } }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      defaultRootObject: 'index.html',
      errorResponses: [{ httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' }],
    });
    // HTTPPort and HTTPSPort are optional in CloudFormation (defaults 80 and
    // 443), but AWS Emulator 1.0.x rejects a custom origin without them.
    // RestApiOrigin has no option for them, hence the overrides. Origin 1 is the API.
    const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.1.CustomOriginConfig.HTTPPort', 80);
    cfnDistribution.addPropertyOverride('DistributionConfig.Origins.1.CustomOriginConfig.HTTPSPort', 443);

    // 9. Deploy the frontend, plus a config.json the app reads at startup, so
    //    the frontend needs no rebuild when the backend's identifiers change.
    const appConfig = {
      apiUrl: '/api',
      region: this.region,
      userPoolId: userPool.userPoolId,
      userPoolClientId: userPoolClient.userPoolClientId,
    };
    if (!props.emulator) new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [
        s3deploy.Source.asset(props.frontendDir ?? path('../dist/frontend')),
        s3deploy.Source.jsonData('config.json', {
          ...appConfig,
        }),
      ],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // 10. Outputs
    new CfnOutput(this, 'ApiEndpoint', { value: api.url });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'TableName', { value: vendorTable.tableName });
    new CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
    new CfnOutput(this, 'OriginSecretArn', { value: originSecret.secretArn });
    new CfnOutput(this, 'CloudFrontURL', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
  }
}
