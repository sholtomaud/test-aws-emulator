// Functional tests: the Lambda handlers, run in-process against DynamoDB in
// AWS Emulator. Needs a running emulator (`make emulator-up`) but no deploy.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { emulatorEndpoint } from '../../scripts/lib/emulator.ts';

emulatorEndpoint();
const TableName = `vendors-functional-${randomUUID().slice(0, 8)}`;
process.env.TABLE_NAME = TableName;

// Import the real entry points only after the environment is set.
const { handler: createVendor } = await import('../../src/lambda/createVendor.ts');
const { handler: getVendors } = await import('../../src/lambda/getVendors.ts');
const { handler: deleteVendor } = await import('../../src/lambda/deleteVendor.ts');

const event = (body: unknown) => ({ body: JSON.stringify(body) }) as Parameters<typeof createVendor>[0];
const list = async () => JSON.parse((await getVendors()).body) as Record<string, string>[];

describe('vendor handlers against emulated DynamoDB', () => {
  const dynamodb = new DynamoDBClient({});

  before(async () => {
    await dynamodb.send(
      new CreateTableCommand({
        TableName,
        AttributeDefinitions: [{ AttributeName: 'vendorId', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'vendorId', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    await waitUntilTableExists({ client: dynamodb, maxWaitTime: 30 }, { TableName });
  });

  after(async () => {
    await dynamodb.send(new DeleteTableCommand({ TableName }));
    dynamodb.destroy();
  });

  it('starts with an empty list', async () => {
    const result = await getVendors();
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), []);
  });

  it('creates, lists and deletes a vendor', async () => {
    const created = await createVendor(event({ name: 'Acme', category: 'SaaS', contactEmail: 'sales@acme.test' }));
    assert.equal(created.statusCode, 201);
    const { vendorId } = JSON.parse(created.body);

    const [vendor, ...rest] = await list();
    assert.equal(rest.length, 0);
    assert.equal(vendor?.vendorId, vendorId);
    assert.equal(vendor?.name, 'Acme');
    assert.equal(vendor?.category, 'SaaS');
    assert.equal(vendor?.contactEmail, 'sales@acme.test');
    assert.ok(Math.abs(Date.now() - Date.parse(vendor?.createdAt ?? '')) < 60_000);

    const deleted = await deleteVendor(event({ vendorId }));
    assert.equal(deleted.statusCode, 200);
    assert.deepEqual(await list(), []);
  });

  it('keeps vendors separate and deletes only the one asked for', async () => {
    const ids = [];
    for (const name of ['One', 'Two', 'Three']) {
      const result = await createVendor(event({ name, category: 'Hardware', contactEmail: `${name}@x.test` }));
      ids.push(JSON.parse(result.body).vendorId as string);
    }
    assert.equal(new Set(ids).size, 3);

    await deleteVendor(event({ vendorId: ids[1] }));
    assert.deepEqual((await list()).map((v) => v.name).sort(), ['One', 'Three']);

    for (const vendorId of ids) await deleteVendor(event({ vendorId }));
  });

  it('treats deleting an unknown vendor as success', async () => {
    assert.equal((await deleteVendor(event({ vendorId: 'does-not-exist' }))).statusCode, 200);
  });

  it('rejects invalid input without writing', async () => {
    assert.equal((await createVendor(event({ name: 'Only a name' }))).statusCode, 400);
    assert.equal((await deleteVendor(event({}))).statusCode, 400);
    assert.deepEqual(await list(), []);
  });

  it('stores text exactly, including markup and unicode', async () => {
    const name = '<img src=x onerror=alert(1)> Żółć 株式会社';
    const { vendorId } = JSON.parse(
      (await createVendor(event({ name, category: 'A & B', contactEmail: 'a@b.test' }))).body,
    );
    assert.equal((await list())[0]?.name, name);
    await deleteVendor(event({ vendorId }));
  });

  it('reports a server error when the table is missing', async (t) => {
    t.mock.method(console, 'error', () => {});
    process.env.TABLE_NAME = 'vendors-no-such-table';
    try {
      assert.equal((await getVendors()).statusCode, 500);
    } finally {
      process.env.TABLE_NAME = TableName;
    }
  });
});
