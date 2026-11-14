// Service layer for the Vendor REST API. Requests go to the site's own origin
// (/api, which CloudFront forwards to API Gateway) and are signed with SigV4
// for the API Gateway stage that receives them (IAM auth).
import { signRequest } from './sigv4.ts';
import type { Credentials } from './sigv4.ts';

export interface Vendor {
  vendorId: string;
  name: string;
  category: string;
  contactEmail: string;
  createdAt: string;
}

export type NewVendor = Pick<Vendor, 'name' | 'category' | 'contactEmail'>;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface ApiOptions {
  /** Where requests are sent, e.g. `/api`. */
  baseUrl: string;
  /** The API Gateway stage URL the requests are signed for. */
  signingUrl: string;
  region: string;
  /** Returns the signed-in user's temporary AWS credentials. */
  credentials: () => Credentials | undefined;
  fetch?: typeof fetch;
}

const join = (base: string, path: string): string => `${base.replace(/\/+$/, '')}/${path}`;

export class VendorApi {
  #url: string;
  #signingUrl: string;
  #region: string;
  #credentials: () => Credentials | undefined;
  #fetch: typeof fetch;

  constructor(options: ApiOptions) {
    this.#url = join(options.baseUrl, 'vendors');
    // API Gateway sees /<stage>/api/vendors: CloudFront adds the stage path.
    this.#signingUrl = join(options.signingUrl, 'api/vendors');
    this.#region = options.region;
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
  }

  async #request(method: string, failure: string, body?: unknown): Promise<Response> {
    const credentials = this.#credentials();
    if (!credentials) throw new ApiError(401, 'No active session. Please sign in.');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const signature = await signRequest({
      method,
      url: this.#signingUrl,
      body: payload,
      credentials,
      region: this.#region,
      service: 'execute-api',
    });
    const response = await this.#fetch(this.#url, {
      method,
      headers: { ...signature, ...(payload !== undefined && { 'Content-Type': 'application/json' }) },
      ...(payload !== undefined && { body: payload }),
    });
    // IAM auth answers 403 for missing, expired or rejected credentials.
    if (response.status === 401 || response.status === 403) throw new ApiError(401, 'Your session has expired. Please sign in again.');
    if (!response.ok) throw new ApiError(response.status, failure);
    return response;
  }

  async getVendors(): Promise<Vendor[]> {
    return (await (await this.#request('GET', 'Failed to fetch vendors')).json()) as Vendor[];
  }

  async createVendor(vendor: NewVendor): Promise<void> {
    await this.#request('POST', 'Failed to create vendor', vendor);
  }

  async deleteVendor(vendorId: string): Promise<void> {
    await this.#request('DELETE', 'Failed to delete vendor', { vendorId });
  }
}
