// What screen readers hear and what the in-app browser hint says on 我的, 登入 and the owner page
// (review-1106, unit W4), rendered with react-dom/server in a fake browser (globalThis fakes, as
// in email-code.test.ts; the Worker is a fake fetch): 在其他裝置登入's code panel is no live region
// and one status line says only that the code is ready or expired; a reset link's box is no live
// region either; each 連結 on 登入方式 names its provider; the in-app browser hint spaces Safari
// but not 瀏覽器 (DESIGN.md 13.2); and the owner page counts an account with Apple or Google
// linked as one that signs in anywhere, and says how.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Locale, UserDTO } from '../../src/shared/types';

class MemoryStorage {
  readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

const ORIGIN = 'https://split.test';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const LINE_ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 Line/15.17.0';
const LINE_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.17.0';
const FACEBOOK_ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/500.0.0.0;]';

/** A sign-in code the fake Worker hands out (POST /api/auth/link-code). */
const CODE = 'ABCD2345';

/** A fresh browser on 我的 (fakes on globalThis), the app's modules loaded again in `locale`. */
async function browser(ua: string, locale: Locale, storage: Record<string, string> = {}) {
  const ls = new MemoryStorage();
  ls.setItem('evenly.locale', locale);
  for (const [k, v] of Object.entries(storage)) ls.setItem(k, v);
  const location = { origin: ORIGIN, href: ORIGIN + '/#/account', pathname: '/', search: '', hash: '#/account', reload: () => undefined };
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  vi.stubGlobal('BroadcastChannel', undefined);
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', { state: null, replaceState: () => undefined, back: () => undefined });
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('document', { cookie: '', visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined, documentElement: {} });
  vi.stubGlobal('navigator', { onLine: true, userAgent: ua, language: locale, languages: [locale], platform: /iPhone/.test(ua) ? 'iPhone' : 'Linux armv81', maxTouchPoints: 5 });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, ORIGIN).pathname;
    if ((init.method ?? 'GET') === 'POST' && path === '/api/auth/link-code') {
      return new Response(JSON.stringify({ code: CODE, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'none' } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  });
  vi.resetModules();
  const i18n = await import('../../src/web/lib/i18n');
  i18n.setLocale(locale);
  return i18n;
}

function userOf(over: Partial<UserDTO> = {}): UserDTO {
  return {
    id: 'u-gino', name: 'Gino', email: null, emailVerified: false, hasPassword: false, googleLinked: false, appleLinked: false, locale: 'en', currency: 'USD', color: '#000000',
    payInfo: '', venmo: '', paypal: '', isAdmin: false, createdAt: '2026-10-25T00:00:00.000Z', avatar: null, ...over,
  };
}

