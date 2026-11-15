import { BaseComponent } from '../../core/base-component.ts';
import type { NewVendor } from '../../lib/api.ts';
import { $ } from '../../lib/dom.ts';
import style from './vendor-form.css?raw';
import template from './vendor-form.html?raw';

/**
 * The "Add New Vendor" form. Fires `vendor-submit` (detail: NewVendor).
 * The owner sets `busy` while saving and calls `reset()` on success.
 */
export class VendorForm extends BaseComponent {
  static tagName = 'vendor-form';

  constructor() {
    super(template, style);
  }

  override init(): void {
    const form = $<HTMLFormElement>(this, 'form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const value = (name: string) => String(data.get(name) ?? '').trim();
      const detail: NewVendor = {
        name: value('name'),
        category: value('category'),
        contactEmail: value('contactEmail'),
      };
      this.dispatchEvent(new CustomEvent<NewVendor>('vendor-submit', { detail, bubbles: true }));
    });
  }

  set busy(busy: boolean) {
    const button = this.querySelector<HTMLButtonElement>('button[type=submit]');
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? 'Saving...' : 'Add Vendor';
  }

  reset(): void {
    this.querySelector('form')?.reset();
  }
}

if (!customElements.get(VendorForm.tagName)) customElements.define(VendorForm.tagName, VendorForm);
