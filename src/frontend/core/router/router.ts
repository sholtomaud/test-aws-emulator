// Boba core (https://github.com/sholtomaud/boba, template/src/core at b61b58b).
// Copied as Boba's scaffold does; the only changes are defaults for values
// this project's stricter tsconfig (noUncheckedIndexedAccess) sees as possibly
// undefined.
declare global {
  interface Window {
    BOBA_BASE_URL?: string;
  }
}

export type RouteParams = Record<string, string>;
export type RouteQuery = Record<string, string>;

export interface RouteLocation {
  path: string;
  params: RouteParams;
  query: RouteQuery;
}

// Return false to cancel navigation, a path string to redirect, or
// true/undefined to continue.
export type RouteGuard = (
  to: RouteLocation
) => boolean | string | void | Promise<boolean | string | void>;

export interface RouteDefinition {
  path: string;
  component: string;
  beforeEnter?: RouteGuard;
}

interface RegisteredRoute extends RouteDefinition {
  regex: RegExp;
  paramNames: string[];
}

interface RouteMatch {
  route: RegisteredRoute;
  params: RouteParams;
}

type RoutedElement = HTMLElement & { params?: RouteParams; query?: RouteQuery };

export class Router {
  static instance: Router | undefined;
  routes: RegisteredRoute[] = [];
  currentPath = '';

  constructor() {
    window.addEventListener('popstate', this.handleRoute.bind(this));
  }

  static getInstance(): Router {
    if (!Router.instance) {
      Router.instance = new Router();
    }
    return Router.instance;
  }

  getAppPath(): string {
    const pathname = window.location.pathname;
    const BASE_URL = window.BOBA_BASE_URL || '/';
    const normalizedBaseUrl =
      BASE_URL.endsWith('/') || BASE_URL === '/' ? BASE_URL : BASE_URL + '/';

    if (
      pathname.startsWith(normalizedBaseUrl) &&
      normalizedBaseUrl.length > 1
    ) {
      let appPath = pathname.substring(normalizedBaseUrl.length);
      if (!appPath.startsWith('/')) {
        appPath = '/' + appPath;
      }
      return (appPath === '' ? '/' : appPath) + window.location.search;
    }
    return (
      (pathname.startsWith('/') ? pathname : '/' + pathname) +
      window.location.search
    );
  }

  registerRoute(route: RouteDefinition): void {
    const normalizedPath = route.path.startsWith('/')
      ? route.path
      : '/' + route.path;

    // Convert path like '/user/:id' to a regex and extract parameter names
    const paramNames: string[] = [];
    const regexSource = normalizedPath.replace(
      /:([^/]+)/g,
      (_, paramName: string) => {
        paramNames.push(paramName);
        return '([^\\/]+)';
      }
    );

    const regex = new RegExp(`^${regexSource}$`);
    this.routes.push({ ...route, path: normalizedPath, regex, paramNames });
  }

  navigate(appPath: string): void {
    const pathAndQuery = appPath.startsWith('/') ? appPath : '/' + appPath;
    const BASE_URL = window.BOBA_BASE_URL || '/';

    const [pathPart = '/', queryString] = pathAndQuery.split('?');
    const dummyAbsoluteBase = 'http://dummy';
    const publicPath = new URL(
      pathPart.substring(1),
      dummyAbsoluteBase + (BASE_URL.endsWith('/') ? BASE_URL : BASE_URL + '/')
    ).pathname;

    const finalPath = publicPath + (queryString ? '?' + queryString : '');

    if (window.location.pathname + window.location.search !== finalPath) {
      window.history.pushState({}, '', finalPath);
    }
    this.handleRoute();
  }

  async handleRoute(): Promise<void> {
    const appPathToMatch = this.getAppPath();
    const [pathPart = '/', queryString] = appPathToMatch.split('?');

    const searchParams = new URLSearchParams(queryString || '');
    const query = Object.fromEntries(searchParams.entries());

    const match = this.findRoute(pathPart);

    if (match) {
      const to: RouteLocation = { path: pathPart, params: match.params, query };

      if (match.route.beforeEnter) {
        const guardResult = await match.route.beforeEnter(to);
        if (guardResult === false) {
          if (this.currentPath && this.currentPath !== appPathToMatch) {
            this.navigate(this.currentPath);
          }
          return;
        } else if (typeof guardResult === 'string') {
          this.navigate(guardResult);
          return;
        }
      }

      this.currentPath = appPathToMatch;
      this.loadComponent(match.route.component, match.params, query);
    } else {
      this.show404();
    }
  }

  findRoute(path: string): RouteMatch | null {
    for (const route of this.routes) {
      const match = path.match(route.regex);
      if (match) {
        const params: RouteParams = {};
        route.paramNames.forEach((name, index) => {
          params[name] = decodeURIComponent(match[index + 1] ?? '');
        });
        return { route, params };
      }
    }
    return null;
  }

  async loadComponent(
    tagName: string,
    params: RouteParams = {},
    query: RouteQuery = {}
  ): Promise<void> {
    const outlet = document.querySelector('#router-outlet');
    if (!outlet) return;

    try {
      if (!customElements.get(tagName)) {
        await import(`../../components/${tagName}/${tagName}.ts`);
      }

      const element: RoutedElement = document.createElement(tagName);
      Object.assign(element, params);
      element.params = params;
      element.query = query;

      outlet.innerHTML = '';
      outlet.appendChild(element);
    } catch (error) {
      console.error(`Failed to load component: ${tagName}`, error);
      this.show404();
    }
  }

  show404(): void {
    const outlet = document.querySelector('#router-outlet');
    if (outlet) {
      outlet.innerHTML = '<h1>404 - Page Not Found</h1>';
    }
  }
}