/** The text of the first element with `attr` in rendered HTML (tags stripped), or null. */
function textOf(html: string, attr: string): string | null {
  const i = html.indexOf(attr);
  if (i < 0) return null;
  const open = html.lastIndexOf('<', i);
  const tag = /^<([a-z0-9]+)/.exec(html.slice(open))![1];
  const start = html.indexOf('>', i) + 1;
  const end = html.indexOf('</' + tag + '>', start);
  return html.slice(start, end).replace(/<[^>]+>/g, '');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('在其他裝置登入 for screen readers', () => {
  it('the code panel is no live region: one status line says the code is ready, then that it expired, never the countdown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const locale of ['zh-TW', 'en'] as const) {
      vi.setSystemTime(new Date('2026-11-07T10:00:00.000Z'));
      const i18n = await browser(SAFARI, locale);
      const { makeCode } = await import('../../src/web/features/account/linkCode');
      const { DevicesSection } = await import('../../src/web/features/account/DevicesSection');
      const { clockTime } = await import('../../src/web/features/auth/Receipt');
      await makeCode('device');
      const html = renderToStaticMarkup(createElement(DevicesSection, { deviceOnly: false }));
      expect(html).toContain('ABCD-2345');
      // The countdown is on screen, and in no live region.
      expect(html).toContain('10:00');
      expect(html).not.toContain('aria-live');
      expect(html.match(/role="status"/g)).toHaveLength(1);
      const ready = textOf(html, 'role="status"');
      // The clock time it stops working (in this machine's time zone), true however late it is read (review W4-a11y-text-02).
      const until = clockTime('2026-11-07T10:10:00.000Z', locale === 'zh-TW', i18n.formatTime);
      expect(ready).toBe(locale === 'zh-TW' ? `已產生登入碼，${until} 前有效，只能用一次` : `Sign-in code ready. It works until ${until}, once.`);
      if (locale === 'zh-TW') expect(ready).toMatch(/^已產生登入碼，\d{2}:\d{2} 前有效，只能用一次$/);
      // A second later only the countdown moved.
      vi.setSystemTime(new Date('2026-11-07T10:00:01.000Z'));
      const later = renderToStaticMarkup(createElement(DevicesSection, { deviceOnly: false }));
      expect(later).toContain('9:59');
      expect(textOf(later, 'role="status"')).toBe(ready);
      vi.setSystemTime(new Date('2026-11-07T10:11:00.000Z'));
      const expired = renderToStaticMarkup(createElement(DevicesSection, { deviceOnly: false }));
      expect(textOf(expired, 'role="status"')).toBe(locale === 'zh-TW' ? '登入碼過期了，再產生一組就好' : 'The code expired. Make a new one.');
    }
  });

  it('without a code the status line is there, empty, so the first code is read out when it comes', async () => {
    await browser(SAFARI, 'zh-TW');
    const { DevicesSection } = await import('../../src/web/features/account/DevicesSection');
    const html = renderToStaticMarkup(createElement(DevicesSection, { deviceOnly: false }));
    expect(html).toContain('role="status"');
    expect(textOf(html, 'role="status"')).toBe('');
  });

  it('a reset link on the owner page is no live region: its expiry line ticks every second', async () => {
    await browser(SAFARI, 'zh-TW');
    const { ResetLinkResult } = await import('../../src/web/features/account/admin/ResetLink');
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const html = renderToStaticMarkup(
      createElement(ResetLinkResult, { link: { email: 'abbie@example.com', url: ORIGIN + '/#/reset/tok', expiresAt, deadline: Date.parse(expiresAt) } }),
    );
    expect(html).toContain('abbie@example.com');
    expect(html).not.toContain('aria-live');
  });
});

describe('連結 on 登入方式', () => {
  it('each button is named with its provider, the visible word first', async () => {
    for (const [locale, apple, google] of [['zh-TW', '連結 Apple', '連結 Google'], ['en', 'Link Apple', 'Link Google']] as const) {
      // This site's own API (cookie sessions), and both providers offered.
      await browser(SAFARI, locale, { 'evenly.api': 'same-origin', 'evenly.providers': JSON.stringify({ google: true, apple: true }) });
      const { SignInSection } = await import('../../src/web/features/account/CredentialsForm');
      const html = renderToStaticMarkup(createElement(SignInSection, { user: userOf() }));
      expect(html).toContain('data-testid="account-link-apple"');
      expect(html).toContain(`aria-label="${apple}"`);
      expect(html).toContain(`aria-label="${google}"`);
    }
  });
});

describe('the in-app browser hint', () => {
  it('spaces Safari, a Latin word, and not 瀏覽器 (DESIGN.md 13.2)', async () => {
    const cases = [
      [LINE_ANDROID, 'zh-TW', '用瀏覽器打開，登入才會留著', '用瀏覽器開啟'],
      [LINE_IOS, 'zh-TW', '用 Safari 打開，登入才會留著', '用 Safari 開啟'],
      [LINE_ANDROID, 'en', 'Open this in your browser to stay signed in', 'Open in browser'],
      [LINE_IOS, 'en', 'Open this in Safari to stay signed in', 'Open in Safari'],
      [FACEBOOK_ANDROID, 'zh-TW', '用瀏覽器打開，登入才會留著', '複製連結'],
    ] as const;
    for (const [ua, locale, title, button] of cases) {
      await browser(ua, locale);
      const { InAppHint } = await import('../../src/web/features/auth/InAppHint');
      const html = renderToStaticMarkup(createElement(InAppHint));
      expect(html, `${locale} ${ua}`).toContain(title);
      expect(html, `${locale} ${ua}`).toContain(button);
      expect(html).not.toMatch(/ 瀏覽器|瀏覽器 /);
    }
  });

  it('the word itself, for the sentences the toasts and 我的\'s card build with it', async () => {
    await browser(LINE_ANDROID, 'zh-TW');
    let session = await import('../../src/web/features/auth/session');
    expect([session.browserWord(true), session.browserWord(true, true), session.browserWord(false), session.browserWord(false, true)]).toEqual([
      '瀏覽器', '瀏覽器', 'your browser', 'browser',
    ]);
    await browser(LINE_IOS, 'zh-TW');
    session = await import('../../src/web/features/auth/session');
    expect([session.browserWord(true), session.browserWord(true, true), session.browserWord(false), session.browserWord(false, true)]).toEqual([
      ' Safari ', ' Safari ', 'Safari', 'Safari',
    ]);
    const i18n = await import('../../src/web/lib/i18n');
    // As 我的's card in LINE puts it.
    expect(i18n.t('先用{b}打開', 'Open this in {b} first', { b: session.browserWord(true) })).toBe('先用 Safari 打開');
  });

  it('none in Safari itself', async () => {
    await browser(SAFARI, 'zh-TW');
    const { InAppHint } = await import('../../src/web/features/auth/InAppHint');
    expect(renderToStaticMarkup(createElement(InAppHint))).toBe('');
  });
});

