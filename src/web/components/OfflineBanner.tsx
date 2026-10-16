// OfflineBanner (DESIGN.md 8.18): 離線中 / 同步中（N 筆）/ N 筆同步失敗 from the store (online flag,
// outbox, in-flight sync), as outlined picture-book notes (sky tint; coral tint for failures).
// It lives inside the top bar: PageHeader renders it under its bar (variant "notes"). AppShell
// renders the standalone strip (variant "band") only on pages without a PageHeader, so it never
// shows twice. "Syncing" appears only after changes have waited 1.5 s, so an ordinary save does
// not flash it. data-testid="offline-banner".

import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type HTMLAttributes } from 'react';
import { useT } from '../lib/i18n';
import { href } from '../lib/router';
import { useStore } from '../lib/store';
import { Icon } from './Icon';
import s from './OfflineBanner.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------- which band shows the notes ----------

let hosts = 0;
const hostListeners = new Set<() => void>();

function subscribeHosts(fn: () => void): () => void {
  hostListeners.add(fn);
  return () => hostListeners.delete(fn);
}

/** Called by PageHeader: while mounted, the banner prints inside that band. */
export function useBannerHost(): void {
  useLayoutEffect(() => {
    hosts++;
    for (const l of hostListeners) l();
    return () => {
      hosts--;
      for (const l of hostListeners) l();
    };
  }, []);
}

/** True while some PageHeader on screen carries the banner (AppShell then leaves it out). */
export function useBannerHosted(): boolean {
  return useSyncExternalStore(subscribeHosts, () => hosts > 0, () => false);
}

// ---------- what to say ----------

export interface SyncNotice {
  offline: boolean;
  /** Queued changes not yet sent (not failed). */
  pending: number;
  /** Changes the server rejected for good (同步失敗). */
  failed: number;
  /** The group of the first failed change, for the 查看 link. */
  failedGroupId: string | null;
  /** Pending changes have waited long enough to mention. */
  showPending: boolean;
  /** A request is in flight right now (the sync icon turns). */
  busy: boolean;
  /** Anything to show. */
  visible: boolean;
}

export function useSyncNotice(): SyncNotice {
  const online = useStore(st => st.online);
  const outbox = useStore(st => st.outbox);
  const syncing = useStore(st => st.syncing);
  const signedIn = useStore(st => !!st.token);
  let pending = 0;
  let failed = 0;
  let failedGroupId: string | null = null;
  for (const item of outbox) {
    if (item.error) {
      failed++;
      if (!failedGroupId) failedGroupId = item.groupId;
    } else {
      pending++;
    }
  }
  const waiting = pending > 0;
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setLate(false);
      return;
    }
    const timer = setTimeout(() => setLate(true), 1500);
    return () => clearTimeout(timer);
  }, [waiting]);
  const offline = !online;
  const showPending = online && waiting && late;
  return {
    offline,
    pending,
    failed,
    failedGroupId,
    showPending,
    busy: syncing && online,
    visible: offline || (signedIn && (showPending || failed > 0)),
  };
}

// ---------- the banner ----------

export interface OfflineBannerProps extends HTMLAttributes<HTMLDivElement> {
  /** notes: inside a top bar (PageHeader); band: a strip of its own at the top (default); inline: a note on the page. */
  variant?: 'notes' | 'band' | 'inline';
  /** false: print nothing here (another band carries the notes), but keep the live region. */
  show?: boolean;
  className?: string;
}

export function OfflineBanner({ variant = 'band', show = true, className, ...rest }: OfflineBannerProps) {
  const { t } = useT();
  const n = useSyncNotice();
  // With nothing to say the role="status" box stays in the page, empty and without a box of its
  // own: a live region that appears together with its text is often not read out (VoiceOver), one
  // whose text changes is.
  if (!n.visible || !show) return <div {...rest} className={className} role="status" />;
  return (
    <div {...rest} className={cx(variant === 'notes' ? s.notes : variant === 'band' ? s.band : s.inline, className)} role="status" data-testid="offline-banner">
      {n.offline ? (
        <p className={s.note}>
          <Icon name="offline" />
          <span className={s.text}>{t('離線中，新增的費用會在連線後自動同步', "You're offline. New expenses sync when you reconnect.")}</span>
          {n.pending > 0 ? <span className={s.count}>{t('{n} 筆等待同步', '{n} waiting', { n: n.pending })}</span> : null}
        </p>
      ) : n.showPending ? (
        <p className={s.note}>
          <Icon name="sync" className={n.busy ? s.spin : undefined} />
          <span className={s.text}>{t('同步中（{n} 筆）', 'Syncing ({n})', { n: n.pending })}</span>
        </p>
      ) : null}
      {n.failed > 0 ? (
        <p className={cx(s.note, s.failed)}>
          <Icon name="warning" />
          <span className={s.text}>{t('{n} 筆同步失敗', '{n} failed to sync', { n: n.failed })}</span>
          {n.failedGroupId ? (
            <a className={s.go} href={href('/g/' + encodeURIComponent(n.failedGroupId))}>{t('查看', 'Review')}</a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
