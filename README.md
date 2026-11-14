# Vendor Tracker

A full-stack AWS app, deployed with the AWS CDK and tested locally against
[AWS Emulator](https://docs.aws.amazon.com/emulator/latest/userguide/what-is-service.html).
No AWS account is needed to build, run or test it.

It implements the app from freeCodeCamp's
[full-stack AWS tutorial](https://www.freecodecamp.org/news/full-stack-aws-react-lambda-dynamodb-tutorial/):
signed-in users add, view and delete vendors (name, category, contact email).

| Piece | Implementation |
| --- | --- |
| Frontend | Native web components in TypeScript (no framework), bundled with esbuild |
| Auth | Amazon Cognito user pool for sign-in, and an identity pool that swaps the ID token for temporary AWS credentials; both called directly with `fetch` |
| API | API Gateway REST API with IAM auth: `GET`/`POST`/`DELETE /api/vendors`, signed in the browser with SigV4 (Web Crypto, no SDK) |
| Logic | Three Lambda functions (Node.js 26) |
| Data | DynamoDB table keyed by `vendorId` |
| Hosting | Private S3 bucket behind CloudFront (origin access control); the API on the same distribution under `/api/*` |
| Edge protection | The API answers only CloudFront: CloudFront adds a secret header (generated in Secrets Manager) and a WAF web ACL on the stage blocks requests without it |
| Infrastructure | AWS CDK, in TypeScript |

All TypeScript outside the browser runs **natively in Node.js** (type
stripping, Node 22.18 or later): the CDK app, the scripts and the tests have
no compile step. `tsc` is used only to type-check.

## Quick start

```bash
make test
```

That installs dependencies, starts the emulator, deploys the stack to it, runs
every test suite and stops the emulator (about a minute, after the first run).

To use the app in a browser:

```bash
make emulator-up deploy
make serve          # http://127.0.0.1:8080
```

Sign up in the UI, then confirm the account from a second terminal (the
emulator sends no verification email) and sign in:

```bash
make confirm-user EMAIL=you@example.com
```

`make help` lists every target.

## Where things run

`USE_CONTAINER` chooses between two setups.

### macOS: everything in one container (`USE_CONTAINER=1`, the default on macOS)

The laptop needs only `make` and a container runtime. No Node.js or npm on the
host. This is tested on an Apple silicon Mac with Apple's `container` CLI.

The `dev` target of the `Containerfile` is the AWS Emulator image (Amazon
Linux 2023) plus Node.js and the libraries the test browser needs. The
emulator is the container's main process, and every `make` target is forwarded
into that container.

#### One-time setup with Apple `container`

1. Install Apple's [`container`](https://github.com/apple/container) CLI from
   its [releases page](https://github.com/apple/container/releases) (a signed
   installer package). It needs an Apple silicon Mac; see its README for the
   macOS version it supports.
2. `make` comes with the Xcode Command Line Tools (`xcode-select --install`).
3. Start the container service once. The scripts also start it when it is not
   running, but the first start asks to install a Linux kernel, which is
   easier to answer in your own terminal:

   ```bash
   container system start
   ```

#### Run it

```bash
make test
```

The first run builds the dev image, installs `node_modules` and downloads the
test browser, so it takes a few minutes. Later runs take about a minute.

Day to day:

```bash
make synth          # any target runs inside the dev container
make deploy         # deploy the stack and frontend to the emulator
make serve          # the app, on http://127.0.0.1:8080 (Ctrl+C to stop)
make confirm-user EMAIL=you@example.com   # after signing up in the UI
make shell          # a shell in the container, pointed at the emulator
make dev-down       # stop the container; emulated resources are lost
```

The container starts on demand and keeps running, with the emulator's state,
until `make dev-down`. `make dev-build` rebuilds the image, for example to
pick up a newer emulator release.

#### What to expect

- **Files in the working tree.** The repository is mounted at `/work`, so
  `node_modules`, `dist`, `cdk.out` and the test browser (`.cache/`) appear in
  the checkout as Linux builds. If a macOS Node.js created `node_modules`
  earlier, delete it first.
- **One container, not two.** The tools share a container with the emulator
  because the emulator's TLS certificate is only valid for `localhost`.
- **Ports.** Only the app is published, on `127.0.0.1:8080`. The emulator's
  port stays inside the container. To use another port, stop the container
  and start it with `SERVE_PORT=9000 make serve`.
- **Emulator log.** `make emulator-logs`, or read `.emulator/emulator.log`.
- **Docker instead.** `DEV_RUNTIME=docker make test` runs the same image and
  targets on Docker; it is also what happens when `container` is not installed.
- **Node.js on the Mac instead.** `USE_CONTAINER=0 make test` runs the tools
  on the host and only the emulator in a container.

### Elsewhere: Node.js on the host (`USE_CONTAINER=0`)

`scripts/emulator.sh` picks how the emulator runs; set `EMULATOR_RUNTIME` to
override.

| Where | Runtime | How |
| --- | --- | --- |
| GitHub Actions | `docker` | Docker builds and runs the `emulator` target of the `Containerfile` |
| Claude Code cloud session | `native` | Installs the emulator's Linux package and runs it as a process (no image pull or daemon needed) |
| Other Linux | `docker`, else `podman`, else `native` | |
| macOS with `USE_CONTAINER=0` | `container`, else `docker` | Needs Node.js 22.18+ on the laptop |

Set `USE_CONTAINER=1` on Linux to use the dev container there too; CI runs
every suite that way as a third job.

AWS publishes no prebuilt image; the `Containerfile` installs the Linux
package, as the
[emulator's Docker guide](https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html)
describes. In this setup the emulator listens on `127.0.0.1:9297` only and
writes its per-run credentials and TLS certificate to `~/.aws/emulator/9297/`.

Telemetry is off by default in both setups (`EMULATOR_TELEMETRY=on` to enable).

## Tests

All suites use Node's built-in test runner.

| Suite | Command | Needs | What it covers |
| --- | --- | --- | --- |
| Unit | `make test-unit` | nothing | Lambda logic with a fake DynamoDB client; the frontend's API and auth layers with a fake `fetch`; the synthesized CloudFormation template |
| Functional | `make test-functional` | emulator | The Lambda handlers in-process against emulated DynamoDB; the frontend's Cognito client against an emulated user pool and identity pool |
| Smoke | `make test-smoke` | emulator + `make deploy` | The deployed stack: outputs, table, site bucket, 401 without a token, one authenticated round trip through API Gateway, Lambda and DynamoDB |
| End-to-end | `make test-e2e` | emulator + `make deploy` | Chromium (Playwright) drives the deployed web components: sign-up, confirmation, sign-in, add/reload/delete a vendor, sign-out, expired session, layout |

Each suite also writes a JUnit report to `reports/`. `make report` turns those
into a Markdown report with the test results and an emulator section: its
version and runtime, the resources the stack deployed into it, and its
warnings and log. In GitHub Actions the report is appended to the job summary
(`$GITHUB_STEP_SUMMARY`); locally it is printed.

Scripts and tests refuse to run unless `AWS_ENDPOINT_URL` points at this
machine, and `scripts/emulator.sh run` removes real AWS credentials from the
environment, so a test run cannot reach AWS.

## How requests are authorized

1. The user signs in to the Cognito **user pool** (`USER_PASSWORD_AUTH`) and
   gets an ID token.
2. The app exchanges the token at the Cognito **identity pool**
   (`GetId`, `GetCredentialsForIdentity`) for temporary credentials of the
   pool's authenticated role. That role may call only `GET`, `POST` and
   `DELETE` on `/api/vendors` (`execute-api:Invoke`).
3. Every API request is signed with SigV4 (`src/frontend/lib/sigv4.ts`) and
   sent to `/api/vendors` on the site's own origin. CloudFront forwards it to
   the API Gateway stage, adding `X-Origin-Verify`. The signature is computed
   for the host and path API Gateway receives
   (`<id>.execute-api.<region>.amazonaws.com/prod/api/vendors`, from
   `apiSigningUrl` in `config.json`), which is why it still verifies after
   CloudFront.
4. The stage's WAF web ACL blocks any request without the secret header, so
   calling `execute-api` directly fails even with a valid signature. API
   Gateway then checks the signature and the caller's IAM permissions.

Because the API is same-origin, there is no CORS configuration. The API
behavior's cache policy includes `Authorization`, `X-Amz-Date` and
`X-Amz-Security-Token` (CloudFront forwards `Authorization` only when the cache
policy names it) with a TTL of 0, so nothing is served from the cache.

## How the app reaches the emulator

The emulator serves every AWS API on one local HTTPS endpoint. On AWS, a
browser reaches CloudFront and Cognito by DNS name. Locally,
`scripts/local-gateway.ts` (`make serve`) stands in for those names:

| Path | On AWS | Locally |
| --- | --- | --- |
| `/` | CloudFront in front of the site bucket | Objects read from the emulated site bucket; unknown paths get `index.html` |
| `/api/*` | CloudFront → `https://<id>.execute-api.<region>.amazonaws.com/prod/api/*`, with `X-Origin-Verify` | Forwarded to the emulator with that `Host` header and the secret, read from emulated Secrets Manager |
| `/cognito` | `https://cognito-idp.<region>.amazonaws.com/` | Forwarded to the emulator |
| `/cognito-identity` | `https://cognito-identity.<region>.amazonaws.com/` | Forwarded to the emulator |

The emulator's CloudFront does serve traffic, and the smoke tests check that
the site comes from the private bucket through it and that it gets past the
WAF to the API. But it drops the `Authorization` header, so signed requests go
through the local gateway instead.

The frontend reads its API URLs and Cognito IDs from `config.json` at
startup, so the same build runs in both places.

## Differences from AWS when deploying to the emulator

Found with AWS Emulator 1.0.345 and rechecked with 1.0.353. `make deploy`
passes `--context emulator=true` to work around the first; the stack is
otherwise the one deployed to AWS. These and the other gaps found while
testing (CodePipeline, CodeBuild, Lambda's bundled SDK, AgentCore payments)
are written up, ready to file, in
[`docs/emulator-issues.md`](docs/emulator-issues.md).

- **Lambda-backed custom resources never complete.** The emulator invokes the
  function but the resource stays `CREATE_IN_PROGRESS`. In emulator mode the
  stack leaves out the `BucketDeployment` and S3 `autoDeleteObjects`, and
  `scripts/publish-site.ts` uploads the frontend instead.
- **Lambda permission statement IDs are not truncated** to 100 characters as
  CloudFormation does on AWS. The construct IDs of the API and its resources
  are kept short (`Api`, `A`, `V`) and `allowTestInvoke` is off; a unit test
  guards the length.
- **The AWS SDK must come from the Lambda runtime.** Functions that bundle the
  SDK (`bundleAwsSDK`) fail with 502 in the emulator.
- **CloudFront custom origins need `HTTPPort` and `HTTPSPort`**, which are
  optional on AWS. The stack sets them on the API origin.
- **CloudFront drops the viewer's `Authorization` header** and ignores
  `DefaultRootObject`, hence the local gateway (see above).
- **The emulator does enforce IAM auth, IAM policies, API resource policies
  and WAF rules**, although its documentation says policies are not
  evaluated. Don't rely on that for security testing.

## Differences from the tutorial

- Native web components instead of Next.js/React, and direct Cognito calls
  (`USER_PASSWORD_AUTH`) instead of Amplify. The user pool client enables that
  flow.
- `config.json` at runtime replaces build-time `NEXT_PUBLIC_*` variables.
- `createVendor` validates its input and answers 400 instead of 500.
- `getVendors` follows DynamoDB pagination.
- Node.js 26 Lambda runtime, and `S3BucketOrigin` with origin access control
  in place of the deprecated `S3Origin`.

## Deploying to AWS

```bash
npx cdk bootstrap   # once per account and region
make aws-deploy
```

This uses your own AWS credentials and creates billable resources.
`make aws-destroy` removes them.

## Layout

```
Containerfile            AWS Emulator image, and the dev image (emulator + Node.js)
Makefile                 every task
infra/                   CDK app and stack
src/lambda/              Lambda handlers
src/frontend/            web components, API and auth clients, SigV4 signer
docs/emulator-issues.md  emulator differences from AWS, written up for its issue tracker
scripts/dev-container.sh runs the toolchain in the dev container (macOS)
scripts/emulator.sh      emulator lifecycle for each runtime
scripts/local-gateway.ts local stand-in for CloudFront and Cognito DNS names
scripts/publish-site.ts  uploads the frontend to the emulated site bucket
scripts/ci-report.ts     test and emulator report for the job summary
test/{unit,functional,smoke,e2e}/
```
