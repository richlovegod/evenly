// The top of a group (DESIGN.md 8.1, 8.4; design/PICTUREBOOK.md): the top bar (back, name, add),
// the cover band with the group's drawn scenery and its meta line (currency, members, people and
// dates), and the status card it holds: where I stand, who I settle with (each line is one tap to
// 結清), who is settled with me, and ※ notes about unsynced entries and about how current the
// numbers are (this group's own last sync, changes not downloaded yet, a refresh that keeps
// failing). Scrolled past the card, a compact bar and a one-line strip stay at the top
// (reference/group-scrolled.png); when the top bar already sticks, only the strip is added.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Transfer } from '../../../shared/settle';
import type { GroupSummary } from '../../../shared/summary';
import type { GroupSnapshotDTO } from '../../../shared/types';
import { Avatar, AvatarStack } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { Money, MoneyStatus } from '../../components/Money';
import { PageHeader } from '../../components/PageHeader';
import { orderedMembers, zhJoin } from '../../lib/describe';
import { useT } from '../../lib/i18n';
import { back, navigate } from '../../lib/router';
import { actions } from '../../lib/store';
import { CoverScene } from '../home/art';
import { useGroupFreshness } from '../home/freshness';
import { RetryButton, staleTime, useStaleWords } from '../home/StaleNote';
import { cx } from './cx';
import { groupPath, linkTo, settlePath } from './links';
import { Dash, Foot, Lead, Leader, Signed, Slip, Stamp, usePrintFeed } from './Slip';
import { count } from './plural';
import { syncText } from './sync';
import s from './GroupHeader.module.css';

const MAX_LINES = 3;
/** Compact bar (58) plus the strip hanging from it (30 below its rule) plus a little: where
 *  sticky month headers stop. */
export const COMPACT_TOP = 96;
/** How far the strip reaches below a top bar that sticks (its 38 px less the 8 it overlaps, plus a gap). */
const STRIP_BELOW = 38;

const LATIN_START = /^[A-Za-z0-9(]/;
const LATIN_END = /[A-Za-z0-9)]$/;
/** Survives at the start or end of a flex item, where a plain space would collapse. */
const NO_BREAK = String.fromCharCode(160);

/**
 * The page's top bar, when it sticks to the top on its own (a picture-book top bar may): its
 * height, else 0. Then the compact view adds only the strip under it.
 */
