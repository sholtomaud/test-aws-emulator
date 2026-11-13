import { App } from 'aws-cdk-lib';
import { VendorStack } from './vendor-stack.ts';

const app = new App();
new VendorStack(app, 'VendorStack', {
  // `cdk deploy -c emulator=true` (see the Makefile) targets AWS Emulator.
  emulator: app.node.tryGetContext('emulator') === 'true',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
