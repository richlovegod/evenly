// lib/router.ts back() after the system back or forward button, a plain link and a reload (review
// of 2026-11-07, unit W2): each history entry records how many in-app pages are behind it, so the
// in-app 返回 goes back only when there is an app page to go back to, and otherwise replaces the
// page with its fallback instead of doing nothing or leaving the site. Also: a broken % escape in
// the address the app opens on does not stop it from loading. The browser here is a fake with a
// real session history: entries with their state, hash navigations that add an entry and fire
// hashchange as a later task, and history.back() that moves through them later too.

import { afterEach, describe, expect, it, vi } from 'vitest';

type RouterModule = typeof import('../../src/web/lib/router');

const ORIGIN = 'https://split.test';

interface Entry {
  hash: string;
  state: unknown;
}

interface Browser {
  entries: Entry[];
  at: number;
  /** history.back() at the first entry: a real browser does nothing, or leaves the site. */
  backPastStart: number;
  /** Run what the browser does after the current task: hashchange events, traversals. */
  run: () => void;
  /** The system back and forward buttons (not through the router). */
  systemBack: () => void;
  systemForward: () => void;
  /** A plain <a href="#/..."> tapped: a new entry, without navigate(). */
  follow: (hash: string) => void;
}

function newBrowser(firstHash: string, firstState: unknown = null, entries?: Entry[], at?: number): Browser {
  const b = {
    entries: entries ?? [{ hash: firstHash, state: firstState }],
    at: at ?? 0,
    backPastStart: 0,
  } as Browser;
  const handlers: ((e: unknown) => void)[] = [];
  const tasks: (() => void)[] = [];
  const fire = () => {
    for (const h of handlers) h({ type: 'hashchange' });
  };
  const pushHash = (v: string) => {
    const h = v.startsWith('#') ? v : '#' + v;
    if (h === b.entries[b.at].hash) return;
    b.entries.splice(b.at + 1, b.entries.length, { hash: h, state: null });
    b.at++;
    tasks.push(fire);
  };
  const go = (delta: number) => {
    tasks.push(() => {
      const to = b.at + delta;
      if (to < 0) {
        b.backPastStart++;
        return;
      }
      if (to >= b.entries.length) return;
      const before = b.entries[b.at].hash;
      b.at = to;
      if (b.entries[b.at].hash !== before) fire();
    });
  };
  b.run = () => {
    while (tasks.length) tasks.shift()!();
  };
  b.systemBack = () => go(-1);
  b.systemForward = () => go(1);
  b.follow = pushHash;
  const location = {
    origin: ORIGIN,
    pathname: '/',
    search: '',
    get href() {
      return ORIGIN + '/' + b.entries[b.at].hash;
    },
    get hash() {
      return b.entries[b.at].hash;
    },
    set hash(v: string) {
      pushHash(v);
    },
  };
  const history = {
    get state() {
      return b.entries[b.at].state;
    },
    get length() {
      return b.entries.length;
    },
    replaceState(state: unknown, _title: string, url?: string) {
      const hash = url === undefined ? b.entries[b.at].hash : new URL(url, ORIGIN + '/').hash;
      b.entries[b.at] = { hash, state: structuredClone(state) };
    },
    back: () => go(-1),
  };
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', history);
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'hashchange') handlers.push(fn);
    },
    removeEventListener: () => undefined,
  });
  return b;
}

async function loadRouter(): Promise<RouterModule> {
  vi.resetModules();
  return import('../../src/web/lib/router');
}

const hashes = (b: Browser) => b.entries.map(e => e.hash);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('back() after the system back button', () => {
  it('opened deep (a notification, a shared link): back to it with the system button, then 返回 replaces it with the fallback', async () => {
    const b = newBrowser('#/g/abc');
    const r = await loadRouter();
    r.navigate('/g/abc/e/x');
    b.run();
    b.systemBack();
    b.run();
    expect(r.getRoute().path).toBe('/g/abc');
    // The group header's 返回: no app page behind this one, so it goes to 總覽 in place.
    r.back('/');
    b.run();
    expect(b.backPastStart).toBe(0);
    expect(hashes(b)).toEqual(['#/', '#/g/abc/e/x']);
    expect(b.at).toBe(0);
    expect(r.getRoute().name).toBe('home');
  });

  it('inside the app, 返回 goes back step by step, then replaces at the page the app opened on', async () => {
    const b = newBrowser('#/');
    const r = await loadRouter();
    r.navigate('/g/abc');
    b.run();
    r.navigate('/g/abc/e/x');
    b.run();
    r.back('/g/abc');
    b.run();
    expect(r.getRoute().path).toBe('/g/abc');
    r.back('/');
    b.run();
    expect(r.getRoute().path).toBe('/');
    expect(b.at).toBe(0);
    r.back('/groups');
    b.run();
    expect(b.backPastStart).toBe(0);
    expect(b.entries[0].hash).toBe('#/groups');
  });

  it('after the forward button, 返回 goes back again', async () => {
    const b = newBrowser('#/');
    const r = await loadRouter();
    r.navigate('/g/abc');
    b.run();
    b.systemBack();
    b.run();
    b.systemForward();
    b.run();
    expect(r.getRoute().path).toBe('/g/abc');
    r.back('/');
    b.run();
    expect(b.at).toBe(0);
    expect(hashes(b)).toEqual(['#/', '#/g/abc']);
  });

  it('two quick taps on 返回 do not go back past the app', async () => {
    const b = newBrowser('#/');
    const r = await loadRouter();
    r.navigate('/g/abc');
    b.run();
    r.back('/');
    r.back('/');
    b.run();
    expect(b.backPastStart).toBe(0);
  });
});

describe('back() after a plain link and after a reload', () => {
  it('a plain link (編輯 without navigate) counts as a step: 取消 goes back to the entry instead of stacking it again', async () => {
    const b = newBrowser('#/g/abc');
    const r = await loadRouter();
    r.navigate('/g/abc/e/x');
    b.run();
    b.follow('#/g/abc/e/x/edit');
    b.run();
    r.back('/g/abc/e/x');
    b.run();
    expect(hashes(b)).toEqual(['#/g/abc', '#/g/abc/e/x', '#/g/abc/e/x/edit']);
    expect(b.at).toBe(1);
    r.back('/g/abc');
    b.run();
    expect(b.at).toBe(0);
    expect(b.backPastStart).toBe(0);
  });

  it('a reload keeps the count of the entry it reloads', async () => {
    const b = newBrowser('#/');
    let r = await loadRouter();
    r.navigate('/g/abc');
    b.run();
    // Reload: the same history, a fresh router.
    const again = newBrowser('', null, b.entries, b.at);
    r = await loadRouter();
    r.back('/');
    again.run();
    expect(again.at).toBe(0);
    expect(again.backPastStart).toBe(0);
    expect(hashes(again)).toEqual(['#/', '#/g/abc']);
  });

  it('replace navigations keep the entry\'s count', async () => {
    const b = newBrowser('#/');
    const r = await loadRouter();
    r.navigate('/g/abc');
    b.run();
    r.navigate('/g/abc/balances', { replace: true });
    r.back('/');
    b.run();
    expect(b.at).toBe(0);
    expect(hashes(b)).toEqual(['#/', '#/g/abc/balances']);
  });
});

describe('the address the app opens on', () => {
  it('with a broken % escape (a link cut off when pasted) still loads, and the page gets the text as typed', async () => {
    newBrowser('#/join/abc%');
    const r = await loadRouter();
    expect(r.getRoute()).toMatchObject({ name: 'join', params: { code: 'abc%' } });
  });
});
