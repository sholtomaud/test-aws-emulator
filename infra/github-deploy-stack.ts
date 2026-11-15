// One-time setup per AWS account: lets this repository's GitHub Actions
// workflow deploy, with no stored AWS keys. GitHub's OIDC token is exchanged
// for a role that only that repository, running in the named GitHub
// environment (dev, test, uat, prod), can assume.
//
// The role can assume the CDK bootstrap roles (cdk-hnb659fds-*), which publish
// the assets and prepare the change set, and on its own environment's stack
// only: describe it, check and execute the prepared change set, and set its
// stack policy (scripts/release.ts).
import { CfnOutput, Duration, Stack, Token, Validations, aws_iam as iam } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';

export interface GitHubDeployStackProps extends StackProps {
  /** owner/name of the GitHub repository. */
  repository: string;
  /** GitHub environments that deploy to this account, e.g. ['dev'] or ['dev', 'test']. */
  environments: string[];
  /**
   * ARN of an existing GitHub OIDC provider. An account has at most one per
   * URL, so pass it when another stack already created it.
   */
  existingProviderArn?: string;
  /** The CDK bootstrap qualifier. Default hnb659fds. */
  qualifier?: string;
}

export class GitHubDeployStack extends Stack {
  constructor(scope: Construct, id: string, props: GitHubDeployStackProps) {
    super(scope, id, props);
    if (!/^[\w.-]+\/[\w.-]+$/.test(props.repository)) throw new Error(`repository must be owner/name (got "${props.repository}")`);
    if (props.environments.length === 0) throw new Error('give at least one environment');

    const provider = props.existingProviderArn
      ? iam.OidcProviderNative.fromOidcProviderArn(this, 'GitHub', props.existingProviderArn)
      : new iam.OidcProviderNative(this, 'GitHub', { url: GITHUB_OIDC_URL, clientIds: ['sts.amazonaws.com'] });
    const qualifier = props.qualifier ?? 'hnb659fds';
    // How cdk-nag spells the account in a finding: the number when the stack
    // has one, else the placeholder for the AWS::AccountId reference.
    const account = Token.isUnresolved(this.account) ? '<AWS::AccountId>' : this.account;

    for (const environment of props.environments) {
      const role = new iam.Role(this, `Deploy-${environment}`, {
        roleName: `vendor-tracker-deploy-${environment}`,
        description: `GitHub Actions deploys of ${props.repository} from its "${environment}" environment`,
        maxSessionDuration: Duration.hours(1),
        assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            // Only jobs that run in this GitHub environment of this repository:
            // the environment's protection rules (reviewers, branches) apply.
            'token.actions.githubusercontent.com:sub': `repo:${props.repository}:environment:${environment}`,
          },
        }),
      });
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-${qualifier}-*-${this.account}-*`],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          // Read the stack and run the release (scripts/release.ts): check and
          // execute the change set CDK prepared, set the prod stack policy.
          actions: [
            'cloudformation:DescribeStacks',
            'cloudformation:DescribeChangeSet',
            'cloudformation:ExecuteChangeSet',
            'cloudformation:GetStackPolicy',
            'cloudformation:SetStackPolicy',
          ],
          resources: [`arn:${this.partition}:cloudformation:*:${this.account}:stack/VendorStack-${environment}/*`],
        }),
      );
      Validations.of(role).acknowledge({
        id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:iam::${account}:role/cdk-${qualifier}-*-${account}-*]`,
        reason: 'Only the CDK bootstrap roles of this account (deploy, file and image publishing, lookup), in any region.',
      });
      Validations.of(role).acknowledge({
        id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:cloudformation:*:${account}:stack/VendorStack-${environment}/*]`,
        reason: "Only this environment's stack (describe it, run its prepared change set, set its stack policy); the trailing wildcard is the stack's id suffix.",
      });
      new CfnOutput(this, `DeployRoleArn-${environment}`, {
        value: role.roleArn,
        description: `Set as AWS_DEPLOY_ROLE_ARN in the GitHub environment "${environment}"`,
      });
    }
  }
}
