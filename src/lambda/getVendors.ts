import type { APIGatewayProxyEvent } from 'aws-lambda';
import { docClient } from './db.ts';
import { getVendors } from './vendors.ts';

export const handler = (event: APIGatewayProxyEvent) => getVendors(docClient, event);
