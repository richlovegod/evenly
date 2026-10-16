// AppShell (DESIGN.md 7, restyled for design/PICTUREBOOK.md): the frame around every signed-in page.
// Phones (< 900 px): the page, then the award site's tab bar 總覽 / 群組 / [＋ 記一筆] / 朋友 / 動態
// (3 px ink top rule; the current tab's icon in a yolk pill; the yolk 記一筆 pill sits on the
// top rule) with the unread badge on 動態. The current tab follows the section: #/g/* is 群組,
// #/f/* is 朋友.
// Desktop (>= 900 px): a 248 px sidebar (the mascot and wordmark over it, one link back to 總覽
// that scrolls to the top when already there; ＋ 記一筆, the tabs, recent groups, 我的) and a
// content column up to 760 px with 32 px side padding; page bands run the column's full width.
// The add key: inside a group it opens that group's add sheet; elsewhere the last-used group's
// (the group of the last expense added on this device, saved by the editor); with no such
// group it opens AddExpenseChooser. Desktop shortcut: N.
// The offline / sync notes print inside the page's band (PageHeader); pages without one get
// the strip at the top here instead.
// Account (我的) opens from the avatar button in the Home band and from the sidebar.
// The wordmark prints once: on desktop it sits over the sidebar, so the 總覽 band in the
// column shows the title 總覽 (SidebarBrand in PageHeader.tsx).

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import type { MeDTO } from '../../shared/types';
import { useT } from '../lib/i18n';
import { href, navigate, type Route } from '../lib/router';
import { useStore } from '../lib/store';
import { AddExpenseChooser } from './AddExpenseChooser';
import { Button } from './Button';
import { GroupAvatar } from './GroupAvatar';
import { Icon, type IconName } from './Icon';
import { Mascot } from './Mascot';
import { MoneyStatus } from './Money';
import { OfflineBanner, useBannerHosted, useSyncNotice } from './OfflineBanner';
import { SidebarBrand, Wordmark } from './PageHeader';
import s from './AppShell.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

const DESKTOP = '(min-width: 900px)';
/** Written by the expense editor after a save (features/expenses/editorPrefs.ts). */
const LAST_GROUP_KEY = 'evenly.lastGroup';

function subscribeDesktop(fn: () => void): () => void {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener('change', fn);
  return () => mq.removeEventListener('change', fn);
}

function useDesktop(): boolean {
  return useSyncExternalStore(subscribeDesktop, () => window.matchMedia(DESKTOP).matches, () => false);
}

type TabKey = 'home' | 'groups' | 'friends' | 'activity' | 'account';

/** The section a route belongs to (DESIGN.md 7.1: #/g/* is 群組, #/f/* is 朋友). */
function tabFor(route: Route): TabKey | null {
  switch (route.name) {
    case 'home':
      return 'home';
    case 'friends':
    case 'friend':
    case 'addFriend':
      return 'friends';
    case 'activity':
      return 'activity';
    case 'account':
    case 'admin':
      return 'account';
    case 'groups':
    case 'newGroup':
      return 'groups';
    default:
      return route.params.gid ? 'groups' : null;
  }
}

/** The group of the last expense added on this device, if it is still one of mine. */
function lastGroup(me: MeDTO | null): string | null {
  let gid: string | null = null;
  try {
    gid = localStorage.getItem(LAST_GROUP_KEY);
  } catch {
    gid = null;
  }
  if (!gid || !me) return null;
  return me.groups.some(g => g.id === gid) ? gid : null;
}

/** Keep <meta name="theme-color"> on paper, so the status bar continues the top bar (light only,
 *  like the award site: one color, no scheme or theme to follow). */
function useThemeColor(): void {
  useEffect(() => {
    const color = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
    if (!color) return;
    let metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
    if (!metas.length) {
      const m = document.createElement('meta');
      m.name = 'theme-color';
      document.head.appendChild(m);
      metas = [m];
    }
    for (const m of metas) if (m.content !== color) m.content = color;
  }, []);
}

