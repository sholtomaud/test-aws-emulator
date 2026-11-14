// Uploads the built frontend and its config.json to the site bucket in AWS
// Emulator. On AWS the stack's BucketDeployment does this; the emulator cannot
// run that Lambda-backed custom resource, so `make deploy` runs this instead.
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { stackOutputs } from './lib/emulator.ts';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
};

const dist = fileURLToPath(new URL('../dist/frontend/', import.meta.url));
const outputs = await stackOutputs();
const s3 = new S3Client({});
const put = (Key: string, Body: Buffer | string) =>
  s3.send(
    new PutObjectCommand({
      Bucket: outputs.SiteBucketName,
      Key,
      Body,
      ContentType: CONTENT_TYPES[extname(Key)] ?? 'application/octet-stream',
    }),
  );

const files = (await readdir(dist, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
for (const file of files) {
  const path = join(file.parentPath, file.name);
  await put(relative(dist, path).split(sep).join('/'), await readFile(path));
}
// Same content the stack's BucketDeployment writes on AWS.
await put(
  'config.json',
  JSON.stringify({
    apiUrl: '/api',
    apiSigningUrl: outputs.ApiEndpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    userPoolId: outputs.UserPoolId,
    userPoolClientId: outputs.UserPoolClientId,
    identityPoolId: outputs.IdentityPoolId,
  }),
);
console.log(`Published ${files.length + 1} files to s3://${outputs.SiteBucketName}`);
