// Service layer for the Vendor REST API. Requests go to the site's own origin
// (/api, which CloudFront forwards to API Gateway) with the signed-in user's ID
// token, which API Gateway's Cognito authorizer checks.

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
  /** Returns the signed-in user's ID token. */
  token: () => string | undefined;
  fetch?: typeof fetch;
}

export class VendorApi {
  #url: string;
  #token: () => string | undefined;
  #fetch: typeof fetch;

  constructor(options: ApiOptions) {
    this.#url = `${options.baseUrl.replace(/\/+$/, '')}/vendors`;
    this.#token = options.token;
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
  }

  async #request(method: string, failure: string, body?: unknown): Promise<Response> {
    const token = this.#token();
    if (!token) throw new ApiError(401, 'No active session. Please sign in.');
    const response = await this.#fetch(this.#url, {
      method,
      headers: { Authorization: token, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    // The Cognito authorizer answers 401 for a missing, expired or invalid token.
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