describe('the owner page and Apple or Google', () => {
  const row = (over: Record<string, unknown>) => ({ email: null as string | null, emailVerified: false, hasPassword: false, ...over });

  it('an account with Apple or Google linked signs in anywhere, with or without an email', async () => {
    await browser(SAFARI, 'zh-TW');
    const a = await import('../../src/web/features/account/admin/adminText');
    expect(a.signsInAnywhere(row({}))).toBe(false);
    // A Worker from before the fields: not linked.
    expect(a.signsInAnywhere(row({ appleLinked: undefined, googleLinked: undefined }))).toBe(false);
    expect(a.signsInAnywhere(row({ appleLinked: true }))).toBe(true);
    expect(a.signsInAnywhere(row({ googleLinked: true }))).toBe(true);
    expect(a.signsInAnywhere(row({ email: 'abbie@example.com' }))).toBe(true);
    expect(a.linkedWays(row({}))).toBeNull();
    expect(a.linkedWays(row({ appleLinked: true, googleLinked: true }))).toBe('Apple 或 Google');
  });

  it('says how it signs in, Apple and Google included, in both languages', async () => {
    await browser(SAFARI, 'zh-TW');
    const a = await import('../../src/web/features/account/admin/adminText');
    const i18n = await import('../../src/web/lib/i18n');
    i18n.setLocale('zh-TW');
    expect(a.noEmailText(row({}))).toBe('沒有 Email（只在這台裝置）');
    expect(a.noEmailText(row({ appleLinked: true }))).toBe('沒有 Email（用 Apple 登入）');
    expect(a.noEmailText(row({ appleLinked: true, googleLinked: true }))).toBe('沒有 Email（用 Apple 或 Google 登入）');
    expect(a.signInText(row({}))).toBe('只在裝置上（沒有 Email）');
    expect(a.signInText(row({ appleLinked: true }))).toBe('Apple（沒有 Email）');
    expect(a.signInText(row({ email: 'a@example.com', hasPassword: true }))).toBe('Email 和密碼（Email 還沒確認）');
    expect(a.signInText(row({ email: 'a@example.com', hasPassword: true, googleLinked: true }))).toBe('Email 和密碼或 Google（Email 還沒確認）');
    expect(a.signInText(row({ email: 'a@example.com', emailVerified: true }))).toBe('Email 驗證碼');
    expect(a.signInText(row({ email: 'a@example.com', emailVerified: true, hasPassword: true }))).toBe('Email 驗證碼或密碼');
    expect(a.signInText(row({ email: 'a@example.com', emailVerified: true, hasPassword: true, appleLinked: true, googleLinked: true }))).toBe('Email 驗證碼、Apple、Google 或密碼');
    i18n.setLocale('en');
    expect(a.noEmailText(row({}))).toBe('No email (on their device only)');
    expect(a.noEmailText(row({ googleLinked: true }))).toBe('No email (signs in with Google)');
    expect(a.signInText(row({ appleLinked: true, googleLinked: true }))).toBe('Apple or Google (no email)');
    expect(a.signInText(row({ email: 'a@example.com' }))).toBe('Email code (email not confirmed)');
    expect(a.signInText(row({ email: 'a@example.com', emailVerified: true, hasPassword: true }))).toBe('Email code or password');
    expect(a.signInText(row({ email: 'a@example.com', emailVerified: true, appleLinked: true }))).toBe('Email code or Apple');
  });
});
