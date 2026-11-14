// Unit tests: the frontend's API, auth and signing layers with a fake fetch.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { SignatureV4 } from '@smithy/signature-v4';
import { ApiError, VendorApi } from '../../src/frontend/lib/api.ts';
import { AuthError, CognitoAuth } from '../../src/frontend/lib/auth.ts';
import { loadConfig } from '../../src/frontend/lib/config.ts';
import { signRequest } from '../../src/frontend/lib/sigv4.ts';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/** A fake fetch that records calls and replies with `respond`. */
const fakeFetch = (respond: (call: Call) => { status?: number; body?: unknown } = () => ({})) => {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const { status = 200, body = {} } = respond(call);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: impl, calls };
};

const memoryStore = () => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
};

const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'session-token' };

const bytes = (data: string | ArrayBuffer | ArrayBufferView): string | Uint8Array =>
  typeof data === 'string' ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);

/** SHA-256 for the AWS SDK's reference signer, on node:crypto. */
class Sha256 {
  #hash;
  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    this.#hash = secret ? createHmac('sha256', bytes(secret)) : createHash('sha256');
  }
  update(data: string | ArrayBuffer | ArrayBufferView) {
    this.#hash.update(bytes(data));
  }
  async digest() {
    return new Uint8Array(this.#hash.digest());
  }
  reset() {}
}

describe('signRequest', () => {
  const date = new Date('2026-11-14T12:34:56Z');
  const reference = async (method: string, url: string, body?: string) => {
    const { hostname, pathname, searchParams } = new URL(url);
    const signed = await new SignatureV4({
      credentials,
      region: 'us-east-1',
      service: 'execute-api',
      sha256: Sha256,
      applyChecksum: false, // execute-api needs no x-amz-content-sha256 header
    }).sign(
      {
        method,
        protocol: 'https:',
        hostname,
        path: pathname,
        query: Object.fromEntries([...new Set(searchParams.keys())].map((key) => [key, searchParams.getAll(key)])),
        headers: { host: hostname },
        body,
      },
      { signingDate: date },
    );
    return signed.headers;
  };

  for (const [method, url, body] of [
    ['GET', 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/api/vendors', undefined],
    ['POST', 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/api/vendors', '{"name":"Acme & Co"}'],
    ['GET', 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/api/vendors?b=2&a=x y&a=1', undefined],
  ] as const) {
    it(`matches the AWS SDK's signer for ${method} ${new URL(url).pathname}${new URL(url).search}`, async () => {
      const ours = await signRequest({ method, url, body, credentials, region: 'us-east-1', service: 'execute-api', date });
      const theirs = await reference(method, url, body);
      assert.equal(ours.Authorization, theirs.authorization);
      assert.equal(ours['X-Amz-Date'], theirs['x-amz-date']);
      assert.equal(ours['X-Amz-Security-Token'], 'session-token');
    });
  }

  it('leaves out the security token for long-term credentials and never returns Host', async () => {
    const headers = await signRequest({
      method: 'GET',
      url: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
      region: 'us-east-1',
      service: 'execute-api',
      date,
    });
    assert.deepEqual(Object.keys(headers).sort(), ['Authorization', 'X-Amz-Date']);
    assert.match(headers.Authorization!, /Credential=AKID\/20261114\/us-east-1\/execute-api\/aws4_request, SignedHeaders=host;x-amz-date, /);
  });
});

describe('VendorApi', () => {
  const acme = { name: 'Acme', category: 'SaaS', contactEmail: 'sales@acme.test' };
  const api = (fetch: typeof globalThis.fetch, creds: () => typeof credentials | undefined = () => credentials) =>
    new VendorApi({
      baseUrl: '/api',
      signingUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/',
      region: 'us-east-1',
      credentials: creds,
      fetch,
    });

  it('lists vendors from /api with a SigV4 signature for the API Gateway stage', async () => {
    const vendors = [{ vendorId: '1', ...acme, createdAt: '2026-01-01T00:00:00Z' }];
    const { fetch, calls } = fakeFetch(() => ({ body: vendors }));

    assert.deepEqual(await api(fetch).getVendors(), vendors);
    assert.equal(calls[0]?.url, '/api/vendors');
    assert.equal(calls[0]?.method, 'GET');
    assert.match(calls[0]!.headers.Authorization!, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/execute-api\/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    assert.equal(calls[0]?.headers['X-Amz-Security-Token'], 'session-token');
    assert.match(calls[0]!.headers['X-Amz-Date']!, /^\d{8}T\d{6}Z$/);
  });

  it('signs the path API Gateway receives, /prod/api/vendors', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: [] }));
    await api(fetch).getVendors();
    const expected = await signRequest({
      method: 'GET',
      url: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/api/vendors',
      credentials,
      region: 'us-east-1',
      service: 'execute-api',
      date: new Date(calls[0]!.headers['X-Amz-Date']!.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z')),
    });
    assert.equal(calls[0]?.headers.Authorization, expected.Authorization);
  });

  it('creates a vendor with a signed JSON POST', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 201 }));
    await api(fetch).createVendor(acme);
    assert.equal(calls[0]?.method, 'POST');
    assert.equal(calls[0]?.headers['Content-Type'], 'application/json');
    assert.ok(calls[0]?.headers.Authorization);
    assert.deepEqual(calls[0]?.body, acme);
  });

  it('deletes a vendor by id in the request body', async () => {
    const { fetch, calls } = fakeFetch();
    await api(fetch).deleteVendor('abc');
    assert.equal(calls[0]?.method, 'DELETE');
    assert.deepEqual(calls[0]?.body, { vendorId: 'abc' });
  });

  it('throws an ApiError carrying the HTTP status on failure', async () => {
    const { fetch } = fakeFetch(() => ({ status: 500 }));
    await assert.rejects(api(fetch).getVendors(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 500);
      assert.equal(error.message, 'Failed to fetch vendors');
      return true;
    });
  });

  for (const status of [401, 403]) {
    it(`treats ${status} as an expired session`, async () => {
      const { fetch } = fakeFetch(() => ({ status }));
      await assert.rejects(api(fetch).getVendors(), { status: 401 });
    });
  }

  it('does not call the API when signed out', async () => {
    const { fetch, calls } = fakeFetch();
    await assert.rejects(api(fetch, () => undefined).getVendors(), { status: 401 });
    assert.equal(calls.length, 0);
  });
});

