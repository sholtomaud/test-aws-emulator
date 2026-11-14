// Creates confirmed Cognito users in the deployed user pool for tests.
import { randomUUID } from 'node:crypto';
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoIdentityClient, GetCredentialsForIdentityCommand, GetIdCommand } from '@aws-sdk/client-cognito-identity';
import type { StackOutputs } from '../../scripts/lib/emulator.ts';
import { signRequest } from '../../src/frontend/lib/sigv4.ts';
import type { Credentials } from '../../src/frontend/lib/sigv4.ts';

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

/** Swaps the user's ID token for the identity pool's temporary credentials, as the app does. */
export const credentialsFor = async (outputs: StackOutputs, idToken: string): Promise<Credentials> => {
  const identity = new CognitoIdentityClient({});
  try {
    const region = await identity.config.region();
    const Logins = { [`cognito-idp.${region}.amazonaws.com/${outputs.UserPoolId}`]: idToken };
    const { IdentityId } = await identity.send(new GetIdCommand({ IdentityPoolId: outputs.IdentityPoolId, Logins }));
    const { Credentials: issued } = await identity.send(new GetCredentialsForIdentityCommand({ IdentityId, Logins }));
    return { accessKeyId: issued!.AccessKeyId!, secretAccessKey: issued!.SecretKey!, sessionToken: issued!.SessionToken! };
  } finally {
    identity.destroy();
  }
};

/**
 * Headers that sign a request to `path` under the API stage (e.g. `api/vendors`)
 * the way the app does: for the API Gateway host and stage path.
 */
export const signedHeaders = (outputs: StackOutputs, credentials: Credentials, method: string, path: string, body?: string) =>
  signRequest({
    method,
    url: new URL(path, outputs.ApiEndpoint).href,
    body,
    credentials,
    region: new URL(outputs.ApiEndpoint).hostname.split('.')[2]!,
    service: 'execute-api',
  });
