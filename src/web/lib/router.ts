// Hash router: routes look like "#/g/<groupId>/e/<expenseId>?tab=x".

import { useSyncExternalStore } from 'react';

export type RouteName =
  | 'home' | 'welcome' | 'login' | 'link' | 'reset'
  | 'groups' | 'newGroup' | 'group' | 'groupBalances' | 'groupStats' | 'groupSettings'
  | 'addExpense' | 'editExpense' | 'expense' | 'settle'
  | 'friends' | 'friend' | 'addFriend'
  | 'activity' | 'account' | 'admin'
  | 'join' | 'claim'
  | 'notFound';

export interface Route {
  name: RouteName;
  params: Record<string, string>;
  query: URLSearchParams;
  /** The raw path after "#", without the query. */
  path: string;
}

const PATTERNS: [RouteName, RegExp, string[]][] = [
  ['home', /^\/$/, []],
  ['welcome', /^\/welcome$/, []],
  ['login', /^\/login$/, []],
  ['link', /^\/link(?:\/([^/]+))?$/, ['code']],
  ['reset', /^\/reset\/([^/]+)$/, ['token']],
  ['groups', /^\/groups$/, []],
  ['newGroup', /^\/new-group$/, []],
  ['group', /^\/g\/([^/]+)$/, ['gid']],
  ['groupBalances', /^\/g\/([^/]+)\/balances$/, ['gid']],
  ['groupStats', /^\/g\/([^/]+)\/stats$/, ['gid']],
  ['groupSettings', /^\/g\/([^/]+)\/settings$/, ['gid']],
  ['addExpense', /^\/g\/([^/]+)\/add$/, ['gid']],
  ['editExpense', /^\/g\/([^/]+)\/e\/([^/]+)\/edit$/, ['gid', 'eid']],
  ['expense', /^\/g\/([^/]+)\/e\/([^/]+)$/, ['gid', 'eid']],
  ['settle', /^\/g\/([^/]+)\/settle$/, ['gid']],
  ['friends', /^\/friends$/, []],
  ['friend', /^\/f\/([^/]+)$/, ['key']],
  ['addFriend', /^\/add-friend$/, []],
  ['activity', /^\/activity$/, []],
  ['account', /^\/account$/, []],
  ['admin', /^\/admin$/, []],
  ['join', /^\/join\/([^/]+)$/, ['code']],
  ['claim', /^\/claim\/([^/]+)$/, ['token']],
];

export function parseHash(hash: string): Route {
  let h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!h) h = '/';
  if (!h.startsWith('/')) h = '/' + h;
  const qi = h.indexOf('?');
  const path = qi >= 0 ? h.slice(0, qi) : h;
  const query = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '');
  for (const [name, re, keys] of PATTERNS) {
    const m = re.exec(path);
    if (m) {
      const params: Record<string, string> = {};
      keys.forEach((k, i) => {
        if (m[i + 1] !== undefined) params[k] = decodeURIComponent(m[i + 1]);
      });
      return { name, params, query, path };
    }
  }
  return { name: 'notFound', params: {}, query, path };
}

let current: Route = parseHash(typeof location !== 'undefined' ? location.hash : '');
const listeners = new Set<() => void>();

function emit() {
  current = parseHash(location.hash);
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') window.addEventListener('hashchange', emit);

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

export function getRoute(): Route {
  return current;
}

/** Build an href for a hash route: href('/g/abc') -> "#/g/abc". */
export function href(path: string): string {
  return '#' + (path.startsWith('/') ? path : '/' + path);
}

/** Depth counter so back() knows whether there is an in-app page to go back to. */
let depth = 0;

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const target = href(path);
  if (location.hash === target) return;
  if (opts.replace) {
    history.replaceState(history.state, '', location.pathname + location.search + target);
    emit();
  } else {
    depth++;
    location.hash = target;
  }
}

/** Go back if we navigated inside the app, else replace with the fallback. */
export function back(fallback = '/'): void {
  if (depth > 0) {
    depth--;
    history.back();
  } else {
    navigate(fallback, { replace: true });
  }
}