describe('CognitoAuth', () => {
  const config = { region: 'eu-west-1', userPoolId: 'eu-west-1_pool', userPoolClientId: 'client-1', identityPoolId: 'eu-west-1:pool' };
  const tokens = { AuthenticationResult: { IdToken: 'id.jwt.token', ExpiresIn: 3600 } };
  const expiration = Math.floor(Date.now() / 1000) + 1800;
  /** Replies like Cognito: tokens from the user pool, then an identity and credentials from the identity pool. */
  const cognito = (call: Call) => {
    const target = call.headers['X-Amz-Target'];
    if (target === 'AWSCognitoIdentityService.GetId') return { body: { IdentityId: 'eu-west-1:identity' } };
    if (target === 'AWSCognitoIdentityService.GetCredentialsForIdentity') {
      return { body: { Credentials: { AccessKeyId: 'ASIA1', SecretKey: 'secret', SessionToken: 'token', Expiration: expiration } } };
    }
    return { body: tokens };
  };

  it('calls the regional Cognito endpoints by default', async () => {
    const { fetch, calls } = fakeFetch(cognito);
    await new CognitoAuth(config, { fetch, store: memoryStore() }).signIn('a@b.test', 'pw');
    assert.deepEqual(calls.map((call) => call.url), [
      'https://cognito-idp.eu-west-1.amazonaws.com/',
      'https://cognito-identity.eu-west-1.amazonaws.com/',
      'https://cognito-identity.eu-west-1.amazonaws.com/',
    ]);
  });

  it('swaps the ID token for identity pool credentials', async () => {
    const { fetch, calls } = fakeFetch(cognito);
    const session = await new CognitoAuth({ ...config, identityEndpoint: '/identity' }, { fetch, store: memoryStore() }).signIn('a@b.test', 'pw');
    const logins = { 'cognito-idp.eu-west-1.amazonaws.com/eu-west-1_pool': 'id.jwt.token' };
    assert.equal(calls[1]?.url, '/identity');
    assert.deepEqual(calls[1]?.body, { IdentityPoolId: 'eu-west-1:pool', Logins: logins });
    assert.equal(calls[2]?.headers['X-Amz-Target'], 'AWSCognitoIdentityService.GetCredentialsForIdentity');
    assert.deepEqual(calls[2]?.body, { IdentityId: 'eu-west-1:identity', Logins: logins });
    assert.deepEqual(session.credentials, { accessKeyId: 'ASIA1', secretAccessKey: 'secret', sessionToken: 'token' });
    // The credentials (30 minutes) expire before the ID token (1 hour).
    assert.equal(session.expiresAt, expiration * 1000);
  });

  it('signs in with USER_PASSWORD_AUTH and stores the session', async () => {
    const { fetch, calls } = fakeFetch(cognito);
    const store = memoryStore();
    const auth = new CognitoAuth({ ...config, cognitoEndpoint: '/cognito' }, { fetch, store });

    const session = await auth.signIn('a@b.test', 'pw');

    assert.equal(calls[0]?.url, '/cognito');
    assert.equal(calls[0]?.headers['X-Amz-Target'], 'AWSCognitoIdentityProviderService.InitiateAuth');
    assert.equal(calls[0]?.headers['Content-Type'], 'application/x-amz-json-1.1');
    assert.deepEqual(calls[0]?.body, {
      ClientId: 'client-1',
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: 'a@b.test', PASSWORD: 'pw' },
    });
    assert.equal(session.idToken, 'id.jwt.token');
    assert.deepEqual(auth.session(), session);
    assert.ok(!JSON.stringify([...store.data]).includes('"pw"'), 'the password must not be stored');
  });

  it('signs up with the email attribute and reports confirmation state', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { UserConfirmed: false } }));
    const result = await new CognitoAuth(config, { fetch, store: memoryStore() }).signUp('a@b.test', 'pw');
    assert.deepEqual(result, { confirmed: false });
    assert.equal(calls[0]?.headers['X-Amz-Target'], 'AWSCognitoIdentityProviderService.SignUp');
    assert.deepEqual(calls[0]?.body.UserAttributes, [{ Name: 'email', Value: 'a@b.test' }]);
  });

  it('confirms sign-up with the verification code', async () => {
    const { fetch, calls } = fakeFetch();
    await new CognitoAuth(config, { fetch, store: memoryStore() }).confirmSignUp('a@b.test', '123456');
    assert.equal(calls[0]?.headers['X-Amz-Target'], 'AWSCognitoIdentityProviderService.ConfirmSignUp');
    assert.deepEqual(calls[0]?.body, { ClientId: 'client-1', Username: 'a@b.test', ConfirmationCode: '123456' });
  });

  it('turns Cognito errors into AuthError with the error code', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 400,
      body: { __type: 'com.amazonaws.cognito#NotAuthorizedException', message: 'Incorrect username or password.' },
    }));
    const auth = new CognitoAuth(config, { fetch, store: memoryStore() });
    await assert.rejects(auth.signIn('a@b.test', 'bad'), (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.code, 'NotAuthorizedException');
      assert.equal(error.message, 'Incorrect username or password.');
      return true;
    });
    assert.equal(auth.session(), undefined);
  });

  it('rejects sign-in challenges it cannot complete', async () => {
    const { fetch } = fakeFetch(() => ({ body: { ChallengeName: 'SMS_MFA' } }));
    await assert.rejects(new CognitoAuth(config, { fetch, store: memoryStore() }).signIn('a@b.test', 'pw'), {
      code: 'UnsupportedChallenge',
    });
  });

  it('drops expired and corrupt sessions', () => {
    const store = memoryStore();
    const auth = new CognitoAuth(config, { fetch: fakeFetch().fetch, store });

    store.setItem(
      'vendor-tracker.session',
      JSON.stringify({ email: 'a', idToken: 't', credentials: { accessKeyId: 'A', secretAccessKey: 'S' }, expiresAt: Date.now() - 1 }),
    );
    assert.equal(auth.session(), undefined);
    assert.equal(store.data.size, 0);

    store.setItem('vendor-tracker.session', '{corrupt');
    assert.equal(auth.session(), undefined);
  });

  it('signs out', async () => {
    const { fetch } = fakeFetch(cognito);
    const auth = new CognitoAuth(config, { fetch, store: memoryStore() });
    await auth.signIn('a@b.test', 'pw');
    auth.signOut();
    assert.equal(auth.session(), undefined);
  });
});

describe('loadConfig', () => {
  it('reads config.json', async () => {
    const config = { apiUrl: '/api', apiSigningUrl: 'https://a.test/prod/', region: 'us-east-1', userPoolId: 'p', userPoolClientId: 'c', identityPoolId: 'i' };
    const { fetch, calls } = fakeFetch(() => ({ body: config }));
    assert.deepEqual(await loadConfig(fetch), config);
    assert.equal(calls[0]?.url, 'config.json');
  });

  it('fails clearly when config.json is missing', async () => {
    const { fetch } = fakeFetch(() => ({ status: 404 }));
    await assert.rejects(loadConfig(fetch), /config\.json \(HTTP 404\)/);
  });
});
