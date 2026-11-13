// Helpers for scripts and tests that talk to a running AWS Emulator.
// The environment comes from `scripts/emulator.sh run` (see the Makefile).
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export const STACK_NAME = 'VendorStack';

export interface StackOutputs {
  ApiEndpoint: string;
  UserPoolId: string;
  UserPoolClientId: string;
  TableName: string;
  SiteBucketName: string;
  CloudFrontURL: string;
}

/**
 * Returns the emulator endpoint, and throws unless AWS_ENDPOINT_URL points at
 * this machine. Call it before any AWS request so a test can never reach AWS.
 */
export const emulatorEndpoint = (): URL => {
  const value = process.env.AWS_ENDPOINT_URL;
  if (!value) throw new Error('AWS_ENDPOINT_URL is not set. Run this through `make` (scripts/emulator.sh run ...).');
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error(`Refusing to run: AWS_ENDPOINT_URL (${value}) is not a local AWS Emulator.`);
  }
  return url;
};

/** Reads the outputs of the deployed stack from the emulator's CloudFormation. */
export const stackOutputs = async (): Promise<StackOutputs> => {
  emulatorEndpoint();
  const { Stacks } = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: STACK_NAME }));
  const stack = Stacks?.[0];
  if (!stack || !/^(CREATE|UPDATE)_COMPLETE$/.test(stack.StackStatus ?? '')) {
    throw new Error(`${STACK_NAME} is not deployed (status: ${stack?.StackStatus ?? 'missing'}). Run \`make deploy\`.`);
  }
  const outputs = Object.fromEntries((stack.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
  return outputs as unknown as StackOutputs;
};
