# AWS Emulator issues found by this project

Differences from AWS found while building and testing this stack against
[AWS Emulator](https://github.com/aws/aws-emulator), checked on **1.0.353**
(release 2026.11.14, commit `ca8a89dedfa8e4b5e67a3c90dc736f921ba409a1`),
Linux x86_64 package, Region `us-east-1`, AWS SDK for JavaScript v3, endpoint
set with `AWS_ENDPOINT_URL`, all emulator settings at their defaults except
`-t off`.

Each section below is written for the repository's **Behavior differs from
AWS** issue form (What happened / What you expected / Steps to reproduce /
Emulator version / Impact and workaround). To file one, open
<https://github.com/aws/aws-emulator/issues/new/choose>, pick that form and
paste the sections.

Already reported, so not repeated here (add a 👍 instead):

- [aws/aws-emulator#373](https://github.com/aws/aws-emulator/issues/373):
  CloudFront never forwards the viewer's `Authorization` header. Worth adding
  to that issue: it is also dropped when a **cache policy** lists
  `Authorization` (the way AWS documents for forwarding it), not only with
  origin request policies such as `AllViewerExceptHostHeader`.
- [aws/aws-emulator#160](https://github.com/aws/aws-emulator/issues/160):
  CloudFront ignores `DefaultRootObject`.
- [aws/aws-emulator#3](https://github.com/aws/aws-emulator/issues/3): container
  support for compute services, which covers CodeBuild running only shell
  built-ins (`ls`, `mkdir`, `node`, `npm` exit 127).

| # | Title | Status |
| --- | --- | --- |
| 1 | CodePipeline: CloudFormation, CodeDeploy, ECS, Step Functions, Commands, CodeStarSourceConnection and CodeBuild Test actions are not run | To file |
| 2 | CodePipeline: a Lambda Invoke action succeeds although the function never reports the job result | To file |
| 3 | CodeBuild: a buildspec.yml in the source is never found or parsed | To file |
| 4 | Lambda Node.js runtime: CodePipeline, CodeBuild and CloudFormation SDK clients are incomplete or misnamed | To file |
| 5 | CloudFormation: AWS::CloudFront::Distribution custom origin without HTTPPort/HTTPSPort is rejected | To file |
| 6 | CloudFormation: AWS::CodePipeline::Pipeline rejects a boolean action configuration value | To file |
| 7 | API Gateway: a mapping template using $context.identity returns 500 | To file |
| 8 | Bedrock AgentCore: CreatePaymentConnector returns 501, so no payment can be processed | To file |

---

## 1. CodePipeline: CloudFormation, CodeDeploy, ECS, Step Functions, Commands, CodeStarSourceConnection and CodeBuild Test actions are not run

**What happened**

A pipeline execution fails at the first action of any of these types. The
action's `externalExecutionSummary` (from `ListActionExecutions`) says:

```
this emulator does not run Deploy actions provided by CloudFormation, so the action cannot be performed
```

The same message, with the category and provider, appears for:

| Category | Provider | Notes |
| --- | --- | --- |
| Deploy | CloudFormation | every `ActionMode`, including `CHANGE_SET_REPLACE` and `CHANGE_SET_EXECUTE` |
| Deploy | CloudFormationStackSet | |
| Deploy | CodeDeploy | |
| Deploy | ECS | |
| Invoke | StepFunctions | |
| Compute | Commands | |
| Source | CodeStarSourceConnection | GitHub, Bitbucket, GitLab |
| Test | CodeBuild | a `Build`-category CodeBuild action with the same project runs |

These are run: Source S3, CodeCommit and ECR; Build CodeBuild; Approval Manual;
Deploy S3; Invoke Lambda. Stage transitions, retries, approvals, variables
(`#{Namespace.Var}`) and `StopPipelineExecution` behave as on AWS.

**What you expected**

On AWS, a CloudFormation deploy action creates or updates the stack from the
input artifact's template (see "AWS CloudFormation deploy action reference" in
the CodePipeline User Guide), and the other providers run as documented.
Source → Build → Approval → CloudFormation deploy is the most common pipeline
shape, so without it a pipeline cannot be tested end to end.

**Steps to reproduce**

```js
import { readFileSync } from 'node:fs';
import * as CP from '@aws-sdk/client-codepipeline';
import * as S3 from '@aws-sdk/client-s3';
import * as IAM from '@aws-sdk/client-iam';
const cp = new CP.CodePipelineClient({}), s3 = new S3.S3Client({ forcePathStyle: true }), iam = new IAM.IAMClient({});
const role = (await iam.send(new IAM.CreateRoleCommand({ RoleName: 'pipe', AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { Service: ['codepipeline.amazonaws.com', 'cloudformation.amazonaws.com'] }, Action: 'sts:AssumeRole' }] }) }))).Role.Arn;
await s3.send(new S3.CreateBucketCommand({ Bucket: 'pipe-artifacts' }));
await s3.send(new S3.PutBucketVersioningCommand({ Bucket: 'pipe-artifacts', VersioningConfiguration: { Status: 'Enabled' } }));
// source.zip holds template.yml with one AWS::SQS::Queue
await s3.send(new S3.PutObjectCommand({ Bucket: 'pipe-artifacts', Key: 'source.zip', Body: readFileSync('source.zip') }));
await cp.send(new CP.CreatePipelineCommand({ pipeline: { name: 'p', roleArn: role, pipelineType: 'V2', artifactStore: { type: 'S3', location: 'pipe-artifacts' }, stages: [
  { name: 'Source', actions: [{ name: 'S', actionTypeId: { category: 'Source', owner: 'AWS', provider: 'S3', version: '1' },
    configuration: { S3Bucket: 'pipe-artifacts', S3ObjectKey: 'source.zip', PollForSourceChanges: 'false' }, outputArtifacts: [{ name: 'Src' }] }] },
  { name: 'Deploy', actions: [{ name: 'Cfn', actionTypeId: { category: 'Deploy', owner: 'AWS', provider: 'CloudFormation', version: '1' },
    configuration: { ActionMode: 'CREATE_UPDATE', StackName: 'FromPipeline', TemplatePath: 'Src::template.yml', RoleArn: role }, inputArtifacts: [{ name: 'Src' }] }] } ] } }));
await cp.send(new CP.StartPipelineExecutionCommand({ name: 'p' }));
await new Promise((r) => setTimeout(r, 5000));
for (const a of (await cp.send(new CP.ListActionExecutionsCommand({ pipelineName: 'p' }))).actionExecutionDetails)
  console.log(a.stageName, a.status, a.output?.executionResult?.externalExecutionSummary);
// Deploy Failed this emulator does not run Deploy actions provided by CloudFormation, ...
```

**Impact and workaround**

Pipelines that deploy with CloudFormation cannot be tested locally. A Lambda
Invoke action cannot stand in for it either (see issues 2 and 4).

---

## 2. CodePipeline: a Lambda Invoke action succeeds although the function never reports the job result

**What happened**

An `Invoke`/`Lambda` action is marked `Succeeded` as soon as the function
returns, even though the function called neither `PutJobSuccessResult` nor
`PutJobFailureResult`. In the run below the function's calls to CodePipeline
failed (see issue 4), and the action and the pipeline still succeeded:

```
Deploy Succeeded Invoked the function cfn-deployer4
pipeline Succeeded
```

**What you expected**

On AWS the action stays `InProgress` until the function reports the job with
`PutJobSuccessResult` or `PutJobFailureResult`, and fails when it times out
("Invoke an AWS Lambda function in a pipeline", CodePipeline User Guide). A
function that crashes or forgets to report must fail the pipeline.

**Steps to reproduce**

1. Create a Node.js function whose handler is `export const handler = async () => ({})`.
2. Create a pipeline with an S3 (or CodeCommit) source and a second stage with
   one action: `{ category: 'Invoke', owner: 'AWS', provider: 'Lambda', version: '1' }`,
   `configuration: { FunctionName: '<the function>' }`.
3. `StartPipelineExecution`, then poll `GetPipelineExecution`: status `Succeeded`.

**Impact and workaround**

Tests pass locally that fail on AWS. No workaround.

---

## 3. CodeBuild: a buildspec.yml in the source is never found or parsed

**What happened**

For a project whose source is an S3 zip (or a CodePipeline artifact) that has
`buildspec.yml` at its root, the build fails in `DOWNLOAD_SOURCE`:

| Project `source.buildspec` | Result |
| --- | --- |
| not set (default `buildspec.yml`) | `YAML_FILE_ERROR`: YAML file does not exist |
| `buildspec.yml` | `YAML_FILE_ERROR`: Unable to parse YAML file |

The zip was tried both stored and deflated, and as a plain S3 prefix. The same
buildspec passed inline (`source.buildspec` set to the YAML text) runs.

**What you expected**

AWS reads `buildspec.yml` from the root of the source when `buildspec` is not
set, or the named file otherwise ("Build specification reference for
CodeBuild", CodeBuild User Guide).

**Steps to reproduce**

```js
// buildspec.yml in the zip:
//   version: 0.2
//   phases:
//     build:
//       commands:
//         - echo building
await s3.send(new S3.PutObjectCommand({ Bucket: 'zip-test', Key: 'src.zip', Body: readFileSync('src.zip') }));
await cb.send(new CB.CreateProjectCommand({ name: 'z', source: { type: 'S3', location: 'zip-test/src.zip' }, artifacts: { type: 'NO_ARTIFACTS' },
  environment: { type: 'LINUX_CONTAINER', image: 'aws/codebuild/standard:7.0', computeType: 'BUILD_GENERAL1_SMALL' }, serviceRole: '<role trusted by codebuild.amazonaws.com>' }));
const { build } = await cb.send(new CB.StartBuildCommand({ projectName: 'z' }));
// BatchGetBuilds: DOWNLOAD_SOURCE FAILED [{"statusCode":"YAML_FILE_ERROR","message":"YAML file does not exist"}]
```

**Impact and workaround**

Workaround: put the buildspec inline in the project definition.

---

## 4. Lambda Node.js runtime: CodePipeline, CodeBuild and CloudFormation SDK clients are incomplete or misnamed

**What happened**

In a `nodejs22.x` function, the AWS SDK modules the runtime provides differ
from the published `@aws-sdk/*` packages:

- `@aws-sdk/client-codepipeline` exports `CodepipelineClient` and
  `Codepipeline`, not `CodePipelineClient` and `CodePipeline`.
  `@aws-sdk/client-codebuild` likewise exports `CodebuildClient`.
- `@aws-sdk/client-codepipeline` and `@aws-sdk/client-cloudformation` export no
  `*Command` classes (only the client, the aggregated client and the service
  exception), so `import { PutJobSuccessResultCommand } ...` fails at load with
  `Runtime.UserCodeSyntaxError: Could not find export ...`. (`client-dynamodb`
  has its commands.)
- Calling either service with the aggregated client fails with:

  ```
  NotImplemented: This emulator makes no call to cloudformation; the services it reaches are: sqs, sns, events, eventbridge, pipes, dynamodb, logs, ...
  ```

**What you expected**

The Node.js runtimes include the full AWS SDK for JavaScript v3, with
`CodePipelineClient`, `CodeBuildClient` and every command
("Building Lambda functions with Node.js", Lambda Developer Guide). A function
that a CodePipeline Invoke action calls must be able to call
`PutJobSuccessResult`.

**Steps to reproduce**

```js
// index.mjs
export const handler = async () => {
  const out = {};
  for (const m of ['client-codepipeline', 'client-cloudformation', 'client-codebuild', 'client-dynamodb']) {
    const x = await import('@aws-sdk/' + m);
    out[m] = Object.keys(x).filter((k) => /Client$|PutJobSuccessResultCommand|CreateStackCommand|GetItemCommand/.test(k));
  }
  return out;
};
// Invoke returns:
// {"client-codepipeline":["CodepipelineClient"],"client-cloudformation":["CloudFormationClient"],
//  "client-codebuild":["CodebuildClient"],"client-dynamodb":["DynamoDBClient","GetItemCommand"]}
```

**Impact and workaround**

A Lambda function cannot report a CodePipeline job result or manage stacks, so
custom pipeline actions cannot be tested. No workaround: bundling the SDK
makes functions fail with 502 in the emulator.

---

## 5. CloudFormation: AWS::CloudFront::Distribution custom origin without HTTPPort/HTTPSPort is rejected

**What happened**

A distribution whose custom origin's `CustomOriginConfig` has
`OriginProtocolPolicy: https-only` and no ports fails to create:

```
Resource handler returned message: "1 validation error detected: Value null at
'distributionConfigWithTags.distributionConfig.origins.items.2.member.customOriginConfig.hTTPPort'
failed to satisfy constraint: Member must not be null" (HandlerErrorCode: InvalidRequest)
```

After adding `HTTPPort`, the same error names `hTTPSPort`.

**What you expected**

In CloudFormation both properties are optional, with defaults 80 and 443
(`AWS::CloudFront::Distribution CustomOriginConfig`, CloudFormation User
Guide). The AWS CDK's `RestApiOrigin` and `HttpOrigin` leave them out, so every
CDK stack with an API Gateway or HTTP origin hits this.

**Steps to reproduce**

Deploy any stack with `new cloudfront.Distribution(this, 'D', { defaultBehavior: { origin: new origins.RestApiOrigin(api) } })`.

**Impact and workaround**

Workaround: `addPropertyOverride('DistributionConfig.Origins.<n>.CustomOriginConfig.HTTPPort', 80)` and the same for `HTTPSPort` with 443.

---

## 6. CloudFormation: AWS::CodePipeline::Pipeline rejects a boolean action configuration value

**What happened**

A pipeline whose S3 source action has `Configuration: { PollForSourceChanges: false }`
(a YAML/JSON boolean) fails to create:

```
Pipe CREATE_FAILED Resource handler returned message: "expected string, got boolean" (HandlerErrorCode: InvalidRequest)
```

With the string `'false'` it is created.

**What you expected**

The CodePipeline User Guide's CloudFormation examples write
`PollForSourceChanges: false` as a boolean, and CloudFormation creates those
pipelines. (I have not re-checked this against AWS.)

**Steps to reproduce**

`CreateStack` with one `AWS::CodePipeline::Pipeline` whose S3 source action's
`Configuration` has `PollForSourceChanges: false`.

**Impact and workaround**

Workaround: quote the value.

---

## 7. API Gateway: a mapping template using $context.identity returns 500

**What happened**

A REST API method with `AuthorizationType: AWS_IAM`, a MOCK integration, and
this integration response template answers 500 `Internal server error` to a
correctly signed request:

```
{"user":"$context.identity.userArn","key":"$context.identity.accessKey"}
```

The same method with the template `{"ok":true}` answers 200.

**What you expected**

`$context.identity.userArn` and `$context.identity.accessKey` are documented
mapping template variables for IAM-authorized requests ("$context variables for
data models, authorizers, mapping templates, and access logging", API Gateway
Developer Guide), and API Gateway substitutes them.

**Steps to reproduce**

`PutMethod` (`AWS_IAM`), `PutIntegration` (`MOCK`, request template
`{"statusCode": 200}`), `PutMethodResponse` 200, `PutIntegrationResponse` 200
with the template above, `CreateDeployment`, then a SigV4-signed GET.

**Impact and workaround**

Workaround: read the identity in a Lambda proxy integration instead.

---

## 8. Bedrock AgentCore: CreatePaymentConnector returns 501, so no payment can be processed

**What happened**

`CreatePaymentCredentialProvider`, `CreatePaymentManager` and
`CreatePaymentSession` succeed, but:

```
CreatePaymentConnector -> NotImplemented 501: operation CreatePaymentConnector is scaffolded but not implemented in this emulator
```

Without a connector, `CreatePaymentInstrument` cannot be called (it needs a
`paymentConnectorId`), and so neither can `ProcessPayment`.

**What you expected**

`CreatePaymentConnector` creates a connector for a manager (Amazon Bedrock
AgentCore Control API Reference). An emulated connector that signs x402
payloads without a real wallet would let agents' payment flows be tested
locally.

**Steps to reproduce**

```js
const pm = await acc.send(new ACC.CreatePaymentManagerCommand({ name: 'pm', authorizerType: 'AWS_IAM', roleArn: '<role trusted by bedrock-agentcore.amazonaws.com>' }));
await acc.send(new ACC.CreatePaymentConnectorCommand({ paymentManagerId: pm.paymentManagerId, name: 'c', type: 'CoinbaseCDP',
  credentialProviderConfigurations: [{ coinbaseCDP: { credentialProviderArn: '<from CreatePaymentCredentialProvider>' } }] }));
// NotImplemented (501)
```

**Impact and workaround**

AgentCore payments cannot be tested past creating a manager and a session.
