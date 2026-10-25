// Route table and sign-in gate. Each page is its own module under features/.
// On every page change the document is titled after the page (「Niseko 滑雪 2026，吉諾分帳所」),
// and when focus left with the old page, it moves to the new page's heading (or, coming back, to
// the link that left it), so screen readers say where they are.

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { AppShell } from './components/AppShell';
import { Toaster } from './components/Toaster';
import { confirmDialog, DialogHost } from './components/Dialog';
import { ViewportDebug } from './components/ViewportDebug';
import { APP_NAME_EN, APP_NAME_ZH, appName } from './lib/brand';
import { useT, type I18n } from './lib/i18n';
import { getRoute, navigate, useRoute, type Route } from './lib/router';
import { actions, getState, useStore, type ChangeSummary, type SignedOutNotice } from './lib/store';
import { WelcomePage } from './features/auth/WelcomePage';
import { LoginPage } from './features/auth/LoginPage';
import { LinkPage } from './features/auth/LinkPage';
import { ResetPage } from './features/auth/ResetPage';
import { HomePage } from './features/home/HomePage';
import { GroupsPage } from './features/groups/GroupsPage';
import { NewGroupPage } from './features/groups/NewGroupPage';
import { GroupPage } from './features/groups/GroupPage';
import { ExpenseEditorPage } from './features/expenses/ExpenseEditorPage';
import { ExpenseDetailPage } from './features/expenses/ExpenseDetailPage';
import { SettleUpPage } from './features/settle/SettleUpPage';
import { FriendsPage } from './features/friends/FriendsPage';
import { FriendPage } from './features/friends/FriendPage';
import { AddFriendPage } from './features/friends/AddFriendPage';
import { ActivityPage } from './features/activity/ActivityPage';
import { AccountPage } from './features/account/AccountPage';
import { AdminPage } from './features/account/AdminPage';
import { JoinPage } from './features/join/JoinPage';
import { ClaimPage } from './features/join/ClaimPage';

/** Routes that work without signing in. */
const PUBLIC = new Set(['welcome', 'login', 'link', 'reset', 'join', 'claim']);
/** Routes that make no sense once signed in. */
const GUEST_ONLY = new Set(['welcome', 'login']);
/** Full-screen routes without the tab bar or sidebar. */
const BARE = new Set(['welcome', 'login', 'link', 'reset', 'join', 'claim', 'addExpense', 'editExpense', 'settle', 'newGroup', 'addFriend']);
/** BARE pages without a <main> of their own (MainLandmark gives them one). */
const NEEDS_MAIN = new Set(['newGroup', 'addFriend']);
/** One group page whose tabs switch in place (focus stays on the tab). */
const GROUP_TABS = new Set(['group', 'groupBalances', 'groupStats', 'groupSettings']);

const RETURN_KEY = 'evenly.returnTo';

/** Remember where to go after signing in (e.g. a join link opened while signed out). */
export function rememberReturn(path: string): void {
  try {
    sessionStorage.setItem(RETURN_KEY, path);
  } catch {
    /* ignore */
  }
}

/** Where to go after signing in: the remembered path or home. */
export function takeReturn(): string {
  try {
    const p = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    if (p && p.startsWith('/')) return p;
  } catch {
    /* ignore */
  }
  return '/';
}

