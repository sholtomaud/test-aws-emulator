// Entry point: loads the runtime config, registers the routes and boots
// Boba's router. The stylesheet import is bundled by Vite.
import './styles/global.css';
import { Router } from './core/router/router.ts';
import { loadConfig } from './lib/config.ts';
import { auth, initServices } from './services.ts';
import { appStore } from './store/app-store.ts';

const router = Router.getInstance();
// The page components are loaded by the router on first use. The guards ask
// the auth client, not the store, so an expired session counts as signed out.
router.registerRoute({ path: '/', component: 'vendors-page', beforeEnter: () => (auth.session() ? true : '/sign-in') });
router.registerRoute({ path: '/sign-in', component: 'sign-in-page', beforeEnter: () => (auth.session() ? '/' : true) });

try {
  initServices(await loadConfig());
  // Signing in or out anywhere in the app moves to the matching page.
  appStore.addEventListener('change', () => router.navigate(appStore.getState().session ? '/' : '/sign-in'));
  router.navigate(router.getAppPath());
} catch (error) {
  const alert = Object.assign(document.createElement('div'), {
    className: 'startup-error',
    textContent: error instanceof Error ? error.message : 'Failed to start.',
  });
  alert.setAttribute('role', 'alert');
  document.querySelector('#router-outlet')?.replaceChildren(alert);
}
