// Minimal Amazon Cognito client for the browser. It signs users in to the user
// pool, then swaps their ID token for temporary AWS credentials from the
// identity pool, which sign the API requests (IAM auth). It calls both
// Cognito APIs directly with fetch (these operations need no AWS signature),
// so the app needs no auth library.
import type { AppConfig } from './config.ts';
import type { Credentials } from './sigv4.ts';

export interface Session {
  email: string;
  /** The user pool ID token, exchanged for `credentials`. */
  idToken: string;
  /** Temporary credentials of the identity pool's authenticated role. */
  credentials: Credentials;
  /** Epoch milliseconds: the sooner of the token's and the credentials' expiry. */
  expiresAt: number;
}

export class AuthError extends Error {
  /** Cognito error type, e.g. UserNotConfirmedException. */
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

type AuthConfig = Pick<
  AppConfig,
  'region' | 'userPoolId' | 'userPoolClientId' | 'identityPoolId' | 'cognitoEndpoint' | 'identityEndpoint'
>;
type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const STORAGE_KEY = 'vendor-tracker.session';

export class CognitoAuth {
  #endpoint: string;
  #identityEndpoint: string;
  #clientId: string;
  #identityPoolId: string;
  #provider: string;
  #fetch: typeof fetch;
  #store: SessionStore;

  constructor(config: AuthConfig, deps: { fetch?: typeof fetch; store?: SessionStore } = {}) {
    this.#endpoint = config.cognitoEndpoint ?? `https://cognito-idp.${config.region}.amazonaws.com/`;
    this.#identityEndpoint = config.identityEndpoint ?? `https://cognito-identity.${config.region}.amazonaws.com/`;
    this.#clientId = config.userPoolClientId;
    this.#identityPoolId = config.identityPoolId;
    this.#provider = `cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
    this.#fetch = deps.fetch ?? ((...args) => fetch(...args));
    this.#store = deps.store ?? sessionStorage;
  }

  #call(operation: string, body: Record<string, unknown>): Promise<Record<string, any>> {
    return this.#post(this.#endpoint, `AWSCognitoIdentityProviderService.${operation}`, { ClientId: this.#clientId, ...body });
  }

  async #post(url: string, target: string, body: Record<string, unknown>): Promise<Record<string, any>> {
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': target },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, any>;
    if (!response.ok) {
      const code = String(data.__type ?? 'UnknownError').split('#').pop()!;
      throw new AuthError(code, data.message ?? data.Message ?? `Cognito request failed (HTTP ${response.status})`);
    }
    return data;
  }

  /** Registers a user. Resolves to whether the account is already confirmed. */
  async signUp(email: string, password: string): Promise<{ confirmed: boolean }> {
    const data = await this.#call('SignUp', {
      Username: email,
      Password: password,
      UserAttributes: [{ Name: 'email', Value: email }],
    });
    return { confirmed: Boolean(data.UserConfirmed) };
  }

  async confirmSignUp(email: string, code: string): Promise<void> {
    await this.#call('ConfirmSignUp', { Username: email, ConfirmationCode: code });
  }

  async resendCode(email: string): Promise<void> {
    await this.#call('ResendConfirmationCode', { Username: email });
  }

  async signIn(email: string, password: string): Promise<Session> {
    const data = await this.#call('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: email, PASSWORD: password },
    });
    const result = data.AuthenticationResult;
    if (!result?.IdToken) {
      throw new AuthError('UnsupportedChallenge', `Sign-in needs an extra step this app does not support (${data.ChallengeName ?? 'unknown'}).`);
    }
    const idToken: string = result.IdToken;
    const { credentials, expiresAt } = await this.#credentialsFor(idToken);
    const session: Session = {
      email,
      idToken,
      credentials,
      expiresAt: Math.min(Date.now() + Number(result.ExpiresIn ?? 3600) * 1000, expiresAt),
    };
    this.#store.setItem(STORAGE_KEY, JSON.stringify(session));
    return session;
  }

  /** Exchanges an ID token for the identity pool's temporary credentials. */
  async #credentialsFor(idToken: string): Promise<{ credentials: Credentials; expiresAt: number }> {
    const Logins = { [this.#provider]: idToken };
    const { IdentityId } = await this.#post(this.#identityEndpoint, 'AWSCognitoIdentityService.GetId', {
      IdentityPoolId: this.#identityPoolId,
      Logins,
    });
    const { Credentials: issued } = await this.#post(
      this.#identityEndpoint,
      'AWSCognitoIdentityService.GetCredentialsForIdentity',
      { IdentityId, Logins },
    );
    if (!issued?.AccessKeyId) throw new AuthError('NoCredentials', 'Sign-in did not return AWS credentials.');
    return {
      credentials: { accessKeyId: issued.AccessKeyId, secretAccessKey: issued.SecretKey, sessionToken: issued.SessionToken },
      // Expiration is epoch seconds.
      expiresAt: Number(issued.Expiration) * 1000,
    };
  }

  signOut(): void {
    this.#store.removeItem(STORAGE_KEY);
  }

  /** The current session, or undefined when signed out or expired. */
  session(): Session | undefined {
    try {
      const session = JSON.parse(this.#store.getItem(STORAGE_KEY) ?? 'null') as Session | null;
      if (session?.credentials?.accessKeyId && session.expiresAt > Date.now()) return session;
    } catch {
      // Corrupt stored value: treat as signed out.
    }
    this.signOut();
    return undefined;
  }
}
