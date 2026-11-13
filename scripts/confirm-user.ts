// Confirms a user who signed up in the UI. AWS Emulator sends no verification
// email, so this does what an administrator would:  make confirm-user EMAIL=you@example.com
import { AdminConfirmSignUpCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { stackOutputs } from './lib/emulator.ts';

const email = process.argv[2];
if (!email) {
  console.error('usage: make confirm-user EMAIL=you@example.com');
  process.exit(2);
}
const { UserPoolId } = await stackOutputs();
await new CognitoIdentityProviderClient({}).send(new AdminConfirmSignUpCommand({ UserPoolId, Username: email }));
console.log(`Confirmed ${email}. You can sign in now.`);
