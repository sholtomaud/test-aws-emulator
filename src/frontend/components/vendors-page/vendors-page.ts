import { BaseComponent } from '../../core/base-component.ts';
import { ApiError } from '../../lib/api.ts';
import type { NewVendor } from '../../lib/api.ts';
import { $ } from '../../lib/dom.ts';
import { api, signOut } from '../../services.ts';
import { appStore } from '../../store/app-store.ts';
import '../vendor-form/vendor-form.ts';
import type { VendorForm } from '../vendor-form/vendor-form.ts';
import '../vendor-list/vendor-list.ts';
import type { VendorList } from '../vendor-list/vendor-list.ts';
import style from './vendors-page.css?raw';
import template from './vendors-page.html?raw';

/** The signed-in page (route `/`): the two-panel vendor dashboard. */
export class VendorsPage extends BaseComponent {
  static tagName = 'vendors-page';

  constructor() {
    super(template, style);
  }

  override init(): void {
    $(this, '#user').textContent = appStore.getState().session?.email ?? '';
    $(this, '#sign-out').addEventListener('click', signOut);

    const form = $<VendorForm>(this, 'vendor-form');
    form.addEventListener('vendor-submit', (event) => {
      const vendor = (event as CustomEvent<NewVendor>).detail;
      form.busy = true;
      void this.#attempt('Failed to add vendor. Please try again.', async () => {
        await api.createVendor(vendor);
        form.reset();
        await this.#loadVendors();
      }).finally(() => (form.busy = false));
    });
    $(this, 'vendor-list').addEventListener('vendor-delete', (event) => {
      const vendorId = (event as CustomEvent<string>).detail;
      void this.#attempt('Failed to delete vendor.', async () => {
        await api.deleteVendor(vendorId);
        await this.#loadVendors();
      });
    });

    void this.#attempt('Failed to load vendors.', () => this.#loadVendors());
  }

  async #loadVendors(): Promise<void> {
    const vendors = await api.getVendors();
    const list = $<VendorList>(this, 'vendor-list');
    list.vendors = vendors;
    list.removeAttribute('aria-busy'); // set until the first load completes
  }

  /** Runs an API action; on failure shows `message`, or signs out on 401 (the router then shows sign-in). */
  async #attempt(message: string, action: () => Promise<void>): Promise<void> {
    const alert = $(this, 'main > [role=alert]');
    alert.hidden = true;
    try {
      await action();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return signOut();
      console.error(error);
      alert.textContent = message;
      alert.hidden = false;
    }
  }
}

if (!customElements.get(VendorsPage.tagName)) customElements.define(VendorsPage.tagName, VendorsPage);
