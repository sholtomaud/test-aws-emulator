// Vendor business logic, shared by the three Lambda entry points.
// The DynamoDB client is passed in so unit tests can supply a fake.
//
// Every vendor belongs to the user who created it: the table is keyed by
// (ownerId, vendorId), ownerId is the caller's Cognito `sub` claim, which API
// Gateway's Cognito authorizer has already verified, and every operation is
// confined to the caller's own partition.
import { randomUUID } from 'node:crypto';
import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export interface Vendor {
  ownerId: string;
  vendorId: string;
  name: string;
  category: string;
  contactEmail: string;
  createdAt: string;
}

export type Db = Pick<DynamoDBDocumentClient, 'send'>;
type Event = Pick<APIGatewayProxyEvent, 'body'> & {
  requestContext?: { authorizer?: { claims?: Record<string, unknown> } | null };
};

// No CORS headers: the browser calls the API on the site's own origin
// (CloudFront forwards /api/* to API Gateway).
const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
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

/**
 * The caller's user id: the `sub` claim of the ID token the Cognito authorizer
 * verified. Undefined only if the method was deployed without the authorizer.
 */
const ownerOf = (event: Event): string | undefined => {
  const sub = event.requestContext?.authorizer?.claims?.sub;
  return typeof sub === 'string' && sub ? sub : undefined;
};

const unauthorized = () => json(401, { error: 'Unauthorized' });

/** What the API returns for a vendor: the owner is implied by the caller. */
const publicView = ({ ownerId: _ownerId, ...vendor }: Record<string, unknown>) => vendor;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const createVendor = async (db: Db, event: Event): Promise<APIGatewayProxyResult> => {
  const ownerId = ownerOf(event);
  if (!ownerId) return unauthorized();
  const body = parseBody(event);
  const name = text(body?.name);
  const category = text(body?.category);
  const contactEmail = text(body?.contactEmail);
  if (!name || !category || !contactEmail) {
    return json(400, { error: 'name, category and contactEmail are required' });
  }
  try {
    const item: Vendor = {
      ownerId,
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

export const getVendors = async (db: Db, event: Event): Promise<APIGatewayProxyResult> => {
  const ownerId = ownerOf(event);
  if (!ownerId) return unauthorized();
  try {
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await db.send(
        new QueryCommand({
          TableName: tableName(),
          KeyConditionExpression: 'ownerId = :owner',
          ExpressionAttributeValues: { ':owner': ownerId },
          // Only set ExclusiveStartKey when paginating; an explicit `undefined`
          // is rejected by some DynamoDB document client versions.
          ...(ExclusiveStartKey && { ExclusiveStartKey }),
        }),
      );
      items.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return json(200, items.map(publicView));
  } catch (error) {
    console.error('Error fetching vendors:', error);
    return json(500, { error: 'Failed to fetch vendors' });
  }
};

export const deleteVendor = async (db: Db, event: Event): Promise<APIGatewayProxyResult> => {
  const ownerId = ownerOf(event);
  if (!ownerId) return unauthorized();
  const vendorId = text(parseBody(event)?.vendorId);
  if (!vendorId) return json(400, { error: 'vendorId is required' });
  try {
    // The key includes the owner, so this can only ever delete the caller's
    // own vendor; another user's vendorId matches nothing (and, like a
    // DynamoDB delete of a missing item, still answers 200).
    await db.send(new DeleteCommand({ TableName: tableName(), Key: { ownerId, vendorId } }));
    return json(200, { message: 'Vendor deleted' });
  } catch (error) {
    console.error('Error deleting vendor:', error);
    return json(500, { error: 'Failed to delete vendor' });
  }
};
