import type { NewVendor } from '../lib/api.ts';
import { $, render } from './shared.ts';

/**
 * The "Add New Vendor" form. Fires `vendor-submit` (detail: NewVendor).
 * The owner sets `busy` while saving and calls `reset()` on success.
 */
export class VendorForm extends HTMLElement {
  connectedCallback(): void {
    const root = render(
      this,
      '',
      /* html */ `
        <h2>Add New Vendor</h2>
        <form>
          <div class="field">
            <label for="name">Vendor name</label>
            <input id="name" name="name" placeholder="Vendor Name" required />
          </div>
          <div class="field">
            <label for="category">Category</label>
            <input id="category" name="category" placeholder="Category (e.g. SaaS, Hardware)" required />
          </div>
          <div class="field">
            <label for="contactEmail">Contact email</label>
            <input id="contactEmail" name="contactEmail" type="email" placeholder="Contact Email" required />
          </div>
          <button class="primary" type="submit">Add Vendor</button>
        </form>
      `,
    );
    const form = $<HTMLFormElement>(root, 'form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const value = (name: string) => String(data.get(name) ?? '').trim();
      const detail: NewVendor = {
        name: value('name'),
        category: value('category'),
        contactEmail: value('contactEmail'),
      };
      this.dispatchEvent(new CustomEvent<NewVendor>('vendor-submit', { detail, bubbles: true, composed: true }));
    });
  }

  set busy(busy: boolean) {
    const button = this.shadowRoot?.querySelector<HTMLButtonElement>('button[type=submit]');
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? 'Saving...' : 'Add Vendor';
  }

  reset(): void {
    this.shadowRoot?.querySelector('form')?.reset();
  }
}

customElements.define('vendor-form', VendorForm);
