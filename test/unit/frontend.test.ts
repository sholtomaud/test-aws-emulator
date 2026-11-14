// Unit tests: the frontend's API and auth service layers with a fake fetch.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError, VendorApi } from '../../src/frontend/lib/api.ts';
import { AuthError, CognitoAuth } from '../../src/frontend/lib/auth.ts';
import { loadConfig } from '../../src/frontend/lib/config.ts';

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

describe('VendorApi', () => {
  const acme = { name: 'Acme', category: 'SaaS', contactEmail: 'sales@acme.test' };

  it('lists vendors from /api with the ID token in the Authorization header', async () => {
    const vendors = [{ vendorId: '1', ...acme, createdAt: '2026-01-01T00:00:00Z' }];
    const { fetch, calls } = fakeFetch(() => ({ body: vendors }));
    const api = new VendorApi({ baseUrl: '/api', token: () => 'token-123', fetch });

    assert.deepEqual(await api.getVendors(), vendors);
    assert.equal(calls[0]?.url, '/api/vendors');
    assert.equal(calls[0]?.method, 'GET');
    assert.equal(calls[0]?.headers.Authorization, 'token-123');
  });

  it('accepts a base URL with a trailing slash', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: [] }));
    await new VendorApi({ baseUrl: '/api/', token: () => 't', fetch }).getVendors();
    assert.equal(calls[0]?.url, '/api/vendors');
  });

  it('creates a vendor with a JSON POST', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 201 }));
    await new VendorApi({ baseUrl: '/api', token: () => 't', fetch }).createVendor(acme);
    assert.equal(calls[0]?.method, 'POST');
    assert.equal(calls[0]?.headers['Content-Type'], 'application/json');
    assert.deepEqual(calls[0]?.body, acme);
  });

  it('deletes a vendor by id in the request body', async () => {
    const { fetch, calls } = fakeFetch();
    await new VendorApi({ baseUrl: '/api', token: () => 't', fetch }).deleteVendor('abc');
    assert.equal(calls[0]?.method, 'DELETE');
    assert.deepEqual(calls[0]?.body, { vendorId: 'abc' });
  });

  it('throws an ApiError carrying the HTTP status on failure', async () => {
    const { fetch } = fakeFetch(() => ({ status: 500 }));
    await assert.rejects(new VendorApi({ baseUrl: '/api', token: () => 't', fetch }).getVendors(), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 500);
      assert.equal(error.message, 'Failed to fetch vendors');
      return true;
    });
  });

  for (const status of [401, 403]) {
    it(`treats ${status} as an expired session`, async () => {
      const { fetch } = fakeFetch(() => ({ status }));
      await assert.rejects(new VendorApi({ baseUrl: '/api', token: () => 't', fetch }).getVendors(), { status: 401 });
    });
  }

  it('does not call the API when signed out', async () => {
    const { fetch, calls } = fakeFetch();
    await assert.rejects(new VendorApi({ baseUrl: '/api', token: () => undefined, fetch }).getVendors(), { status: 401 });
    assert.equal(calls.length, 0);
  });
});

describe('CognitoAuth', () => {
  const config = { region: 'eu-west-1', userPoolClientId: 'client-1' };
  const tokens = { AuthenticationResult: { IdToken: 'id.jwt.token', ExpiresIn: 3600 } };

  it('calls the regional Cognito endpoint by default', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: tokens }));
    await new CognitoAuth(config, { fetch, store: memoryStore() }).signIn('a@b.test', 'pw');
    assert.equal(calls[0]?.url, 'https://cognito-idp.eu-west-1.amazonaws.com/');
  });

  it('signs in with USER_PASSWORD_AUTH and stores the session', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: tokens }));
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

    store.setItem('vendor-tracker.session', JSON.stringify({ email: 'a', idToken: 't', expiresAt: Date.now() - 1 }));
    assert.equal(auth.session(), undefined);
    assert.equal(store.data.size, 0);

    store.setItem('vendor-tracker.session', '{corrupt');
    assert.equal(auth.session(), undefined);
  });

  it('signs out', async () => {
    const { fetch } = fakeFetch(() => ({ body: tokens }));
    const auth = new CognitoAuth(config, { fetch, store: memoryStore() });
    await auth.signIn('a@b.test', 'pw');
    auth.signOut();
    assert.equal(auth.session(), undefined);
  });
});

describe('loadConfig', () => {
  it('reads config.json', async () => {
    const config = { apiUrl: '/api', region: 'us-east-1', userPoolId: 'p', userPoolClientId: 'c' };
    const { fetch, calls } = fakeFetch(() => ({ body: config }));
    assert.deepEqual(await loadConfig(fetch), config);
    assert.equal(calls[0]?.url, 'config.json');
  });

  it('fails clearly when config.json is missing', async () => {
    const { fetch } = fakeFetch(() => ({ status: 404 }));
    await assert.rejects(loadConfig(fetch), /config\.json \(HTTP 404\)/);
  });
});
