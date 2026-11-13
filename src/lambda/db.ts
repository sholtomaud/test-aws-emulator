import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Endpoint, region and credentials come from the environment, so the same code
// runs on AWS and against AWS Emulator.
export const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
