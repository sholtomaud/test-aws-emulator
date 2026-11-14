import { App } from 'aws-cdk-lib';
import { VendorStack } from './vendor-stack.ts';

const app = new App();
// `cdk deploy -c stage=dev` deploys the stack VendorStack-dev (see the deploy
// workflow). Without a stage it is VendorStack, as in AWS Emulator.
const stage: string | undefined = app.node.tryGetContext('stage') || undefined;
if (stage && !/^[a-z][a-z0-9]{0,9}$/.test(stage)) {
  throw new Error(`stage must be 1-10 lowercase letters or digits, starting with a letter (got "${stage}")`);
}
new VendorStack(app, stage ? `VendorStack-${stage}` : 'VendorStack', {
  // `cdk deploy -c emulator=true` (see the Makefile) targets AWS Emulator.
  emulator: app.node.tryGetContext('emulator') === 'true',
  stage,
  retainData: stage === 'prod',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
