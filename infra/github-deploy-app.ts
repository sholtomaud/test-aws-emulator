// CDK app for the one-time GitHub Actions deploy setup (see the README):
//   make aws-github-setup REPOSITORY=owner/name ENVIRONMENTS=dev,test
import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { GitHubDeployStack } from './github-deploy-stack.ts';

const app = new App();
Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
const context = (name: string): string | undefined => app.node.tryGetContext(name) || undefined;
const repository = context('repository');
const environments = context('environments');
if (!repository || !environments) throw new Error('pass -c repository=owner/name -c environments=dev,test');
new GitHubDeployStack(app, 'VendorTrackerGitHubDeploy', {
  repository,
  environments: environments.split(',').map((name) => name.trim()).filter(Boolean),
  existingProviderArn: context('oidcProviderArn'),
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
