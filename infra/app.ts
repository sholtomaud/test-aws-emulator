import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { VendorStack, stageSettings } from './vendor-stack.ts';

const app = new App();
// cdk-nag's AWS Solutions rules run on every synth, deploy and diff: a finding
// that is neither fixed nor acknowledged (with a reason) fails it.
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
// `cdk deploy -c stage=dev` deploys the stack VendorStack-dev (see the deploy
// workflow). Without a stage it is VendorStack, as in AWS Emulator.
const stage: string | undefined = app.node.tryGetContext('stage') || undefined;
if (stage && !/^[a-z][a-z0-9]{0,9}$/.test(stage)) {
  throw new Error(`stage must be 1-10 lowercase letters or digits, starting with a letter (got "${stage}")`);
}
// Optional custom domain, per stage (the deploy workflow passes the GitHub
// environment's DOMAIN_NAME, HOSTED_ZONE_ID, HOSTED_ZONE_NAME, CERTIFICATE_ARN).
const context = (name: string): string | undefined => app.node.tryGetContext(name) || undefined;
const domainName = context('domainName');
const hostedZoneId = context('hostedZoneId');
const hostedZoneName = context('hostedZoneName');
if ((hostedZoneId === undefined) !== (hostedZoneName === undefined)) throw new Error('give both hostedZoneId and hostedZoneName');
const domain = domainName && {
  domainName,
  ...(hostedZoneId && hostedZoneName && { hostedZone: { id: hostedZoneId, name: hostedZoneName } }),
  ...(context('certificateArn') && { certificateArn: context('certificateArn') }),
};

new VendorStack(app, stage ? `VendorStack-${stage}` : 'VendorStack', {
  // `cdk deploy -c emulator=true` (see the Makefile) targets AWS Emulator.
  emulator: app.node.tryGetContext('emulator') === 'true',
  ...stageSettings(stage),
  ...(domain && { domain }),
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
