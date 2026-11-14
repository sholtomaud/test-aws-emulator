// Creates confirmed Cognito users in the deployed user pool for tests.
import { randomUUID } from 'node:crypto';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { StackOutputs } from '../../scripts/lib/emulator.ts';

export const TEST_PASSWORD = 'Correct-horse-9';
export const uniqueEmail = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}@example.com`;

/** Creates a confirmed user and returns their email. */
export const createUser = async (cognito: CognitoIdentityProviderClient, outputs: StackOutputs, prefix: string) => {
  const email = uniqueEmail(prefix);
  await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: outputs.UserPoolId,
      Username: email,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
    }),
  );
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: outputs.UserPoolId,
      Username: email,
      Password: TEST_PASSWORD,
      Permanent: true,
    }),
  );
  return email;
};

export const deleteUser = (cognito: CognitoIdentityProviderClient, outputs: StackOutputs, email: string) =>
  cognito.send(new AdminDeleteUserCommand({ UserPoolId: outputs.UserPoolId, Username: email }));

/** Signs the user in and returns their ID token. */
export const idTokenFor = async (cognito: CognitoIdentityProviderClient, outputs: StackOutputs, email: string) => {
  const { AuthenticationResult } = await cognito.send(
    new InitiateAuthCommand({
      ClientId: outputs.UserPoolClientId,
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: email, PASSWORD: TEST_PASSWORD },
    }),
  );
  return AuthenticationResult!.IdToken!;
};
