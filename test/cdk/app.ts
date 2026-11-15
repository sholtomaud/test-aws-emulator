// Helpers shared by the CDK tests.
import { App } from 'aws-cdk-lib';
import type { AppProps } from 'aws-cdk-lib';

/**
 * A CDK app for tests, with Lambda bundling switched off: these tests check
 * the infrastructure, not the code, and the templates do not depend on it
 * (the snapshots mask asset hashes). The bundles are built for real by
 * `make deploy`, and run by the smoke and end-to-end tests on AWS Emulator.
 */
export const testApp = (props: AppProps = {}): App =>
  new App({ ...props, context: { 'aws:cdk:bundling-stacks': [], ...props.context } });

/**
 * Runs `fn` with its console output captured instead of printed, and returns
 * it. For synths whose findings are expected (the cdk-nag canary), so that any
 * error printed in the test log is a real one. `fn` must be synchronous, as
 * `app.synth()` is.
 */
export const quietly = (fn: () => void): string => {
  let captured = '';
  const capture = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  return captured;
};
