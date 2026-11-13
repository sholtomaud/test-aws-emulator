// Functional tests: the frontend's Cognito client against a user pool in AWS
// Emulator. Needs a running emulator (`make emulator-up`) but no deploy.
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
    auth = new CognitoAuth(
      { region: 'us-east-1', userPoolClientId: client.UserPoolClient!.ClientId!, cognitoEndpoint: endpoint.href },
      { store: memoryStore() },
    );
  });

  after(async () => {
    await cognito.send(new DeleteUserPoolCommand({ UserPoolId }));
    cognito.destroy();
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

  it('signs in once confirmed and receives an ID token for the user', async () => {
    // The emulator sends no email, so confirm the way an administrator would.
    await cognito.send(new AdminConfirmSignUpCommand({ UserPoolId, Username: email }));

    const session = await auth.signIn(email, password);
    assert.deepEqual(auth.session(), session);
    assert.ok(session.expiresAt > Date.now());

    const claims = JSON.parse(Buffer.from(session.idToken.split('.')[1]!, 'base64url').toString());
    assert.equal(claims.email, email);
    assert.equal(claims.token_use, 'id');
    assert.ok(String(claims.iss).endsWith(UserPoolId));
  });

  it('refuses a wrong password', async () => {
    await rejectsWith(auth.signIn(email, 'Wrong-password-1'), 'NotAuthorizedException');
  });

  it('signs out', () => {
    auth.signOut();
    assert.equal(auth.session(), undefined);
  });
});
