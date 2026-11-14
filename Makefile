# Vendor Tracker: build, deploy to AWS Emulator, and test.
#
# Two ways to run, chosen by USE_CONTAINER:
#
#   USE_CONTAINER=1  (default on macOS) Everything runs in one dev container
#                    holding AWS Emulator, Node.js and the test browser. The
#                    host needs only `make` and a container runtime (Apple's
#                    `container`, or Docker). See scripts/dev-container.sh.
#   USE_CONTAINER=0  (default elsewhere) Node.js runs on the host. The emulator
#                    runs in Docker on GitHub Actions and as a native process
#                    in Claude Code cloud sessions. See scripts/emulator.sh.

SHELL := /bin/bash
.DEFAULT_GOAL := help

export EMULATOR_PORT ?= 9297
export EMULATOR_TELEMETRY ?= off

USE_CONTAINER ?= $(if $(filter Darwin,$(shell uname -s)),1,0)
ifdef INSIDE_DEV_CONTAINER
override USE_CONTAINER := 0
endif

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo; if [ "$(USE_CONTAINER)" = 1 ]; then echo "  Targets run inside the dev container (USE_CONTAINER=1)."; \
	  else echo "  Targets run on this machine (USE_CONTAINER=0); emulator runtime: $$(scripts/emulator.sh runtime)"; fi

# ---- Dev container (host side) ------------------------------------------------

DEV := scripts/dev-container.sh

.PHONY: dev-build
dev-build: ## Build the dev container image (emulator + Node.js)
	$(DEV) build

.PHONY: dev-up
dev-up: ## Start the dev container (other targets start it on demand)
	$(DEV) up

.PHONY: dev-down
dev-down: ## Stop the dev container (all emulated resources are lost)
	$(DEV) down

ifeq ($(USE_CONTAINER),1)

# Forward every other target into the dev container, starting it if needed,
# along with variables given on the command line (e.g. EMAIL=...).
HOST_TARGETS := help dev-build dev-up dev-down
FORWARDED := $(filter-out $(HOST_TARGETS),$(MAKECMDGOALS))
ifneq ($(FORWARDED),)
.PHONY: $(FORWARDED)
$(FORWARDED):
	@$(DEV) exec make --no-print-directory $@ $(MAKEOVERRIDES)
endif

else

EMULATOR := scripts/emulator.sh
EMU := $(EMULATOR) run
CDK := npx cdk
ACCOUNT := 000000000000# the emulator's single account
REGION := us-east-1

# ---- Build ------------------------------------------------------------------

node_modules: package.json package-lock.json
	npm ci
	@touch node_modules

.PHONY: install
install: node_modules ## Install dependencies

.PHONY: build
build: node_modules ## Build the frontend into dist/frontend
	node scripts/build-frontend.ts

.PHONY: typecheck
typecheck: node_modules ## Type-check all TypeScript
	npx tsc --noEmit

.PHONY: synth
synth: build ## Synthesize the CloudFormation template (as deployed to AWS)
	$(CDK) synth --quiet

# ---- AWS Emulator -----------------------------------------------------------

.PHONY: emulator-build
emulator-build: ## Build the emulator image (or install the native package)
	$(EMULATOR) build

.PHONY: emulator-up
emulator-up: ## Start the emulator and wait until it is healthy
	$(EMULATOR) up

.PHONY: emulator-down
emulator-down: ## Stop the emulator (all emulated resources are lost)
	$(EMULATOR) down

.PHONY: emulator-status
emulator-status: ## Show whether the emulator is running
	@$(EMULATOR) status

.PHONY: emulator-logs
emulator-logs: ## Print the emulator log
	@$(EMULATOR) logs

.PHONY: deploy
deploy: build ## Deploy the stack and the frontend to the running emulator
	$(EMU) $(CDK) bootstrap aws://$(ACCOUNT)/$(REGION)
	$(EMU) $(CDK) deploy --context emulator=true --require-approval never
	$(EMU) node scripts/publish-site.ts

.PHONY: serve
serve: ## Serve the deployed app from the emulator at http://127.0.0.1:8080
	$(EMU) node scripts/local-gateway.ts