function useStickyBand(gid: string): number {
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-group-band="' + CSS.escape(gid) + '"]');
    if (!el) return;
    const measure = () => {
      const pos = getComputedStyle(el).position;
      const next = pos === 'sticky' || pos === 'fixed' ? Math.round(el.getBoundingClientRect().height) : 0;
      setH(prev => (prev === next ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [gid]);
  return h;
}

export function GroupHeader({
  gid,
  snap,
  summary,
  plan,
  pendingCount,
  pendingPayments,
  online,
  onCompact,
  onBandStick,
}: {
  gid: string;
  snap: GroupSnapshotDTO;
  summary: GroupSummary;
  plan: readonly Transfer[];
  /** Unsynced changes that affect balances (they are counted in the numbers). */
  pendingCount: number;
  /** How many of those are payments (for 「含 1 筆等待同步的付款」). */
  pendingPayments: number;
  online: boolean;
  /** Told when the status card scrolls out (true) and back (false). */
  onCompact?: (compact: boolean) => void;
  /** Told the top bar's height when it sticks on its own (0 when it scrolls away). */
  onBandStick?: (px: number) => void;
}) {
  const { t, zh, date } = useT();
  const fresh = useGroupFreshness(gid);
  const staleWords = useStaleWords();
  const g = snap.group;
  const meId = snap.me.memberId;
  const cur = g.currency;
  const byId = new Map(snap.members.map(m => [m.id, m]));
  const active = orderedMembers(snap.members, meId);
  const net = summary.net[meId] ?? 0;
  const backTo = g.type === 'pair' ? '/friends' : '/groups';

  // Dates the entries span, for trips: 「12/16～12/20」 / "Dec 16 to 20".
  const live = snap.expenses.filter(e => !e.deletedAt);
  let range = '';
  if (live.length && g.type === 'trip') {
    let lo = live[0].date;
    let hi = live[0].date;
    for (const e of live) {
      if (e.date < lo) lo = e.date;
      if (e.date > hi) hi = e.date;
    }
    const a = date(lo, 'md');
    const b = date(hi, 'md');
    const sameMonth = lo.slice(0, 7) === hi.slice(0, 7);
    range = lo === hi ? a : t(a + '～' + b, a + ' to ' + (sameMonth ? String(Number(hi.slice(8, 10))) : b));
  }
  const people = t('{n} 人', count(active.length, 'person', 'people'), { n: active.length });
  const meta = range ? t(people + '，' + range, people + ', ' + range) : people;

  // Who I settle with under the plan, largest first.
  const mine = plan.filter(tr => tr.from === meId || tr.to === meId).sort((a, b) => b.amount - a.amount);
  const withMe = new Set(mine.map(tr => (tr.from === meId ? tr.to : tr.from)));
  const settledWithMe = active.filter(m => m.id !== meId && !withMe.has(m.id));
  const nameOf = (id: string) => byId.get(id)?.name ?? t('（已移除）', '(removed)');
  const settledNames = (() => {
    const names = settledWithMe.map(m => m.name);
    if (names.length <= 3) return names.join(t('、', ', '));
    // 「佳穎、志明等 4 人」, 「Abbie、Kevin 等 4 人」: a space only after a Latin name (DESIGN.md 13.2).
    return t(zhJoin(names.slice(0, 2).join('、'), '等 {n} 人'), names[0] + ', ' + names[1] + ' and {k} more', { n: names.length, k: names.length - 2 });
  })();

  const printKey = net + '|' + mine.map(tr => tr.from + '>' + tr.to + ':' + tr.amount).join(',');
  const printing = usePrintFeed('g.' + gid, printKey);
  const addPath = '/g/' + encodeURIComponent(gid) + '/add';

  // ----- compact view: when the status card has scrolled under the top of the screen -----
  const stick = useStickyBand(gid);
  useEffect(() => {
    onBandStick?.(stick);
  }, [stick, onBandStick]);
  const threshold = stick ? stick + STRIP_BELOW : COMPACT_TOP;
  const sentinel = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => {
        const out = !entry.isIntersecting && entry.boundingClientRect.top < threshold;
        setCompact(out);
      },
      { rootMargin: `-${threshold}px 0px 0px 0px`, threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  useEffect(() => {
    onCompact?.(compact);
  }, [compact, onCompact]);

  /** The members as one 44 px link to 設定: four faces in the band, three in a top bar. */
  const stackLink = (max: number, size: number) => (
    <a
      className={s.stack}
      {...linkTo(groupPath(gid, 'settings'))}
      aria-label={t('成員 {n} 人：{names}', count(active.length, 'member', 'members') + ': {names}', {
        n: active.length,
        names: active.map(m => (m.id === meId ? t('你', 'you') : m.name)).join(t('、', ', ')),
      })}
    >
      <AvatarStack people={active.map(m => ({ name: m.name, color: m.color, ring: m.id === meId }))} max={max} size={size} aria-hidden="true" />
    </a>
  );
  const stack = stackLink(4, 28);
  const barStack = stackLink(3, 26);

  const many = (n: number, one: string, more: string) => n + ' ' + (n === 1 ? one : more);
  const pendingNote =
    pendingCount > 0
      ? pendingPayments === pendingCount
        ? t('※ 含 {n} 筆等待同步的付款', 'Note: includes ' + many(pendingCount, 'payment', 'payments') + ' waiting to sync.', { n: pendingCount })
        : pendingPayments === 0
          ? t('※ 含 {n} 筆等待同步的費用', 'Note: includes ' + many(pendingCount, 'expense', 'expenses') + ' waiting to sync.', { n: pendingCount })
          : t('※ 含 {n} 筆等待同步的變更', 'Note: includes ' + many(pendingCount, 'change', 'changes') + ' waiting to sync.', { n: pendingCount })
      : null;

  // How current the card is.
  // - behind: the dashboard knows newer changes than this snapshot, and they cannot be fetched now;
  // - stale: refreshing keeps failing although the device is online (server trouble);
  // - offline: the top bar says so; the card says its numbers are the last synced ones.
  // The time is this group's own (its last fetch, or a dashboard fetch that listed this same
  // version), not the newest fetch of anything, so an old snapshot never reads 剛剛同步 just
  // because 總覽 refreshed.
  const showBehind = fresh.behind && (!online || fresh.failed);
  const showStale = !showBehind && fresh.stale;
  const syncAt = (showStale ? staleTime(fresh.at) : syncText(fresh.at)) || undefined;
  let stateNote: ReactNode = null;
  if (showBehind) {
    // The dashboard's balance, when it says something the card does not (and no unsynced change
    // of mine makes it the older of the two).
    const newer = pendingCount === 0 && fresh.dashNet !== null && fresh.dashNet !== net ? fresh.dashNet : null;
    stateNote = (
      <>
        {t('※ 這個群組有新的變更還沒下載', 'Note: this group has changes that have not downloaded yet.')}
        {newer !== null ? (
          <>
            {t('，較新的結餘：', ' Newer balance: ')}
            <MoneyStatus amount={newer} currency={cur} kind="groupMine" size="sm" className={s.footStatus} data-testid="group-newer-balance" />
          </>
        ) : null}
      </>
    );
  } else if (showStale) {
    stateNote = (
      <>
        {staleWords} <RetryButton onClick={() => void actions.loadGroup(gid, { force: true })} />
      </>
    );
  } else if (!online && pendingCount === 0) {
    stateNote = t('※ 離線中，顯示的是上次同步的資料', 'Note: offline, showing the last synced data.');
  }

  // 你可以拿回 / 你欠: the same words as MoneyStatus 'groupMine'.
  const statusWords = net > 0 ? t('你可以拿回', 'You get back') : t('你欠', 'You owe');

  return (
    <>
      <PageHeader
        back={backTo}
        data-group-band={gid}
        title={
          <span className={s.title} data-testid="group-title">
            {g.name}
          </span>
        }
        actions={
          <span className={s.actions}>
            {/* scrolled past the card under a top bar that sticks: the members come up here */}
            {compact && stick > 0 ? barStack : null}
            <IconButton icon="plus" label={t('新增費用', 'Add expense')} onClick={() => navigate(addPath)} data-testid="group-add-expense" />
          </span>
        }
      />

      <div className={s.band}>
        <CoverScene type={g.type} emoji={g.emoji} />
        <div className={s.bandMeta}>
          <span className={s.code}>{cur}</span>
          {stack}
        </div>
        <p className={s.metaText}>{meta}</p>
      </div>

      <Slip printing={printing} testId="group-status" label={t('你在這個群組的結餘', 'Your balance in this group')} className={s.card}>
        {net !== 0 ? (
          <p className={s.status}>
            <span className={cx(s.statusK, net > 0 ? s.pos : s.neg)}>{statusWords}</span>
            <Signed amount={net} currency={cur} display className={s.statusAmt} />
          </p>
        ) : (
          <div className={s.settledStatus}>
            <span className={s.statusK}>{t('你在這個群組', 'You in this group')}</span>
            <Stamp label={t('已結清', 'Settled up')} land={printing} />
          </div>
        )}

        {active.length <= 1 ? (
          <>
            <Dash className={s.dash} />
            <p className={s.lone}>
              {t('群組裡只有你，', 'Only you so far. ')}
              <a className={s.inlineLink} {...linkTo(groupPath(gid, 'settings'))}>
                {t('邀請朋友加入', 'Invite people')}
              </a>
            </p>
          </>
        ) : mine.length || settledWithMe.length ? (
          <>
            <Dash className={s.dash} />
            <div className={s.lines}>
              {mine.slice(0, MAX_LINES).map(tr => {
                const otherId = tr.from === meId ? tr.to : tr.from;
                const other = byId.get(otherId);
                const owesMe = tr.to === meId;
                const who = nameOf(otherId);
                // The name and the words that carry the direction are separate: the name ellipsizes,
                // 「欠你」 / "owes you" / 「你欠」 / "You owe" never shrink (DESIGN.md 2.2, 8.4).
                const verb = owesMe
                  ? zh
                    ? (LATIN_END.test(who) ? NO_BREAK : '') + '欠你'
                    : NO_BREAK + 'owes you'
                  : zh
                    ? '你欠' + (LATIN_START.test(who) ? NO_BREAK : '')
                    : 'You owe' + NO_BREAK;
                const nameEl = <span className={s.lineNm}>{who}</span>;
                const verbEl = <span className={cx(s.lineVb, owesMe ? s.pos : s.neg)}>{verb}</span>;
                // 「[T] Tiffany 欠你 / ¥86,400 (結清 >)」: the words on top, the amount under them.
                return (
                  <a key={tr.from + '>' + tr.to} className={cx(s.settleLine, !zh && s.en)} {...linkTo(settlePath(gid, tr.from, tr.to, tr.amount))}>
                    <Avatar name={other?.name ?? '?'} color={other?.color ?? ''} size={30} className={s.lineAv} />
                    <span className={s.lineWho}>
                      {owesMe ? (
                        <>
                          {nameEl}
                          {verbEl}
                        </>
                      ) : (
                        <>
                          {verbEl}
                          {nameEl}
                        </>
                      )}
                    </span>
                    <Money amount={tr.amount} currency={cur} tone={owesMe ? 'positive' : 'negative'} sign="never" className={s.lineAmt} />
                    <span className={s.go}>
                      <span className={s.goText}>{t('結清', 'Settle')}</span>
                      <Icon name="chevronRight" size={16} strokeWidth={2.4} />
                    </span>
                  </a>
                );
              })}
              {mine.length > MAX_LINES ? (
                <a className={s.moreLine} {...linkTo(groupPath(gid, 'balances'))}>
                  {t('另外 {n} 人', count(mine.length - MAX_LINES, 'more person', 'more people'), { n: mine.length - MAX_LINES })}
                  <Icon name="chevronRight" size={16} />
                </a>
              ) : null}
              {settledWithMe.length ? (
                <Lead className={s.settledLead} label={settledNames} value={<span className={s.mute}>{t('跟你已結清', 'Settled up with you')}</span>} />
              ) : null}
            </div>
          </>
        ) : null}

        {stateNote ? (
          <Foot right={syncAt}>
            <span data-testid="group-sync-note">{stateNote}</span>
          </Foot>
        ) : null}
        {pendingNote ? <Foot right={stateNote ? undefined : syncAt}>{pendingNote}</Foot> : null}
      </Slip>
      <div ref={sentinel} className={s.sentinel} aria-hidden="true" />

      {compact ? (
        <div className={cx(s.compact, stick > 0 && s.underBand)} style={stick > 0 ? ({ '--band-top': stick + 'px' } as CSSProperties) : undefined}>
          {stick > 0 ? null : (
            <div className={s.compactBand}>
              <IconButton icon="back" label={t('返回', 'Back')} onClick={() => back(backTo)} className={s.compactBack} />
              <span className={s.compactTitle}>{g.name}</span>
              {barStack}
            </div>
          )}
          <a className={s.stripWrap} {...linkTo(groupPath(gid, 'balances'))}>
            <span className={cx(s.strip, net > 0 && s.stripPos, net < 0 && s.stripNeg)}>
              {net !== 0 ? (
                <>
                  <span className={cx(s.stripK, net > 0 ? s.pos : s.neg)}>{statusWords}</span>
                  <Leader />
                  <Signed amount={net} currency={cur} className={s.stripAmt} />
                </>
              ) : (
                <>
                  <span className={cx(s.stripK, s.mute)}>{t('已結清', 'Settled up')}</span>
                  <Leader />
                </>
              )}
              <Icon name="chevronRight" size={18} className={s.stripChev} />
            </span>
          </a>
        </div>
      ) : null}
    </>
  );
}

/** The top bar, the cover band and an empty card while the group loads. */
export function GroupHeaderSkeleton({ back: backTo }: { back: string }) {
  const { t } = useT();
  return (
    <>
      <PageHeader back={backTo} title={<span className={cx(s.title, s.ghost)}>{t('載入中', 'Loading')}</span>} />
      <div className={cx(s.band, s.bandGhost)} aria-hidden="true" />
      <Slip label={t('載入中', 'Loading')} className={s.card}>
        <div className={s.ghostStatus}>
          <span className={cx(s.ghostBar, s.ghostLabel)} />
          <span className={cx(s.ghostBar, s.ghostAmt)} />
        </div>
      </Slip>
    </>
  );
}
