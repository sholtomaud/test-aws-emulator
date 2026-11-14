// Unit tests: Lambda business logic with a fake DynamoDB client. No emulator.
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { DeleteCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { createVendor, deleteVendor, getVendors } from '../../src/lambda/vendors.ts';
import type { Db } from '../../src/lambda/vendors.ts';

type Command = PutCommand | ScanCommand | DeleteCommand;

/** A fake document client that records commands and replies with `respond`. */
const fakeDb = (respond: (command: Command) => unknown = () => ({})) => {
  const commands: Command[] = [];
  const db = {
    send: async (command: Command) => {
      commands.push(command);
      return respond(command);
    },
  } as unknown as Db;
  return { db, commands };
};

const event = (body: unknown) => ({ body: typeof body === 'string' ? body : JSON.stringify(body) });
const acme = { name: 'Acme', category: 'SaaS', contactEmail: 'sales@acme.test' };

beforeEach(() => {
  process.env.TABLE_NAME = 'vendors-test';
  mock.method(console, 'error', () => {});
});

describe('createVendor', () => {
  it('stores the vendor with a generated id and timestamp', async () => {
    const { db, commands } = fakeDb();
    const result = await createVendor(db, event(acme));

    assert.equal(result.statusCode, 201);
    const body = JSON.parse(result.body);
    assert.equal(body.message, 'Vendor created');
    assert.match(body.vendorId, /^[0-9a-f-]{36}$/);

    assert.equal(commands.length, 1);
    const put = commands[0];
    assert.ok(put instanceof PutCommand);
    assert.equal(put.input.TableName, 'vendors-test');
    assert.deepEqual({ ...put.input.Item, createdAt: undefined }, { ...acme, vendorId: body.vendorId, createdAt: undefined });
    assert.ok(!Number.isNaN(Date.parse(put.input.Item?.createdAt)));
  });

  it('generates a different id for each vendor', async () => {
    const { db } = fakeDb();
    const first = JSON.parse((await createVendor(db, event(acme))).body);
    const second = JSON.parse((await createVendor(db, event(acme))).body);
    assert.notEqual(first.vendorId, second.vendorId);
  });

  it('trims whitespace from fields', async () => {
    const { db, commands } = fakeDb();
    await createVendor(db, event({ ...acme, name: '  Acme  ' }));
    assert.equal((commands[0] as PutCommand).input.Item?.name, 'Acme');
  });

  for (const [label, body] of [
    ['a missing name', { ...acme, name: undefined }],
    ['a blank category', { ...acme, category: '   ' }],
    ['a non-string email', { ...acme, contactEmail: 42 }],
    ['malformed JSON', '{nope'],
    ['a JSON array', '[]'],
    ['no body', null],
  ] as const) {
    it(`rejects ${label} with 400 and writes nothing`, async () => {
      const { db, commands } = fakeDb();
      const result = await createVendor(db, { body: body === null ? null : event(body).body });
      assert.equal(result.statusCode, 400);
      assert.equal(commands.length, 0);
    });
  }

  it('returns 500 when DynamoDB fails', async () => {
    const { db } = fakeDb(() => {
      throw new Error('boom');
    });
    const result = await createVendor(db, event(acme));
    assert.equal(result.statusCode, 500);
    assert.deepEqual(JSON.parse(result.body), { error: 'Failed to create vendor' });
  });

  it('returns 500 when TABLE_NAME is not configured', async () => {
    delete process.env.TABLE_NAME;
    const { db, commands } = fakeDb();
    assert.equal((await createVendor(db, event(acme))).statusCode, 500);
    assert.equal(commands.length, 0);
  });
});

describe('getVendors', () => {
  it('returns every item in the table', async () => {
    const items = [{ vendorId: '1', ...acme }];
    const { db, commands } = fakeDb(() => ({ Items: items }));
    const result = await getVendors(db);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), items);
    assert.deepEqual((commands[0] as ScanCommand).input, { TableName: 'vendors-test' });
  });

  it('returns an empty array for an empty table', async () => {
    const { db } = fakeDb(() => ({}));
    assert.deepEqual(JSON.parse((await getVendors(db)).body), []);
  });

  it('follows pagination until the scan is complete', async () => {
    const pages = [
      { Items: [{ vendorId: '1' }], LastEvaluatedKey: { vendorId: '1' } },
      { Items: [{ vendorId: '2' }] },
    ];
    const { db, commands } = fakeDb(() => pages.shift());
    const result = await getVendors(db);
    assert.deepEqual(JSON.parse(result.body), [{ vendorId: '1' }, { vendorId: '2' }]);
    assert.equal(commands.length, 2);
    assert.deepEqual((commands[1] as ScanCommand).input.ExclusiveStartKey, { vendorId: '1' });
  });

  it('returns 500 when DynamoDB fails', async () => {
    const { db } = fakeDb(() => {
      throw new Error('boom');
    });
    const result = await getVendors(db);
    assert.equal(result.statusCode, 500);
    assert.deepEqual(JSON.parse(result.body), { error: 'Failed to fetch vendors' });
  });
});

describe('deleteVendor', () => {
  it('deletes by vendorId', async () => {
    const { db, commands } = fakeDb();
    const result = await deleteVendor(db, event({ vendorId: 'abc' }));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), { message: 'Vendor deleted' });
    assert.ok(commands[0] instanceof DeleteCommand);
    assert.deepEqual(commands[0].input, { TableName: 'vendors-test', Key: { vendorId: 'abc' } });
  });

  for (const [label, body] of [
    ['a missing vendorId', {}],
    ['malformed JSON', 'nope'],
  ] as const) {
    it(`rejects ${label} with 400`, async () => {
      const { db, commands } = fakeDb();
      const result = await deleteVendor(db, event(body));
      assert.equal(result.statusCode, 400);
      assert.deepEqual(JSON.parse(result.body), { error: 'vendorId is required' });
      assert.equal(commands.length, 0);
    });
  }

  it('returns 500 when DynamoDB fails', async () => {
    const { db } = fakeDb(() => {
      throw new Error('boom');
    });
    assert.equal((await deleteVendor(db, event({ vendorId: 'abc' }))).statusCode, 500);
  });
});

describe('response headers', () => {
  it('are JSON with no CORS headers: the API is same-origin behind CloudFront', async () => {
    const { db } = fakeDb();
    for (const result of [await getVendors(db), await deleteVendor(db, event({}))]) {
      assert.deepEqual(result.headers, { 'Content-Type': 'application/json' });
    }
  });
});
