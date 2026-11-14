// Functional tests: the frontend's Cognito client against a user pool and an
// identity pool in AWS Emulator. Needs a running emulator (`make emulator-up`)
// but no deploy.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  AdminConfirmSignUpCommand,
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DeleteUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CognitoIdentityClient,
  CreateIdentityPoolCommand,
  DeleteIdentityPoolCommand,
  SetIdentityPoolRolesCommand,
} from '@aws-sdk/client-cognito-identity';
import { CreateRoleCommand, DeleteRoleCommand, IAMClient } from '@aws-sdk/client-iam';
import { emulatorEndpoint } from '../../scripts/lib/emulator.ts';
import { AuthError, CognitoAuth } from '../../src/frontend/lib/auth.ts';

const memoryStore = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
};

describe('CognitoAuth against emulated Cognito', () => {
  const cognito = new CognitoIdentityProviderClient({});
  const identity = new CognitoIdentityClient({});
  const iam = new IAMClient({});
  const roleName = `functional-${randomUUID().slice(0, 8)}`;
  let IdentityPoolId: string;
  const email = `user-${randomUUID().slice(0, 8)}@example.com`;
  const password = 'Correct-horse-9';
  let UserPoolId: string;
  let auth: CognitoAuth;

  before(async () => {
    const endpoint = emulatorEndpoint();
    // Same settings as the user pool in infra/vendor-stack.ts.
    const pool = await cognito.send(
      new CreateUserPoolCommand({
        PoolName: `functional-${randomUUID().slice(0, 8)}`,
        UsernameAttributes: ['email'],
        AutoVerifiedAttributes: ['email'],
      }),
    );
    UserPoolId = pool.UserPool!.Id!;
    const client = await cognito.send(
      new CreateUserPoolClientCommand({
        UserPoolId,
        ClientName: 'functional',
        ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      }),
    );
    const ClientId = client.UserPoolClient!.ClientId!;
    // Same settings as the identity pool in infra/vendor-stack.ts.
    const pool2 = await identity.send(
      new CreateIdentityPoolCommand({
        IdentityPoolName: `functional_${randomUUID().slice(0, 8)}`,
        AllowUnauthenticatedIdentities: false,
        CognitoIdentityProviders: [{ ProviderName: `cognito-idp.us-east-1.amazonaws.com/${UserPoolId}`, ClientId }],
      }),
    );
    IdentityPoolId = pool2.IdentityPoolId!;
    const role = await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Federated: 'cognito-identity.amazonaws.com' },
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: { 'cognito-identity.amazonaws.com:aud': IdentityPoolId },
                'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
              },
            },
          ],
        }),
      }),
    );
    await identity.send(new SetIdentityPoolRolesCommand({ IdentityPoolId, Roles: { authenticated: role.Role!.Arn! } }));
    auth = new CognitoAuth(
      {
        region: 'us-east-1',
        userPoolId: UserPoolId,
        userPoolClientId: ClientId,
        identityPoolId: IdentityPoolId,
        cognitoEndpoint: endpoint.href,
        identityEndpoint: endpoint.href,
      },
      { store: memoryStore() },
    );
  });

  after(async () => {
    await identity.send(new DeleteIdentityPoolCommand({ IdentityPoolId }));
    await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
    await cognito.send(new DeleteUserPoolCommand({ UserPoolId }));
    for (const client of [cognito, identity, iam]) client.destroy();
  });

  const rejectsWith = (promise: Promise<unknown>, code: string) =>
    assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof AuthError, String(error));
      assert.equal(error.code, code);
      return true;
    });

  it('signs up a user who then needs to confirm their email', async () => {
    assert.deepEqual(await auth.signUp(email, password), { confirmed: false });
  });

  it('refuses a duplicate sign-up', async () => {
    await rejectsWith(auth.signUp(email, password), 'UsernameExistsException');
  });

  it('refuses a weak password', async () => {
    await rejectsWith(auth.signUp(`weak-${email}`, 'short'), 'InvalidPasswordException');
  });

  it('refuses sign-in before confirmation', async () => {
    await rejectsWith(auth.signIn(email, password), 'UserNotConfirmedException');
    assert.equal(auth.session(), undefined);
  });

  it('refuses a wrong verification code', async () => {
    await rejectsWith(auth.confirmSignUp(email, '000000'), 'CodeMismatchException');
  });

  it('signs in once confirmed, with an ID token for the user and temporary AWS credentials', async () => {
    // The emulator sends no email, so confirm the way an administrator would.
    await cognito.send(new AdminConfirmSignUpCommand({ UserPoolId, Username: email }));

    const session = await auth.signIn(email, password);
    assert.deepEqual(auth.session(), session);
    assert.ok(session.expiresAt > Date.now());

    const claims = JSON.parse(Buffer.from(session.idToken.split('.')[1]!, 'base64url').toString());
    assert.equal(claims.email, email);
    assert.equal(claims.token_use, 'id');
    assert.ok(String(claims.iss).endsWith(UserPoolId));

    // Temporary credentials from the identity pool, for signing API requests.
    assert.ok(session.credentials.accessKeyId);
    assert.ok(session.credentials.secretAccessKey);
    assert.ok(session.credentials.sessionToken, 'identity pool credentials are temporary');
    assert.ok(session.expiresAt <= Date.now() + 3600 * 1000);
  });

  it('refuses a wrong password', async () => {
    await rejectsWith(auth.signIn(email, 'Wrong-password-1'), 'NotAuthorizedException');
  });

  it('signs out', () => {
    auth.signOut();
    assert.equal(auth.session(), undefined);
  });
});