.PHONY: confirm-user
confirm-user: ## Confirm a user who signed up in the UI: make confirm-user EMAIL=you@example.com
	@$(EMU) node scripts/confirm-user.ts "$(EMAIL)"

.PHONY: shell
shell: ## Open a shell with AWS tools pointed at the emulator
	$(EMU) $(SHELL)

# ---- Tests ------------------------------------------------------------------

.PHONY: test-unit
test-unit: node_modules ## Unit tests (no emulator)
	npm run test:unit

.PHONY: snapshots
snapshots: node_modules ## Accept infrastructure changes: rewrite the template snapshots in test/unit/__snapshots__
	UPDATE_SNAPSHOTS=1 node --test test/unit/snapshot.test.ts

.PHONY: test-functional
test-functional: node_modules ## Functional tests against the emulator's DynamoDB and Cognito
	$(EMU) npm run test:functional

.PHONY: test-smoke
test-smoke: node_modules ## Smoke tests of the deployed stack
	$(EMU) npm run test:smoke

# In the dev container the browser is installed into the mounted repository
# (.cache/), matching the Playwright version in package.json. Elsewhere the
# host provides it (`npx playwright install chromium`).
.PHONY: browser
browser: node_modules
ifdef INSIDE_DEV_CONTAINER
	npx playwright install chromium
endif

.PHONY: test-e2e
test-e2e: node_modules browser ## Browser end-to-end tests of the deployed app
	$(EMU) npm run test:e2e

.PHONY: test-emulator
test-emulator: test-functional deploy test-smoke test-e2e ## Deploy, then run every emulator-backed suite

.PHONY: test
test: typecheck test-unit ## Everything: start the emulator, deploy, run all suites, stop
	$(EMULATOR) build
	$(EMULATOR) up
	@trap '$(EMULATOR) down' EXIT; $(MAKE) --no-print-directory test-emulator

.PHONY: report
report: node_modules ## Print the test and emulator report (appended to the GitHub job summary in CI)
	@if $(EMULATOR) status >/dev/null 2>&1; then $(EMU) node scripts/ci-report.ts; else node scripts/ci-report.ts; fi

# ---- AWS ---------------------------------------------------------------------

# STAGE=dev|test|uat|prod deploys VendorStack-<stage> (prod keeps its data);
# without it, VendorStack. The deploy workflow (.github/workflows/deploy.yml)
# runs the same commands.
STAGE_CONTEXT = $(if $(STAGE),--context stage=$(STAGE))
STACK_NAME = VendorStack$(if $(STAGE),-$(STAGE))

.PHONY: aws-deploy
aws-deploy: build ## Deploy to a real AWS account (uses your AWS credentials): make aws-deploy [STAGE=dev]
	$(CDK) deploy $(STACK_NAME) $(STAGE_CONTEXT)

.PHONY: aws-verify
aws-verify: node_modules ## Check a deployed stack through CloudFront: make aws-verify [STAGE=dev]
	STACK_NAME=$(STACK_NAME) node scripts/verify-deployment.ts

.PHONY: aws-destroy
aws-destroy: ## Remove the stack from the real AWS account: make aws-destroy [STAGE=dev]
	$(CDK) destroy $(STACK_NAME) $(STAGE_CONTEXT)

.PHONY: aws-github-setup
aws-github-setup: node_modules ## One-time, per account: roles for the deploy workflow: make aws-github-setup REPOSITORY=owner/name ENVIRONMENTS=dev,test [OIDC_PROVIDER_ARN=...]
	@test -n "$(REPOSITORY)" -a -n "$(ENVIRONMENTS)" || { echo "usage: make aws-github-setup REPOSITORY=owner/name ENVIRONMENTS=dev,test"; exit 1; }
	$(CDK) --app 'node infra/github-deploy-app.ts' --output cdk.out.github deploy \
	  --context repository=$(REPOSITORY) --context environments=$(ENVIRONMENTS) \
	  $(if $(OIDC_PROVIDER_ARN),--context oidcProviderArn=$(OIDC_PROVIDER_ARN))

.PHONY: clean
clean: ## Remove build output
	rm -rf dist cdk.out cdk.out.github .emulator reports/*.xml

endif
