// Boba core (https://github.com/sholtomaud/boba, template/src/core at b61b58b), unchanged.
export class Store<T extends object> extends EventTarget {
  private state: T;

  constructor(initialState: T) {
    super();
    this.state = { ...initialState };
  }

  getState(): T {
    return { ...this.state };
  }

  setState(newState: Partial<T>): void {
    this.state = { ...this.state, ...newState };
    this.dispatchEvent(new CustomEvent('change', { detail: this.getState() }));
  }
}