function Page({ route }: { route: Route }) {
  const { t } = useT();
  const p = route.params;
  switch (route.name) {
    case 'welcome': return <WelcomePage />;
    case 'login': return <LoginPage />;
    case 'link': return <LinkPage code={p.code} />;
    case 'reset': return <ResetPage token={p.token} />;
    case 'home': return <HomePage />;
    case 'groups': return <GroupsPage />;
    case 'newGroup': return <NewGroupPage />;
    case 'group': return <GroupPage gid={p.gid} tab="expenses" />;
    case 'groupBalances': return <GroupPage gid={p.gid} tab="balances" />;
    case 'groupStats': return <GroupPage gid={p.gid} tab="stats" />;
    case 'groupSettings': return <GroupPage gid={p.gid} tab="settings" />;
    case 'addExpense': return <ExpenseEditorPage gid={p.gid} />;
    case 'editExpense': return <ExpenseEditorPage gid={p.gid} eid={p.eid} />;
    case 'expense': return <ExpenseDetailPage gid={p.gid} eid={p.eid} />;
    case 'settle': return <SettleUpPage gid={p.gid} />;
    case 'friends': return <FriendsPage />;
    case 'friend': return <FriendPage friendKey={p.key} />;
    case 'addFriend': return <AddFriendPage />;
    case 'activity': return <ActivityPage />;
    case 'account': return <AccountPage />;
    case 'admin': return <AdminPage />;
    case 'join': return <JoinPage code={p.code} />;
    case 'claim': return <ClaimPage token={p.token} />;
    default:
      return (
        <div style={{ padding: 24 }}>
          <h1 style={{ marginBottom: 8 }}>{t('找不到這個頁面', 'This page does not exist')}</h1>
          <p><a href="#/">{t('回到總覽', 'Back to Home')}</a></p>
        </div>
      );
  }
}

/** The main landmark for a BARE page that has none (left out if the page gains its own). */
function MainLandmark({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.querySelector('main, [role="main"]')) el.removeAttribute('role');
    else el.setAttribute('role', 'main');
  });
  return <div ref={ref}>{children}</div>;
}

// ---------- document title ----------

/** The page's own heading: the first h1 in the app (sheets and dialogs render outside #root). */
function pageHeading(): HTMLElement | null {
  return document.querySelector<HTMLElement>('#root h1');
}

function plain(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** 「燒肉晚餐，Niseko 滑雪 2026，吉諾分帳所」: the page, where it is, then the app (DESIGN.md 13.2 punctuation). */
export function documentTitle(route: Route, zh: boolean): string {
  const app = appName(zh);
  const heading = plain(pageHeading()?.textContent);
  const gid = route.params.gid;
  const group = (gid ? plain(getState().groups[gid]?.snap?.group.name) : '') || heading;
  const w = (z: string, e: string) => (zh ? z : e);
  let parts: string[];
  switch (route.name) {
    case 'home': parts = [w('總覽', 'Home')]; break;
    case 'group': parts = [group]; break;
    case 'groupBalances': parts = [w('結算', 'Balances'), group]; break;
    case 'groupStats': parts = [w('統計', 'Stats'), group]; break;
    case 'groupSettings': parts = [w('設定', 'Settings'), group]; break;
    case 'expense': parts = [heading, gid ? plain(getState().groups[gid]?.snap?.group.name) : '']; break;
    default: parts = [heading];
  }
  const shown = parts.filter((p, i) => p && p !== APP_NAME_ZH && p !== APP_NAME_EN && parts.indexOf(p) === i);
  return [...shown, app].join(zh ? '，' : ', ');
}

/** Keep document.title on the page shown, also when its heading arrives after a fetch. */
function useDocumentTitle(route: Route, zh: boolean): void {
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = documentTitle(route, zh);
      if (document.title !== next) document.title = next;
    };
    update();
    const root = document.getElementById('root');
    if (!root || typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(update);
    });
    mo.observe(root, { subtree: true, childList: true, characterData: true });
    return () => {
      mo.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [route, zh]);
}

// ---------- focus on page changes ----------

/** Focus went away with the old page (its link unmounted, or a tap parked it on the shell's main). */
function focusLost(): boolean {
  const a = document.activeElement as HTMLElement | null;
  return !a || a === document.body || a === document.documentElement || a.id === 'main' || !a.isConnected;
}

function linkTo(hrefValue: string): HTMLElement | null {
  try {
    return document.querySelector<HTMLElement>('#root a[href="' + CSS.escape(hrefValue) + '"]');
  } catch {
    return null;
  }
}

/**
 * Focus without leaving a ring where nobody asked for one: a heading is not a control, and after
 * a tap or click a moved focus should not draw a ring either (keyboard users keep theirs on links).
 */
