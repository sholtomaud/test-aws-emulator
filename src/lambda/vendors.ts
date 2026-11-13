// Vendor business logic, shared by the three Lambda entry points.
// The DynamoDB client is passed in so unit tests can supply a fake.
import { randomUUID } from 'node:crypto';
import { DeleteCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export interface Vendor {
  vendorId: string;
  name: string;
  category: string;
  contactEmail: string;
  createdAt: string;
}

export type Db = Pick<DynamoDBDocumentClient, 'send'>;
type Event = Pick<APIGatewayProxyEvent, 'body'>;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'OPTIONS,POST,GET,DELETE',
};

const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: { ...CORS, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const tableName = (): string => {
  const name = process.env.TABLE_NAME;
  if (!name) throw new Error('TABLE_NAME is not set');
  return name;
};

/** Parses a JSON object body; returns undefined when it is missing or malformed. */
const parseBody = (event: Event): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(event.body ?? '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const createVendor = async (db: Db, event: Event): Promise<APIGatewayProxyResult> => {
  const body = parseBody(event);
  const name = text(body?.name);
  const category = text(body?.category);
  const contactEmail = text(body?.contactEmail);
  if (!name || !category || !contactEmail) {
    return json(400, { error: 'name, category and contactEmail are required' });
  }
  try {
    const item: Vendor = {
      vendorId: randomUUID(),
      name,
      category,
      contactEmail,
      createdAt: new Date().toISOString(),
    };
    await db.send(new PutCommand({ TableName: tableName(), Item: item }));
    return json(201, { message: 'Vendor created', vendorId: item.vendorId });
  } catch (error) {
    console.error('Error creating vendor:', error);
    return json(500, { error: 'Failed to create vendor' });
  }
};

export const getVendors = async (db: Db): Promise<APIGatewayProxyResult> => {
  try {
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await db.send(
        // Only set ExclusiveStartKey when paginating; an explicit `undefined`
        // is rejected by some DynamoDB document client versions.
        new ScanCommand({ TableName: tableName(), ...(ExclusiveStartKey && { ExclusiveStartKey }) }),
      );
      items.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return json(200, items);
  } catch (error) {
    console.error('Error fetching vendors:', error);
    return json(500, { error: 'Failed to fetch vendors' });
  }
};

export const deleteVendor = async (db: Db, event: Event): Promise<APIGatewayProxyResult> => {
  const vendorId = text(parseBody(event)?.vendorId);
  if (!vendorId) return json(400, { error: 'vendorId is required' });
  try {
    await db.send(new DeleteCommand({ TableName: tableName(), Key: { vendorId } }));
    return json(200, { message: 'Vendor deleted' });
  } catch (error) {
    console.error('Error deleting vendor:', error);
    return json(500, { error: 'Failed to delete vendor' });
  }
};
