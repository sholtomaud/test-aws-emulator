# Vendor Tracker: build, deploy to AWS Emulator, and test.
#
# The emulator runs in Apple's `container` on macOS, in Docker on GitHub
# Actions, and as a native process in Claude Code cloud sessions. See
# scripts/emulator.sh; override with EMULATOR_RUNTIME=container|docker|podman|native.

SHELL := /bin/bash
.DEFAULT_GOAL := help

export EMULATOR_PORT ?= 9297
export EMULATOR_TELEMETRY ?= off

EMULATOR := scripts/emulator.sh
EMU := $(EMULATOR) run
CDK := npx cdk
ACCOUNT := 000000000000# the emulator's single account
REGION := us-east-1

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo; echo "  Emulator runtime here: $$($(EMULATOR) runtime)"

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

.PHONY: shell
shell: ## Open a shell with AWS tools pointed at the emulator
	$(EMU) $(SHELL)

# ---- Tests ------------------------------------------------------------------

.PHONY: test-unit
test-unit: node_modules ## Unit tests (no emulator)
	npm run test:unit

.PHONY: test-functional
test-functional: node_modules ## Functional tests against the emulator's DynamoDB and Cognito
	$(EMU) npm run test:functional

.PHONY: test-smoke
test-smoke: node_modules ## Smoke tests of the deployed stack
	$(EMU) npm run test:smoke

.PHONY: test-e2e
test-e2e: node_modules ## Browser end-to-end tests of the deployed app
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

.PHONY: aws-deploy
aws-deploy: build ## Deploy to a real AWS account (uses your AWS credentials)
	$(CDK) deploy

.PHONY: aws-destroy
aws-destroy: ## Remove the stack from the real AWS account
	$(CDK) destroy

.PHONY: clean
clean: ## Remove build output
	rm -rf dist cdk.out .emulator reports/*.xml
