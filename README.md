# Vendor Tracker: a tested serverless AWS reference

A small full-stack AWS app, built as a reference for how to structure, secure,
test and ship a serverless project with the AWS CDK. Everything is tested
locally against [AWS Emulator](https://docs.aws.amazon.com/emulator/latest/userguide/what-is-service.html):
no AWS account is needed to build, run or test it.

The app itself is deliberately simple: it is the one from freeCodeCamp's
[full-stack AWS tutorial](https://www.freecodecamp.org/news/full-stack-aws-react-lambda-dynamodb-tutorial/),
where signed-in users add, view and delete their vendors (name, category,
contact email). What the repository shows is the rest:

- **Local-first testing against AWS Emulator.** Unit, functional, smoke and
  browser end-to-end suites, run the same way on a laptop, in a dev container
  and in GitHub Actions. The emulator's differences from AWS found along the
  way are worked around in one place each, and written up in
  [`docs/emulator-issues.md`](docs/emulator-issues.md).
- **Infrastructure tests.** Fine-grained CDK assertions, [cdk-nag](https://github.com/cdklabs/cdk-nag)
  policy checks with every exception acknowledged next to its resource with a
  reason, and per-stage template snapshots.
- **A locked-down edge.** The site comes from a private bucket through
  CloudFront; the API is on the same origin and answers only CloudFront (a
  generated secret header, enforced by WAF); Cognito authorizes each request
  and every user's data is confined to their own DynamoDB partition.
- **Keyless deploys.** A GitHub Actions workflow promotes each commit through
  dev, test, uat and prod with approvals, using GitHub's OIDC tokens and one
  narrowly scoped IAM role per environment; prod keeps its data.

| Piece | Implementation |
| --- | --- |
| Frontend | Native web components in TypeScript (no framework), bundled with esbuild |
| Auth | Amazon Cognito user pool, called directly with `fetch` |
| API | API Gateway REST API with a Cognito authorizer: `GET`/`POST`/`DELETE /api/vendors` |
| Logic | Three Lambda functions (Node.js 26) |
| Data | DynamoDB table keyed by owner and vendor (`ownerId`, `vendorId`): each user sees and changes only their own vendors |
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
| Unit | `make test-unit` | nothing | Lambda logic with a fake DynamoDB client; the frontend's API and auth layers with a fake `fetch`; the infrastructure (see below) |
| Functional | `make test-functional` | emulator | The Lambda handlers in-process against emulated DynamoDB, including that users' vendors are kept apart; the frontend's Cognito client against an emulated user pool |
| Smoke | `make test-smoke` | emulator + `make deploy` | The deployed stack: outputs, table, site bucket, CloudFront (site and API), 401 without or with a forged token, WAF blocking direct API calls, one authenticated round trip through API Gateway, Lambda and DynamoDB, and two users who can't see or delete each other's vendors |
| End-to-end | `make test-e2e` | emulator + `make deploy` | Chromium (Playwright) drives the deployed web components: sign-up, confirmation, sign-in, add/reload/delete a vendor, sign-out, expired session, layout |

### Infrastructure tests

The CDK app is tested at three levels, all in the unit suite (no AWS, no emulator):

- **Assertions** (`test/unit/stack.test.ts`) on what matters: the table keys,
  least-privilege grants, the authorizer on every method, the WAF rule and its
  generated secret, the CloudFront behaviors and cache policy, prod data
  retention, the GitHub deploy roles' trust conditions.
- **Policy checks** (`test/unit/nag.test.ts`): [cdk-nag](https://github.com/cdklabs/cdk-nag)'s
  AWS Solutions rules against every stage and the deploy roles. Each finding
  is either fixed or acknowledged next to its resource with a reason
  (`acknowledge(...)` in `infra/vendor-stack.ts`), so the trade-offs are in the
  code and in review. The same checks run in `infra/app.ts`, so `cdk synth`,
  `cdk diff` and every deploy fail on a new, unacknowledged finding. A canary
  test makes sure the checks are live.
- **Snapshots** (`test/unit/snapshot.test.ts`) of each stage's template in
  `test/unit/__snapshots__/`. Any infrastructure change fails until accepted
  with `make snapshots`, so it shows up in the pull request as a template
  diff. Content hashes are masked, so code changes don't churn them. The same
  test checks that every stage synthesizes without CDK warnings, and that dev,
  test and uat have the same resources while prod adds retention.

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
2. Every API request goes to `/api/vendors` on the site's own origin, with
   the token in `Authorization`. CloudFront forwards it to the API Gateway
   stage, adding `X-Origin-Verify`.
3. The stage's WAF web ACL blocks any request without that secret header, so
   calling `execute-api` directly fails even with a valid token.
4. API Gateway's **Cognito authorizer** checks the token's signature, expiry
   and issuer, and passes its claims to the Lambda.
5. The Lambda uses the token's `sub` (the user's id) as `ownerId`. The table
   is keyed by `(ownerId, vendorId)`, and every read, write and delete is
   confined to the caller's own partition. Deleting another user's vendor id
   matches nothing, and the API never returns `ownerId`.

Because the API is same-origin, there is no CORS configuration. CloudFront
forwards `Authorization` only when the cache policy names it, so the API
behavior's cache policy includes it, with a TTL of 0: nothing is served from
the cache, and a response could never be served to another user.

## How the app reaches the emulator

The emulator serves every AWS API on one local HTTPS endpoint. On AWS, a
browser reaches CloudFront and Cognito by DNS name. Locally,
`scripts/local-gateway.ts` (`make serve`) stands in for those names:

| Path | On AWS | Locally |
| --- | --- | --- |
| `/` | CloudFront in front of the site bucket | Objects read from the emulated site bucket; unknown paths get `index.html` |
| `/api/*` | CloudFront → `https://<id>.execute-api.<region>.amazonaws.com/prod/api/*`, with `X-Origin-Verify` | Forwarded to the emulator with that `Host` header and the secret, read from emulated Secrets Manager |
| `/cognito` | `https://cognito-idp.<region>.amazonaws.com/` | Forwarded to the emulator |

The emulator's CloudFront does serve traffic, and the smoke tests check that
the site comes from the private bucket through it and that it gets past the
WAF to the API. They reach the distribution through the emulator's main port,
at `/_aws/cloudfront/<distribution id>/`: each distribution also gets a
listener on a random port of its own (the `CloudFrontURL` output), but a
container runtime publishes only the main port. The emulator's CloudFront
drops the `Authorization` header, though, so authenticated requests go through
the local gateway instead.

The frontend reads its API URL and Cognito IDs from `config.json` at
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
- **CloudFront fails the bucket's `aws:SecureTransport` deny** when reading
  through origin access control, so the site bucket enforces HTTPS on AWS
  only (`enforceSSL` is off in emulator mode).
- **The emulator does enforce WAF rules, IAM policies and API resource
  policies**, although its documentation says policies are not evaluated.
  Don't rely on that for security testing.

## Differences from the tutorial

- Native web components instead of Next.js/React, and direct Cognito calls
  (`USER_PASSWORD_AUTH`) instead of Amplify. The user pool client enables that
  flow.
- `config.json` at runtime replaces build-time `NEXT_PUBLIC_*` variables.
- Vendors belong to the user who added them; the tutorial shares one list
  between all signed-in users.
- `createVendor` validates its input and answers 400 instead of 500.
- `getVendors` follows DynamoDB pagination.
- Node.js 26 Lambda runtime, and `S3BucketOrigin` with origin access control
  in place of the deprecated `S3Origin`.

## Deploying to AWS

Deploying creates billable resources in your AWS account.

### From your machine

```bash
npx cdk bootstrap        # once per account and region
make aws-deploy          # or STAGE=dev make aws-deploy for VendorStack-dev
make aws-verify          # checks the deployment through CloudFront
make aws-destroy         # removes it (prod keeps its table, user pool and bucket)
```

### From GitHub Actions

`.github/workflows/deploy.yml` runs after CI passes on `main` and promotes the
same commit through four GitHub environments: **dev → test → uat → prod**.
Each deploy shows the `cdk diff` in the job summary, deploys
`VendorStack-<environment>` and runs `scripts/verify-deployment.ts`, which
checks that:

- the site loads through CloudFront;
- CloudFront reaches the API;
- calling the API directly is blocked.

You can also run it by hand (Actions → Deploy → Run workflow) to deploy one
environment from `main`.

The workflow holds no AWS keys. Each job exchanges GitHub's OIDC token for an
IAM role that only this repository's jobs in that GitHub environment can
assume. No AWS CodeConnections connection is needed; that is only for
CodePipeline.

`prod` keeps its data: the table (with point-in-time recovery), user pool and
site bucket are retained if the stack is deleted, and have deletion
protection. The other stages delete everything with the stack.

#### One-time setup

1. **AWS accounts.** One account per environment is recommended (AWS
   Organizations); stages can also share an account, since every resource
   name includes the stage.
2. **In each account**, with administrator credentials for it:

   ```bash
   npx cdk bootstrap
   make aws-github-setup REPOSITORY=owner/name ENVIRONMENTS=dev   # the environments this account hosts, e.g. dev,test
   ```

   This creates GitHub's OIDC identity provider and a role
   `vendor-tracker-deploy-<environment>` per environment. The role can only
   assume the CDK bootstrap roles and read its stack. If the account already
   has a GitHub OIDC provider, add `OIDC_PROVIDER_ARN=arn:aws:iam::...`. The
   stack's `DeployRoleArn-<environment>` outputs are the role ARNs.
3. **In GitHub** (Settings → Environments), create `dev`, `test`, `uat` and
   `prod`. In each:
   - **Variables:** `AWS_DEPLOY_ROLE_ARN` (from step 2) and `AWS_REGION`.
   - **Deployment branches and tags:** selected branches, `main` only.
   - **Required reviewers** on `test`, `uat` and `prod`, so the promotion
     waits for an approval before each. Turn on **Prevent self-review** for
     `prod`.

#### Rotating the origin secret

CloudFormation copies the `X-Origin-Verify` secret into the distribution and
the WAF rule when it updates them, so Secrets Manager's automatic rotation
would not reach them, and changing the value and redeploying an unchanged
template would not either. To rotate, replace the secret: rename its construct
id in `infra/vendor-stack.ts` (`OriginVerifySecret` → `OriginVerifySecret2`)
and deploy. CloudFormation creates a new secret with a new value, updates WAF
and CloudFront to it, then deletes the old one. WAF updates in seconds while
CloudFront takes minutes to propagate, so API calls can be refused for a few
minutes: do it at a quiet time. The snapshot test shows the change for review.

Reviewers approve before the job runs, so the change summary for an
environment appears after approval; the dev run's summary shows the same
commit's diff against dev.

## Layout

```
Containerfile            AWS Emulator image, and the dev image (emulator + Node.js)
Makefile                 every task
infra/                   CDK app and stack
src/lambda/              Lambda handlers
src/frontend/            web components, API and auth clients
docs/emulator-issues.md  emulator differences from AWS, written up for its issue tracker
scripts/dev-container.sh runs the toolchain in the dev container (macOS)
scripts/emulator.sh      emulator lifecycle for each runtime
scripts/local-gateway.ts local stand-in for CloudFront and Cognito DNS names
scripts/publish-site.ts  uploads the frontend to the emulated site bucket
scripts/ci-report.ts     test and emulator report for the job summary
scripts/verify-deployment.ts  post-deploy check of a deployed stack, through CloudFront
infra/github-deploy-*.ts one-time per-account roles for the GitHub Actions deploy workflow
.github/workflows/       CI (ci.yml), and the deploy chain (deploy.yml, deploy-stage.yml)
test/{unit,functional,smoke,e2e}/
```
