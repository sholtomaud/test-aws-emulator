// Boba core (https://github.com/sholtomaud/boba, template/src/core at b61b58b), unchanged.
import { html, css } from './template-helpers.ts';

export { html, css };

export class BaseComponent extends HTMLElement {
  template: HTMLTemplateElement;

  constructor(htmlContent: string, cssContent: string) {
    super();
    const tagName = this.tagName.toLowerCase();
    const scopedCss = cssContent.replace(/:host/g, tagName);
    this.template = document.createElement('template');
    this.template.innerHTML = `<style>${scopedCss}</style>${htmlContent}`;
  }

  connectedCallback() {
    this.appendChild(this.template.content.cloneNode(true));
    this.init();
  }

  init() {}
}