function moveFocus(el: HTMLElement, scroll: boolean, byPointer: boolean): void {
  if (el.tagName === 'H1' && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: !scroll });
  if (el.tagName !== 'H1' && !byPointer) return;
  const before = el.style.outline;
  el.style.outline = 'none';
  el.addEventListener('blur', () => {
    el.style.outline = before;
  }, { once: true });
}

/**
 * After a page change, put focus on the new page's heading, or, coming back to a page, on the
 * link that left it. Only when focus was lost: a field a page focused on purpose, a tab that
 * stays (group tabs, the tab bar, the sidebar) and the first page of a visit keep theirs.
 */
function useRouteFocus(route: Route, ready: boolean): void {
  const prev = useRef<Route | null>(null);
  /** The route now (a change of the query alone must not cancel a pending focus move). */
  const current = useRef(route);
  current.current = route;
  /** The in-app link activated last, and the page it was on. */
  const lastLink = useRef<{ path: string; href: string } | null>(null);
  /** Per page: the link that last left it. */
  const openers = useRef(new Map<string, string>());
  const interactedAt = useRef(0);
  /** The last interaction was a tap or click (not a key). */
  const byPointer = useRef(false);

  useEffect(() => {
    const onKey = () => {
      interactedAt.current = Date.now();
      byPointer.current = false;
    };
    const onPointer = () => {
      interactedAt.current = Date.now();
      byPointer.current = true;
    };
    const onClick = (e: MouseEvent) => {
      interactedAt.current = Date.now();
      // A click from Enter on a link has no pointer behind it (detail 0).
      if (e.detail > 0) byPointer.current = true;
      const a = e.target instanceof Element ? e.target.closest('a[href^="#/"]') : null;
      lastLink.current = a ? { path: getRoute().path, href: a.getAttribute('href') ?? '' } : null;
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const route = current.current;
    const from = prev.current;
    prev.current = route;
    if (!from || from.path === route.path) return;
    const link = lastLink.current;
    lastLink.current = null;
    if (link && link.path === from.path) openers.current.set(from.path, link.href);
    if (!interactedAt.current) return;
    if (GROUP_TABS.has(from.name) && GROUP_TABS.has(route.name) && from.params.gid === route.params.gid) return;
    const changedAt = Date.now();
    const opener = openers.current.get(route.path);
    const returning = !!opener && opener.split('?')[0] === '#' + from.path;
    const attempt = (last: boolean) => {
      // Someone is already using the new page: leave focus to them.
      if (!focusLost() || interactedAt.current > changedAt) return;
      let el = returning && opener ? linkTo(opener) : null;
      const scroll = !!el;
      if (!el && (!returning || last)) el = pageHeading();
      if (el) moveFocus(el, scroll, byPointer.current);
    };
    const frame = requestAnimationFrame(() => attempt(false));
    // A page that swaps a loading skeleton for its real header replaces the heading: follow it.
    const soon = window.setTimeout(() => attempt(false), 400);
    const late = window.setTimeout(() => attempt(true), 1200);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(soon);
      window.clearTimeout(late);
    };
  }, [ready, route.path]);
}

// ---------- signed out with changes kept ----------

function changeText(c: ChangeSummary, i18n: I18n): string {
  const { t, money } = i18n;
  const amount = c.amount !== null && c.currency ? money(c.amount, c.currency) : '';
  const what = c.description.trim();
  switch (c.op) {
    case 'upsert':
      if (c.kind === 'payment') return t('付款 {a}', 'a payment of {a}', { a: amount }).trim();
      return [what || t('（沒有說明）', '(no description)'), amount].filter(Boolean).join(' ');
    case 'delete':
      return what ? t('刪除「{d}」', 'deleting "{d}"', { d: what }) : t('刪除一筆費用', 'deleting an entry');
    case 'restore':
      return what ? t('復原「{d}」', 'restoring "{d}"', { d: what }) : t('復原一筆費用', 'restoring an entry');
    case 'comment': {
      const body = plain(c.comment);
      const short = [...body].length > 20 ? [...body].slice(0, 20).join('') + '…' : body;
      return short ? t('留言「{c}」', 'the comment "{c}"', { c: short }) : t('一則留言', 'a comment');
    }
  }
}

