import type { Vendor } from '../lib/api.ts';
import { $, render } from './shared.ts';

/**
 * The "Current Vendors" list. Set `vendors` to render.
 * Fires `vendor-delete` (detail: vendorId) when a Delete button is pressed.
 */
export class VendorList extends HTMLElement {
  #vendors: Vendor[] = [];

  connectedCallback(): void {
    render(
      this,
      /* css */ `
        ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
        li {
          display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;
          padding: 0.9rem 1rem; background: var(--surface);
          border: 1px solid var(--border); border-radius: var(--radius);
        }
        .name { font-weight: 600; overflow-wrap: anywhere; }
        .meta { font-size: 0.875rem; color: var(--muted); overflow-wrap: anywhere; }
        button.delete { flex: none; background: none; border: 0; padding: 0; font-size: 0.875rem; color: var(--danger); }
        button.delete:hover { text-decoration: underline; }
        .empty { font-style: italic; }
      `,
      /* html */ `
        <h2>Current Vendors (<span id="count">0</span>)</h2>
        <p class="empty muted">No vendors yet. Add one using the form.</p>
        <ul></ul>
      `,
    );
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
    const root = this.shadowRoot;
    if (!root) return;
    $(root, '#count').textContent = String(this.#vendors.length);
    $<HTMLElement>(root, '.empty').hidden = this.#vendors.length > 0;
    // Vendor fields are user input: build nodes with textContent, never innerHTML.
    $(root, 'ul').replaceChildren(
      ...this.#vendors.map((vendor) => {
        const item = document.createElement('li');
        const details = document.createElement('div');
        const name = Object.assign(document.createElement('p'), { className: 'name', textContent: vendor.name });
        const meta = Object.assign(document.createElement('p'), {
          className: 'meta',
          textContent: `${vendor.category} · ${vendor.contactEmail}`,
        });
        details.append(name, meta);
        const remove = Object.assign(document.createElement('button'), {
          className: 'delete',
          type: 'button',
          textContent: 'Delete',
        });
        remove.setAttribute('aria-label', `Delete ${vendor.name}`);
        remove.addEventListener('click', () => {
          remove.disabled = true;
          this.dispatchEvent(
            new CustomEvent<string>('vendor-delete', { detail: vendor.vendorId, bubbles: true, composed: true }),
          );
        });
        item.append(details, remove);
        return item;
      }),
    );
  }
}

customElements.define('vendor-list', VendorList);
