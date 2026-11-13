import { ApiError, VendorApi } from '../lib/api.ts';
import type { NewVendor } from '../lib/api.ts';
import { CognitoAuth } from '../lib/auth.ts';
import { loadConfig } from '../lib/config.ts';
import './auth-panel.ts';
import type { AuthPanel } from './auth-panel.ts';
import { $, render } from './shared.ts';
import './vendor-form.ts';
import type { VendorForm } from './vendor-form.ts';
import './vendor-list.ts';
import type { VendorList } from './vendor-list.ts';

/** Application shell: shows the sign-in panel or the two-panel vendor dashboard. */
export class VendorApp extends HTMLElement {
  #auth!: CognitoAuth;
  #api!: VendorApi;

  async connectedCallback(): Promise<void> {
    try {
      const config = await loadConfig();
      this.#auth = new CognitoAuth(config);
      this.#api = new VendorApi(config.apiUrl, () => this.#auth.session()?.idToken);
    } catch (error) {
      const root = render(this, 'main { max-width: 40rem; margin: 4rem auto; padding: 0 1rem; }', '<main><div role="alert"></div></main>');
      $(root, '[role=alert]').textContent = error instanceof Error ? error.message : 'Failed to start.';
      return;
    }
    this.#show();
  }

  #show(): void {
    if (this.#auth.session()) this.#showDashboard();
    else this.#showSignIn();
  }

  #showSignIn(): void {
    const root = render(this, '', '<auth-panel></auth-panel>');
    const panel = $<AuthPanel>(root, 'auth-panel');
    panel.auth = this.#auth;
    panel.addEventListener('signed-in', () => this.#showDashboard());
  }

  #showDashboard(): void {
    const root = render(
      this,
      /* css */ `
        main { max-width: 64rem; margin: 0 auto; padding: 2.5rem 1.25rem; }
        header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 2rem; }
        h1 { font-size: 1.875rem; line-height: 1.2; }
        .account { text-align: right; font-size: 0.875rem; }
        .panels { display: grid; gap: 2.5rem; grid-template-columns: 1fr; }
        @media (min-width: 48rem) { .panels { grid-template-columns: 1fr 1fr; } }
      `,
      /* html */ `
        <main>
          <header>
            <div>
              <h1>Vendor Tracker</h1>
              <p class="muted">Manage your vendors, stored in AWS DynamoDB.</p>
            </div>
            <div class="account">
              <p id="user" class="muted"></p>
              <button id="sign-out" class="link" type="button">Sign out</button>
            </div>
          </header>
          <div role="alert" hidden></div>
          <div class="panels">
            <vendor-form></vendor-form>
            <vendor-list aria-busy="true"></vendor-list>
          </div>
        </main>
      `,
    );
    $(root, '#user').textContent = this.#auth.session()?.email ?? '';
    $(root, '#sign-out').addEventListener('click', () => {
      this.#auth.signOut();
      this.#showSignIn();
    });

    const form = $<VendorForm>(root, 'vendor-form');
    form.addEventListener('vendor-submit', (event) => {
      const vendor = (event as CustomEvent<NewVendor>).detail;
      form.busy = true;
      void this.#attempt('Failed to add vendor. Please try again.', async () => {
        await this.#api.createVendor(vendor);
        form.reset();
        await this.#loadVendors();
      }).finally(() => (form.busy = false));
    });
    $(root, 'vendor-list').addEventListener('vendor-delete', (event) => {
      const vendorId = (event as CustomEvent<string>).detail;
      void this.#attempt('Failed to delete vendor.', async () => {
        await this.#api.deleteVendor(vendorId);
        await this.#loadVendors();
      });
    });

    void this.#attempt('Failed to load vendors.', () => this.#loadVendors());
  }

  async #loadVendors(): Promise<void> {
    const vendors = await this.#api.getVendors();
    const list = this.shadowRoot?.querySelector<VendorList>('vendor-list');
    if (!list) return;
    list.vendors = vendors;
    list.removeAttribute('aria-busy'); // set until the first load completes
  }

  /** Runs an API action; on failure shows `message`, or returns to sign-in on 401. */
  async #attempt(message: string, action: () => Promise<void>): Promise<void> {
    const alert = this.shadowRoot?.querySelector<HTMLElement>('main > [role=alert]');
    if (alert) alert.hidden = true;
    try {
      await action();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.#auth.signOut();
        this.#showSignIn();
        return;
      }
      console.error(error);
      if (alert?.isConnected) {
        alert.textContent = message;
        alert.hidden = false;
      }
    }
  }
}

customElements.define('vendor-app', VendorApp);
