// Local stand-in for the parts of AWS that a browser reaches by DNS name, which
// AWS Emulator serves only on its single local endpoint:
//
//   /            CloudFront: serves the site bucket (default root object, and
//                index.html for unknown paths, like the distribution's 404 rule)
//   /api/*       the API Gateway stage (routed to the emulator by Host header)
//   /cognito     the Cognito user pool endpoint
//   /config.json the deployed config, with the two URLs above swapped in
//
// Everything is fetched from the emulator on each request; nothing is read
// from the working tree, so this serves exactly what was deployed.
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { emulatorEndpoint, stackOutputs } from './lib/emulator.ts';

export interface Gateway {
  url: string;
  close: () => Promise<void>;
}

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

export const startGateway = async ({ port = 8080 }: { port?: number } = {}): Promise<Gateway> => {
  const emulator = emulatorEndpoint();
  const outputs = await stackOutputs();
  const api = new URL(outputs.ApiEndpoint);
  const stagePath = api.pathname.replace(/\/+$/, '');
  const s3 = new S3Client({});

  /** Sends a request to the emulator and pipes the response back. */
  const forward = (
    res: ServerResponse,
    options: { method: string; path: string; host?: string; headers: Record<string, string | undefined> },
    body: Buffer,
  ): void => {
    const headers: Record<string, string | number> = { 'content-length': body.length };
    for (const [name, value] of Object.entries(options.headers)) if (value) headers[name] = value;
    if (options.host) headers.host = options.host;
    const send = emulator.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = send(
      {
        hostname: emulator.hostname,
        port: emulator.port,
        method: options.method,
        path: options.path,
        headers,
        // Verify the emulator's certificate for the address we dial, not for
        // the API's Host header.
        servername: 'localhost',
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: `AWS Emulator is unreachable: ${error.message}` }));
    });
    upstream.end(body);
  };

  const serveObject = async (res: ServerResponse, key: string): Promise<boolean> => {
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: outputs.SiteBucketName, Key: key }));
      res.writeHead(200, {
        'content-type': object.ContentType ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(await object.Body!.transformToByteArray());
      return true;
    } catch (error) {
      if ((error as Error).name === 'NoSuchKey') return false;
      throw error;
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://gateway');
    const method = req.method ?? 'GET';

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // Only pass on what the API reads. Browser headers such as Origin are
      // left out: the emulator refuses requests that look cross-site.
      return forward(
        res,
        {
          method,
          path: stagePath + url.pathname.slice('/api'.length) + url.search,
          host: api.host,
          headers: { authorization: req.headers.authorization, 'content-type': req.headers['content-type'] },
        },
        await readBody(req),
      );
    }

    if (url.pathname === '/cognito' && method === 'POST') {
      return forward(
        res,
        {
          method,
          path: '/',
          headers: {
            'content-type': req.headers['content-type'],
            'x-amz-target': req.headers['x-amz-target'] as string | undefined,
          },
        },
        await readBody(req),
      );
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }

    if (url.pathname === '/config.json') {
      const object = await s3.send(new GetObjectCommand({ Bucket: outputs.SiteBucketName, Key: 'config.json' }));
      const config = JSON.parse(await object.Body!.transformToString());
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...config, apiUrl: '/api', cognitoEndpoint: '/cognito' }));
      return;
    }

    const key = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    if (!(await serveObject(res, key)) && !(await serveObject(res, 'index.html'))) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('The site bucket is empty. Run `make deploy`.');
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error(error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Local gateway error');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Loopback only, except inside the dev container, where the runtime
    // publishes the port on the host's loopback (GATEWAY_BIND=0.0.0.0).
    server.listen(port, process.env.GATEWAY_BIND ?? '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const gateway = await startGateway({ port: Number(process.env.PORT ?? 8080) });
  console.log(`Vendor Tracker (served from AWS Emulator): ${gateway.url}`);
}
