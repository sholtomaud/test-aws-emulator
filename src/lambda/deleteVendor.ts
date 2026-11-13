import type { APIGatewayProxyEvent } from 'aws-lambda';
import { docClient } from './db.ts';
import { deleteVendor } from './vendors.ts';

export const handler = (event: APIGatewayProxyEvent) => deleteVendor(docClient, event);
