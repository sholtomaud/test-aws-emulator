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
| Auth | Amazon Cognito user pool, called directly with `fetch` |
| API | API Gateway REST API with a Cognito authorizer: `GET`/`POST`/`DELETE /vendors` |
| Logic | Three Lambda functions (Node.js 22) |
| Data | DynamoDB table keyed by `vendorId` |
| Hosting | Private S3 bucket behind CloudFront |
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

The laptop needs only `make` and Apple's
[`container`](https://github.com/apple/container) CLI (or Docker). No Node.js
or npm on the host.

The `dev` target of the `Containerfile` is the AWS Emulator image (Amazon
Linux 2023) plus Node.js and the libraries the test browser needs. The
emulator is the container's main process; every `make` target is forwarded
into that container, which starts on demand:

```bash
make synth          # runs `make synth` inside the dev container
make test
make serve          # published on http://127.0.0.1:8080
make dev-down       # stop the container; emulated resources are lost
```

The repository is mounted at `/work`, so `node_modules`, `dist`, `cdk.out` and
the test browser (`.cache/`) appear in the working tree as Linux builds. The
tools share a container with the emulator, rather than using a second one,
because the emulator's TLS certificate is only valid for `localhost`. Its port
is not published: only the app on port 8080 is.

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
| Functional | `make test-functional` | emulator | The Lambda handlers in-process against emulated DynamoDB; the frontend's Cognito client against an emulated user pool |
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

## How the app reaches the emulator

The emulator serves every AWS API on one local HTTPS endpoint. On AWS, a
browser reaches CloudFront, API Gateway and Cognito by DNS name. Locally,
`scripts/local-gateway.ts` (`make serve`) stands in for those names:

| Path | On AWS | Locally |
| --- | --- | --- |
| `/` | CloudFront in front of the site bucket | Objects read from the emulated site bucket; unknown paths get `index.html` |
| `/api/*` | `https://<id>.execute-api.<region>.amazonaws.com/prod/*` | Forwarded to the emulator with that `Host` header |
| `/cognito` | `https://cognito-idp.<region>.amazonaws.com/` | Forwarded to the emulator |

The frontend reads its API URL and Cognito IDs from `config.json` at startup,
so the same build runs in both places.

## Differences from AWS when deploying to the emulator

Found with AWS Emulator 1.0.345. `make deploy` passes `--context emulator=true`
to work around the first; the stack is otherwise the one deployed to AWS.

- **Lambda-backed custom resources never complete.** The emulator invokes the
  function but the resource stays `CREATE_IN_PROGRESS`. In emulator mode the
  stack leaves out the `BucketDeployment` and S3 `autoDeleteObjects`, and
  `scripts/publish-site.ts` uploads the frontend instead.
- **Lambda permission statement IDs are not truncated** to 100 characters as
  CloudFormation does on AWS. The API's construct ID is kept short (`Api`) and
  `allowTestInvoke` is off; a unit test guards the length.
- **The AWS SDK must come from the Lambda runtime.** Functions that bundle the
  SDK (`bundleAwsSDK`) fail with 502 in the emulator.
- **CloudFront is control-plane only**: the distribution is created but serves
  no traffic, hence the local gateway.
- **CORS preflight is not exercised**: the emulator refuses requests carrying
  a cross-site `Origin`, and the local gateway is same-origin.

## Differences from the tutorial

- Native web components instead of Next.js/React, and direct Cognito calls
  (`USER_PASSWORD_AUTH`) instead of Amplify. The user pool client enables that
  flow.
- `config.json` at runtime replaces build-time `NEXT_PUBLIC_*` variables.
- `createVendor` validates its input and answers 400 instead of 500.
- `getVendors` follows DynamoDB pagination.
- Node.js 22 Lambda runtime, and `S3BucketOrigin` with origin access control
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
src/frontend/            web components, API and auth clients
scripts/dev-container.sh runs the toolchain in the dev container (macOS)
scripts/emulator.sh      emulator lifecycle for each runtime
scripts/local-gateway.ts local stand-in for CloudFront, API Gateway and Cognito DNS names
scripts/publish-site.ts  uploads the frontend to the emulated site bucket
scripts/ci-report.ts     test and emulator report for the job summary
test/{unit,functional,smoke,e2e}/
```
