// AWS Signature Version 4 for the browser, on the Web Crypto API, so the app
// can call an IAM-authorized API Gateway without an AWS SDK.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  /** The URL the signature is for. Its host is signed, so it must be the host that receives the request. */
  url: string;
  body?: string;
  credentials: Credentials;
  region: string;
  service: string;
  /** Defaults to now. */
  date?: Date;
}

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

const sha256 = async (data: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', encoder.encode(data)));

const hmac = async (key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> => {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
};

/** RFC 3986 encoding, as SigV4 requires: everything but A-Z a-z 0-9 - _ . ~ */
const encode = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** Each path segment is encoded once more (for every service but S3). */
const canonicalPath = (pathname: string): string => pathname.split('/').map(encode).join('/') || '/';

const canonicalQuery = (params: URLSearchParams): string =>
  [...params]
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([a, x], [b, y]) => (a! < b! ? -1 : a! > b! ? 1 : x! < y! ? -1 : x! > y! ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

/**
 * Returns the headers that sign the request: Authorization, X-Amz-Date and,
 * for temporary credentials, X-Amz-Security-Token. The signature covers the
 * method, URL, body and those headers (plus host, which the request carries).
 */
export const signRequest = async (input: SignInput): Promise<Record<string, string>> => {
  const url = new URL(input.url);
  const amzDate = (input.date ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: url.host, 'x-amz-date': amzDate };
  if (input.credentials.sessionToken) headers['x-amz-security-token'] = input.credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    names.map((name) => `${name}:${headers[name]!.trim()}\n`).join(''),
    signedHeaders,
    await sha256(input.body ?? ''),
  ].join('\n');

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonicalRequest)].join('\n');

  let key: ArrayBuffer = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), day);
  for (const part of [input.region, input.service, 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));

  const { host: _host, ...signing } = headers; // the browser sets Host itself
  return {
    ...Object.fromEntries(Object.entries(signing).map(([name, value]) => [name === 'x-amz-date' ? 'X-Amz-Date' : 'X-Amz-Security-Token', value])),
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
};
