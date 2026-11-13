import type { APIGatewayProxyEvent } from 'aws-lambda';
import { docClient } from './db.ts';
import { createVendor } from './vendors.ts';

export const handler = (event: APIGatewayProxyEvent) => createVendor(docClient, event);
