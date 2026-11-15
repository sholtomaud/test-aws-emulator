// Boba core (https://github.com/sholtomaud/boba, template/src/core at b61b58b), unchanged.
export function html(strings: TemplateStringsArray, ...values: any[]): string {
  return strings.reduce(
    (acc, str, i) => acc + str + (values[i] !== undefined ? values[i] : ''),
    ''
  );
}

export function css(strings: TemplateStringsArray, ...values: any[]): string {
  return strings.reduce(
    (acc, str, i) => acc + str + (values[i] !== undefined ? values[i] : ''),
    ''
  );
}