/** The session ended on its own with unsynced changes kept on this device: say so once, and what. */
function useSignedOutNotice(): void {
  const notice = useStore(s => s.signedOut);
  const i18n = useT();
  const shown = useRef<SignedOutNotice | null>(null);
  useEffect(() => {
    if (!notice || shown.current === notice) return;
    shown.current = notice;
    const { t, zh } = i18n;
    const n = notice.changes.length;
    const MAX = 5;
    const list = notice.changes.slice(0, MAX).map(c => changeText(c, i18n));
    if (n > MAX) list.push(t('還有 {n} 筆', 'and {n} more', { n: n - MAX }));
    const parts = [
      t('這台裝置已經登出了，可能是在別的裝置讓它登出，或密碼重設過。', 'This device was signed out, maybe from another device or after a password reset.'),
      n === 1
        ? t('有 1 筆變更還沒同步，先留在這台裝置上：{list}。', '1 change had not synced yet and is kept on this device: {list}.', { list: list.join(zh ? '、' : '; ') })
        : t('有 {n} 筆變更還沒同步，先留在這台裝置上：{list}。', '{n} changes had not synced yet and are kept on this device: {list}.', { n, list: list.join(zh ? '、' : '; ') }),
      t('用同一個帳號重新登入後，就會自動送出。', 'Sign in again with the same account and they go out automatically.'),
    ];
    if (!notice.hasEmail) {
      parts.push(t('這個帳號沒有 Email，要在另一台已登入的裝置上產生登入碼，才能登回來。', 'This account has no email: make a sign-in code on another signed-in device to get back in.'));
    }
    void confirmDialog({
      title: t('登入已失效', 'You were signed out'),
      message: parts.join(zh ? '' : ' '),
      confirmLabel: t('重新登入', 'Sign in again'),
      cancelLabel: t('稍後', 'Later'),
    }).then(ok => {
      actions.dismissSignedOutNotice();
      // With an email, 登入 sends a code to it; without one, only a code from another device works.
      if (ok) navigate(notice.hasEmail ? '/login' : '/link');
    });
  }, [notice, i18n]);
}

export function App() {
  const route = useRoute();
  const token = useStore(s => s.token);
  const booted = useStore(s => s.booted);
  const { zh } = useT();

  const blocked = !token && !PUBLIC.has(route.name);
  const bounce = !!token && GUEST_ONLY.has(route.name);
  const ready = booted && !blocked && !bounce;

  useEffect(() => {
    if (!booted) return;
    if (blocked) {
      // After an explicit sign-out there is nothing to come back to.
      let signedOut = false;
      try {
        signedOut = sessionStorage.getItem('evenly.signedOut') === '1';
        sessionStorage.removeItem('evenly.signedOut');
      } catch {
        /* ignore */
      }
      if (route.name !== 'home' && !signedOut) rememberReturn(route.path + (route.query.toString() ? '?' + route.query.toString() : ''));
      navigate('/welcome', { replace: true });
    } else if (bounce) {
      navigate('/', { replace: true });
    }
  }, [booted, blocked, bounce, route]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.path]);

  useDocumentTitle(route, zh);
  useRouteFocus(route, ready);
  useSignedOutNotice();

  // ViewportDebug (the ?debug=vv overlay) sits beside the Toaster and DialogHost in both returns, so
  // it stays mounted across page changes; its log (sessionStorage) covers the whole visit.
  if (!ready) return <><Toaster /><DialogHost /><ViewportDebug /></>;
  return (
    <>
      {BARE.has(route.name) ? (
        NEEDS_MAIN.has(route.name) ? (
          <MainLandmark>
            <Page route={route} />
          </MainLandmark>
        ) : (
          <Page route={route} />
        )
      ) : (
        <AppShell route={route}>
          <Page route={route} />
        </AppShell>
      )}
      <Toaster />
      <DialogHost />
      <ViewportDebug />
    </>
  );
}
