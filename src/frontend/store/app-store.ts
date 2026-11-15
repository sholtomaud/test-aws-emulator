import { Store } from '../core/store.ts';
import type { Session } from '../lib/auth.ts';

export interface AppState {
  /** The signed-in user's session; undefined when signed out. */
  session: Session | undefined;
}

export const appStore = new Store<AppState>({ session: undefined });
