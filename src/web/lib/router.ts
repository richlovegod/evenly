// Hash router: routes look like "#/g/<groupId>/e/<expenseId>?tab=x".

import { useSyncExternalStore } from 'react';

export type RouteName =
  | 'home' | 'welcome' | 'login' | 'link' | 'reset'
  | 'groups' | 'newGroup' | 'group' | 'groupBalances' | 'groupStats' | 'groupSettings'
  | 'addExpense' | 'editExpense' | 'expense' | 'settle'
  | 'friends' | 'friend' | 'addFriend' | 'inviteFriends'
  | 'activity' | 'account' | 'admin'
  | 'join' | 'claim' | 'invite'
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
  // 邀請朋友: my friend invite link, its QR code and the message to send with it.
  ['inviteFriends', /^\/invite-friends$/, []],
  ['activity', /^\/activity$/, []],
  ['account', /^\/account$/, []],
  ['admin', /^\/admin$/, []],
  ['join', /^\/join\/([^/]+)$/, ['code']],
  ['claim', /^\/claim\/([^/]+)$/, ['token']],
  // A friend invite link (https://<site>/i/<code> lands here, index.html).
  ['invite', /^\/i\/([^/]+)$/, ['code']],
];

/**
 * A path part as typed. One with a broken % escape (a link cut off when pasted, #/join/abc%) stays
 * as it is, so its page says it cannot find it: decodeURIComponent throws on it, and this runs as
 * the app loads, where a throw would leave a blank page.
 */
function decodePart(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

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
        if (m[i + 1] !== undefined) params[k] = decodePart(m[i + 1]);
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

/**
 * How many in-app pages are behind the current one, so back() knows whether there is one to go
 * back to. Each history entry records its own (history.state.evenlyDepth), so the count stays
 * right after the system back or forward button moved through the history, and after a reload.
 */
let depth = 0;

/** The depth the current history entry records (null: none, an entry this app has not seen yet). */
function entryDepth(): number | null {
  const s: unknown = history.state;
  const d = s && typeof s === 'object' ? (s as { evenlyDepth?: unknown }).evenlyDepth : undefined;
  return typeof d === 'number' && Number.isInteger(d) && d >= 0 ? d : null;
}

/** Record `d` in the current history entry, keeping what else its state holds and its address. */
function recordDepth(d: number): void {
  const s: unknown = history.state;
  try {
    history.replaceState({ ...(s && typeof s === 'object' ? s : {}), evenlyDepth: d }, '', location.pathname + location.search + location.hash);
  } catch {
    // Safari refuses after very many calls in a short time: the count in memory still holds.
  }
}

/**
 * Moved to another entry. One that records a depth is a page seen before (the system back or
 * forward button, history.back()). One that records none is new: a plain link or an address
 * typed in, one page further in than the page it came from.
 */
function onHashChange(): void {
  const d = entryDepth();
  if (d === null) {
    depth += 1;
    recordDepth(depth);
  } else {
    depth = d;
  }
  emit();
}

if (typeof history !== 'undefined' && typeof location !== 'undefined') {
  // The page the app opened on: what it records after a reload, else nothing in-app behind it.
  const d = entryDepth();
  depth = d ?? 0;
  if (d === null) recordDepth(0);
}

if (typeof window !== 'undefined') window.addEventListener('hashchange', onHashChange);

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

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const target = href(path);
  if (location.hash === target) return;
  if (opts.replace) {
    // The entry keeps its state, and with it its depth.
    history.replaceState(history.state, '', location.pathname + location.search + target);
    emit();
  } else {
    const next = depth + 1;
    const before = location.hash;
    location.hash = target;
    // The same page after all (the browser's own escaping): no new entry, nothing to record.
    if (location.hash === before) return;
    // The new entry records its depth before its hashchange comes (onHashChange reads it).
    recordDepth(next);
    depth = next;
  }
}

/** Go back if an in-app page is behind this one, else replace with the fallback. */
export function back(fallback = '/'): void {
  if (depth > 0) {
    // Until the entry it lands on says its own (onHashChange), so a second tap does not go back twice.
    depth--;
    history.back();
  } else {
    navigate(fallback, { replace: true });
  }
}
