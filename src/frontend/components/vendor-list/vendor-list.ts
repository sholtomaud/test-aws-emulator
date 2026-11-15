import { BaseComponent } from '../../core/base-component.ts';
import type { Vendor } from '../../lib/api.ts';
import { $ } from '../../lib/dom.ts';
import style from './vendor-list.css?raw';
import template from './vendor-list.html?raw';

/**
 * The "Current Vendors" list. Set `vendors` to render.
 * Fires `vendor-delete` (detail: vendorId) when a Delete button is pressed.
 */
export class VendorList extends BaseComponent {
  static tagName = 'vendor-list';
  #vendors: Vendor[] = [];

  constructor() {
    super(template, style);
  }

  override init(): void {
    this.#update();
  }

  get vendors(): Vendor[] {
    return this.#vendors;
  }

  set vendors(vendors: Vendor[]) {
    // Newest first, so a vendor just added appears at the top.
    this.#vendors = [...vendors].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    this.#update();
  }

  #update(): void {
    const item = this.querySelector<HTMLTemplateElement>('#vendor-item-template');
    if (!item) return; // not connected yet; init() renders
    $(this, '#count').textContent = String(this.#vendors.length);
    $(this, '.empty').hidden = this.#vendors.length > 0;
    // Vendor fields are user input: fill the cloned nodes with textContent, never innerHTML.
    $(this, 'ul').replaceChildren(
      ...this.#vendors.map((vendor) => {
        const row = item.content.cloneNode(true) as DocumentFragment;
        $(row, '.name').textContent = vendor.name;
        $(row, '.meta').textContent = `${vendor.category} · ${vendor.contactEmail}`;
        const remove = $<HTMLButtonElement>(row, 'button.delete');
        remove.setAttribute('aria-label', `Delete ${vendor.name}`);
        remove.addEventListener('click', () => {
          remove.disabled = true;
          this.dispatchEvent(new CustomEvent<string>('vendor-delete', { detail: vendor.vendorId, bubbles: true }));
        });
        return row;
      }),
    );
  }
}

if (!customElements.get(VendorList.tagName)) customElements.define(VendorList.tagName, VendorList);
