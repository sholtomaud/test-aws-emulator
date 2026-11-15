/** Looks up an element that the component's own template is known to contain. */
export const $ = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
};