/** Flags on <html> other components lay out against (the Toaster sits above the bottom bar). */
function useShellFlags(tabbar: boolean): void {
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-shell', '');
    if (tabbar) root.setAttribute('data-tabbar', '');
    else root.removeAttribute('data-tabbar');
    return () => {
      root.removeAttribute('data-shell');
      root.removeAttribute('data-tabbar');
    };
  }, [tabbar]);
}

/** Desktop: the content column's side padding in px (32, or more to center 760 px of content). */
function usePagePad(desktop: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [pad, setPad] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!desktop || !el) {
      setPad(null);
      return;
    }
    const measure = () => {
      const w = el.clientWidth;
      setPad(Math.max(32, Math.floor((w - 760) / 2)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [desktop]);
  return { ref, pad };
}

/** True while focus is somewhere typing goes (shortcuts stay out of the way). */
function typing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

interface NavItem {
  key: TabKey;
  path: string;
  icon: IconName;
  label: string;
  badge?: number;
}

export interface AppShellProps {
  route: Route;
  children: ReactNode;
}

export function AppShell({ route, children }: AppShellProps) {
  const { t } = useT();
  const desktop = useDesktop();
  const me = useStore(st => st.me);
  const unread = useStore(st => st.me?.unread) ?? 0;
  const notice = useSyncNotice();
  const hosted = useBannerHosted();
  const [chooser, setChooser] = useState(false);
  const { ref: columnRef, pad } = usePagePad(desktop);
  useThemeColor();
  useShellFlags(!desktop);

  const active = tabFor(route);

  // Close the chooser whenever the page changes.
  useEffect(() => {
    setChooser(false);
  }, [route.path]);

  const addRef = useRef<() => void>(() => undefined);
  function add() {
    const gid = route.params.gid;
    if (gid) {
      navigate(`/g/${encodeURIComponent(gid)}/add`);
      return;
    }
    const last = lastGroup(me);
    if (last) {
      navigate(`/g/${encodeURIComponent(last)}/add`);
      return;
    }
    setChooser(true);
  }
  addRef.current = add;

  // The brand goes back to 總覽; on 總覽 itself it scrolls back to the top.
  function brandClick(e: MouseEvent<HTMLAnchorElement>) {
    if (route.name !== 'home' || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' });
  }

  // Desktop shortcut: N adds an expense.
  useEffect(() => {
    if (!desktop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || typing()) return;
      if (document.getElementById('root')?.inert) return;
      e.preventDefault();
      addRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [desktop]);

  const items: NavItem[] = [
    { key: 'home', path: '/', icon: 'home', label: t('總覽', 'Home') },
    { key: 'groups', path: '/groups', icon: 'groups', label: t('群組', 'Groups') },
    { key: 'friends', path: '/friends', icon: 'friends', label: t('朋友', 'Friends') },
    { key: 'activity', path: '/activity', icon: 'activity', label: t('動態', 'Activity'), badge: unread },
  ];
  const badgeText = (n?: number) => (n && n > 0 ? (n > 99 ? '99+' : String(n)) : null);
  const unreadText = (n: string) => t('{n} 則未讀', '{n} unread', { n });

  // The strip at the top covers the status bar, so a band under it skips its own safe-area padding.
  const showStrip = notice.visible && !hosted;
  const columnStyle = {
    ...(showStrip ? { '--band-safe-t': '0px' } : null),
    ...(desktop && pad !== null ? { '--page-pad': `${pad}px` } : null),
  } as CSSProperties;

  const recent = (me?.groups ?? [])
    .filter(g => g.type !== 'pair')
    .slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .slice(0, 6);

  return (
    <div className={cx(s.shell, desktop && s.desktop)}>
      <a
        className={s.skip}
        href="#main"
        onClick={e => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        {t('跳到主要內容', 'Skip to content')}
      </a>

      {desktop ? (
        <aside className={s.sidebar}>
          <div className={s.brand}>
            <a
              className={s.brandLink}
              href={href('/')}
              onClick={brandClick}
              aria-label={t('Evenly 分帳，回到總覽', 'Evenly, back to Home')}
              title={t('回到總覽', 'Back to Home')}
              data-testid="brand-home"
            >
              <Mascot size={34} float className={s.logo} />
              <Wordmark />
            </a>
          </div>
          <nav className={s.sideBody} aria-label={t('主選單', 'Main menu')}>
            <div className={s.sideAdd}>
              <Button variant="primary" size="lg" block icon="plus" data-testid="tab-add" aria-keyshortcuts="N" onClick={add}>
                {t('記一筆', 'Add')}
              </Button>
            </div>
            {items.map(it => {
              const b = badgeText(it.badge);
              return (
                <div key={it.key}>
                  <a className={s.navItem} href={href(it.path)} aria-current={active === it.key ? 'page' : undefined} data-testid={'tab-' + it.key}>
                    <Icon name={it.icon} />
                    <span className={s.navLabel}>{it.label}</span>
                    {b ? (
                      <>
                        <span className={s.navBadge} aria-hidden="true">{b}</span>
                        <span className="sr-only">{unreadText(b)}</span>
                      </>
                    ) : null}
                  </a>
                  {it.key === 'groups' && recent.length ? (
                    <div className={s.groups}>
                      {recent.map(g => (
                        <a
                          key={g.id}
                          className={s.groupItem}
                          href={href('/g/' + encodeURIComponent(g.id))}
                          aria-current={route.params.gid === g.id ? 'page' : undefined}
                        >
                          <GroupAvatar emoji={g.emoji} color={g.color} name={g.name} size={28} settled={g.myNet === 0} />
                          <span className={s.groupText}>
                            <span className={s.groupName}>{g.name}</span>
                            <MoneyStatus amount={g.myNet} currency={g.currency} kind="groupMine" size="sm" className={s.groupStatus} />
                          </span>
                        </a>
                      ))}
                      <a className={s.allGroups} href={href('/groups')}>{t('全部群組', 'All groups')}</a>
                    </div>
                  ) : null}
                </div>
              );
            })}
            <a className={s.navItem} href={href('/account')} aria-current={active === 'account' ? 'page' : undefined} data-testid="tab-account">
              <Icon name="user" />
              <span className={s.navLabel}>{t('我的', 'Account')}</span>
            </a>
          </nav>
        </aside>
      ) : null}

      <div ref={columnRef} className={s.column} style={columnStyle}>
        {/* Kept mounted (empty when hidden) so its first note is announced. */}
        <OfflineBanner variant="band" show={showStrip} />
        {/* On desktop the sidebar carries the wordmark, so the 總覽 band shows its page title. */}
        <SidebarBrand.Provider value={desktop}>
          <main id="main" className={s.main} tabIndex={-1}>
            {children}
          </main>
        </SidebarBrand.Provider>
      </div>

      {!desktop ? (
        <nav className={s.tabbar} aria-label={t('主選單', 'Main menu')}>
          {items.slice(0, 2).map(it => (
            <TabLink key={it.key} item={it} current={active === it.key} badge={badgeText(it.badge)} unreadText={unreadText} />
          ))}
          {/* The 記一筆 pill sits on the bar's top rule, like the award site's 搜尋 button on its card's edge. */}
          <button type="button" className={s.add} onClick={add} data-testid="tab-add" aria-label={t('記一筆', 'Add expense')}>
            <Icon name="plus" />
            <span aria-hidden="true">{t('記一筆', 'Add')}</span>
          </button>
          {items.slice(2).map(it => (
            <TabLink key={it.key} item={it} current={active === it.key} badge={badgeText(it.badge)} unreadText={unreadText} />
          ))}
        </nav>
      ) : null}

      <AddExpenseChooser open={chooser} onClose={() => setChooser(false)} />
    </div>
  );
}

function TabLink({ item, current, badge, unreadText }: { item: NavItem; current: boolean; badge: string | null; unreadText: (n: string) => string }) {
  return (
    <a className={s.tab} href={href(item.path)} aria-current={current ? 'page' : undefined} data-testid={'tab-' + item.key}>
      <span className={s.iconWrap}>
        <Icon name={item.icon} />
        {badge ? <span className={s.badge} aria-hidden="true">{badge}</span> : null}
      </span>
      <span className={s.tabLabel}>{item.label}</span>
      {badge ? <span className="sr-only">{unreadText(badge)}</span> : null}
    </a>
  );
}
