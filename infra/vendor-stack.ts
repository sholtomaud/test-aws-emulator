import { fileURLToPath } from 'node:url';
import {
  CfnOutput,
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
} from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

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
}

export class VendorStack extends Stack {
  constructor(scope: Construct, id: string, props: VendorStackProps = {}) {
    super(scope, id, props);

    // 1. DynamoDB table
    const vendorTable = new dynamodb.Table(this, 'VendorTable', {
      partitionKey: { name: 'vendorId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY, // development only
    });

    // 2. Lambda functions (bundled with esbuild)
    const fn = (name: string, entry: string) =>
      new nodejs.NodejsFunction(this, name, {
        entry: path(`../src/lambda/${entry}.ts`),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        environment: { TABLE_NAME: vendorTable.tableName },
        // The AWS SDK is left external (the CDK default): it comes from the
        // Lambda runtime, on AWS and in AWS Emulator alike.
        bundling: { format: nodejs.OutputFormat.ESM, target: 'node22' },
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
      removalPolicy: RemovalPolicy.DESTROY, // development only
    });
    userPool.addDomain('VendorUserPoolDomain', {
      cognitoDomain: { domainPrefix: `vendor-tracker-${this.account}` },
    });
    // The web components talk to Cognito directly (no Amplify), using the
    // USER_PASSWORD_AUTH flow over HTTPS.
    const userPoolClient = userPool.addClient('VendorAppClient', {
      authFlows: { userPassword: true, userSrp: true },
    });

    // 5. API Gateway + Cognito authorizer
    //
    // Keep the construct id ('Api') short and allowTestInvoke off. AWS Emulator
    // 1.0.x uses "<stack>-<logical id>-<suffix>" as the Lambda permission
    // statement id without truncating it to Lambda's 100-character limit the
    // way CloudFormation does, so longer ids fail to deploy on the emulator.
    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: 'Vendor Service',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'VendorAuthorizer', {
      cognitoUserPools: [userPool],
    });
    const authOptions = { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO };
    const integration = (handler: lambda.IFunction) =>
      new apigateway.LambdaIntegration(handler, { allowTestInvoke: false });
    const vendors = api.root.addResource('vendors');
    vendors.addMethod('GET', integration(getVendorsLambda), authOptions);
    vendors.addMethod('POST', integration(createVendorLambda), authOptions);
    vendors.addMethod('DELETE', integration(deleteVendorLambda), authOptions);

    // 6. S3 bucket for the frontend files (private)
    const siteBucket = new s3.Bucket(this, 'VendorSiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: !props.emulator,
    });

    // 7. CloudFront distribution (HTTPS + CDN)
    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [{ httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' }],
    });

    // 8. Deploy the frontend, plus a config.json the app reads at startup, so
    //    the frontend needs no rebuild when the backend's identifiers change.
    if (!props.emulator) new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [
        s3deploy.Source.asset(props.frontendDir ?? path('../dist/frontend')),
        s3deploy.Source.jsonData('config.json', {
          apiUrl: api.url,
          region: this.region,
          userPoolId: userPool.userPoolId,
          userPoolClientId: userPoolClient.userPoolClientId,
        }),
      ],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // 9. Outputs
    new CfnOutput(this, 'ApiEndpoint', { value: api.url });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'TableName', { value: vendorTable.tableName });
    new CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
    new CfnOutput(this, 'CloudFrontURL', { value: `https://${distribution.distributionDomainName}` });
  }
}
