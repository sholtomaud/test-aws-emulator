// Service layer for the Vendor REST API.

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

export class VendorApi {
  #url: string;
  #token: () => string | undefined;
  #fetch: typeof fetch;

  /**
   * @param baseUrl  API base URL (with or without a trailing slash)
   * @param token    returns the signed-in user's ID token
   */
  constructor(baseUrl: string, token: () => string | undefined, fetchImpl?: typeof fetch) {
    this.#url = `${baseUrl.replace(/\/+$/, '')}/vendors`;
    this.#token = token;
    this.#fetch = fetchImpl ?? ((...args) => fetch(...args));
  }

  async #request(method: string, failure: string, body?: unknown): Promise<Response> {
    const token = this.#token();
    if (!token) throw new ApiError(401, 'No active session. Please sign in.');
    const response = await this.#fetch(this.#url, {
      method,
      headers: { Authorization: token, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
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
