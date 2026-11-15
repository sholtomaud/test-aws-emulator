// The app's API and auth clients, created once from the runtime config, and
// the sign-in state they share with the components through the store.
import { VendorApi } from './lib/api.ts';
import { CognitoAuth } from './lib/auth.ts';
import type { AppConfig } from './lib/config.ts';
import { appStore } from './store/app-store.ts';

export let auth: CognitoAuth;
export let api: VendorApi;

export const initServices = (config: AppConfig): void => {
  auth = new CognitoAuth(config);
  api = new VendorApi({ baseUrl: config.apiUrl, token: () => auth.session()?.idToken });
  appStore.setState({ session: auth.session() });
};

/** Signs in and tells the app. Rejects with an AuthError on failure. */
export const signIn = async (email: string, password: string): Promise<void> => {
  appStore.setState({ session: await auth.signIn(email, password) });
};

export const signOut = (): void => {
  auth.signOut();
  appStore.setState({ session: undefined });
};
