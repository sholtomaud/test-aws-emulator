// Styles shared by every component's shadow root.
export const sharedStyles = /* css */ `
  :host { display: block; }
  * { box-sizing: border-box; }
  h1, h2, p { margin: 0; }
  h2 { font-size: 1.125rem; font-weight: 600; margin-bottom: 1rem; }
  label { display: block; font-size: 0.875rem; color: var(--muted); margin-bottom: 0.25rem; }
  input {
    width: 100%; padding: 0.55rem 0.7rem; font: inherit; color: var(--text);
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button { font: inherit; cursor: pointer; border-radius: var(--radius); }
  button.primary {
    width: 100%; padding: 0.6rem 1rem; border: 0; font-weight: 600;
    background: var(--accent); color: var(--on-accent);
  }
  button.primary:hover:not(:disabled) { background: var(--accent-hover); }
  button:disabled { opacity: 0.6; cursor: progress; }
  button.link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; }
  .field { margin-bottom: 0.9rem; }
  .muted { color: var(--muted); }
  [role="alert"] {
    margin-bottom: 1rem; padding: 0.6rem 0.8rem; border-radius: var(--radius);
    background: var(--danger-bg); color: var(--danger);
  }
  [hidden] { display: none !important; }
`;

/** Attaches an open shadow root with the shared styles plus `css`, and `html` as content. */
export const render = (host: HTMLElement, css: string, html: string): ShadowRoot => {
  const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${sharedStyles}${css}</style>${html}`;
  return root;
};

/** Looks up an element that the component's own template is known to contain. */
export const $ = <T extends Element = HTMLElement>(root: ShadowRoot, selector: string): T => {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};
