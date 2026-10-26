// 總覽: the top bar with the wordmark and my account, then the hero (design/PICTUREBOOK.md): a sky
// card where the mascot sits on a balance beam hung from a cloud. 別人欠你 hangs on the left as a
// grass-tinted tag and 你欠別人 on the right as a coral-tinted one, one line per currency with who
// it comes from; the heavier side sits lower and the beam is level when everything is settled.
// Then 群組, then 朋友 (DESIGN.md 8.4, 8.6), the protect-your-account card for accounts without
// a confirmed email, the offer to turn on notifications while they are off on this device and, on iPhone
// Safari, Add to Home Screen. When refreshing keeps failing (server
// trouble while online), the card says the numbers are the last synced ones, with their time and
// 再試一次.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { convertMinor } from '../../../shared/balances';
import { getCurrency } from '../../../shared/currencies';
import { todayISO } from '../../../shared/dates';
import type { FxRes } from '../../../shared/types';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { Mascot } from '../../components/Mascot';
import { AccountButton, PageHeader, Wordmark } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { Skeleton } from '../../components/Spinner';
import { zhJoin } from '../../lib/describe';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions, useStore } from '../../lib/store';
import { InstallCard } from '../account/InstallCard';
import { FriendRow } from '../friends/FriendRow';
import { cx } from '../groups/cx';
import { homeGroups } from '../groups/groupLists';
import { GroupRow } from '../groups/GroupRow';
import { linkTo } from '../groups/links';
import { count } from '../groups/plural';
import { Foot, Signed, Stamp, usePrintFeed } from '../groups/Slip';
import { syncText } from '../groups/sync';
import { Cloud, Hill } from './art';
import { approximateTotal, dashboardView } from './dashboard';
import { useCatchUpGroups, useMeFreshness } from './freshness';
import { PushCard } from './PushCard';
import { StaleFoot, StaleLine } from './StaleNote';
import s from './HomePage.module.css';

const MAX_LINES = 3;
const MAX_GROUPS = 6;
const MAX_FRIENDS = 5;
/** The beam's tilt when one side holds everything (degrees). */
const MAX_TILT = 7;
const TILT_KEY = 'evenly.home.tilt';

type Fx = (FxRes & { stale?: boolean }) | null;

/** Today's rates into my home currency, only when there is something to compare. */
function useHomeFx(base: string | null): Fx {
  const [fx, setFx] = useState<Fx>(null);
  useEffect(() => {
    if (!base) return;
    let alive = true;
    actions
      .getFx(base, todayISO())
      .then(r => {
        if (alive) setFx(r);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [base]);
  return base && fx && fx.base === base ? fx : null;
}

/** "Abbie Lin" shows as "Abbie" on a tag; Chinese names stay whole. */
function shortName(name: string): string {
  const n = name.trim();
  return /^[A-Za-z][A-Za-z'.]*\s+[A-Za-z]/.test(n) ? n.split(/\s+/)[0] : n;
}

interface TallyLine {
  currency: string;
  amount: number;
  who: string;
}

/**
 * The beam's tilt: -7deg x (owed to you - you owe) / (owed to you + you owe), so 別人欠你 (left)
 * sits lower when it is heavier. Several currencies are compared in the home currency, for the
 * drawing only (no converted total is ever shown); without rates, the side with more lines.
 */
export function beamTilt(owed: readonly TallyLine[], owe: readonly TallyLine[], home: string, fx: Fx): number {
  if (!owed.length && !owe.length) return 0;
  const currencies = new Set([...owed, ...owe].map(l => l.currency));
  let p = 0;
  let n = 0;
  if (currencies.size === 1) {
    for (const l of owed) p += l.amount;
    for (const l of owe) n += l.amount;
  } else if (fx) {
    const value = (l: TallyLine) => {
      const rate = l.currency === home ? 1 : fx.rates[l.currency];
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return 0;
      try {
        return convertMinor(l.amount, l.currency, rate, home);
      } catch {
        return 0;
      }
    };
    for (const l of owed) p += value(l);
    for (const l of owe) n += value(l);
  }
  const ratio = p + n > 0 ? (p - n) / (p + n) : (owed.length - owe.length) / (owed.length + owe.length);
  return Math.round(-MAX_TILT * ratio * 10) / 10;
}

/**
 * The tilt to draw. Coming back after a save or a payment, the beam starts where it was when this
 * session last showed it and turns to the new tilt (the CSS transition); plain navigation, the
 * first view and reduced motion show it in place.
 */
function useBeam(tilt: number | null): number {
  const [shown, setShown] = useState<number | null>(() => {
    try {
      const v = sessionStorage.getItem(TILT_KEY);
      return v === null ? null : Number(v);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (tilt === null) return;
    try {
      sessionStorage.setItem(TILT_KEY, String(tilt));
    } catch {
      /* private mode: no swing next time */
    }
    if (shown === null || shown === tilt) {
      if (shown === null) setShown(tilt);
      return;
    }
    const timer = window.setTimeout(() => setShown(tilt), 40);
    return () => window.clearTimeout(timer);
  }, [tilt]);
  return shown === null || !Number.isFinite(shown) ? tilt ?? 0 : shown;
}

/** An amount's printed width in em at display size: sign, the 0.6 em prefix, digits and separators. */
function amountEm(currency: string, body: string): number {
  let em = 0.74 + 0.08 + [...getCurrency(currency).symbol.trim()].length * 0.42;
  for (const ch of body) em += ch === ',' || ch === '.' ? 0.36 : 0.65;
  return Math.round(em * 100) / 100;
}

/** The custom properties the beam and the tags read. */
function beamStyle(tilt: number): CSSProperties {
  return { '--tilt': tilt + 'deg', '--sin': String(Math.sin((tilt * Math.PI) / 180)) } as CSSProperties;
}

/** The cloud, the beam and the mascot (decorative; the tags under it carry the numbers). */
function Rig() {
  return (
    <div className={s.rig} aria-hidden="true">
      <Cloud size="small" drift className={s.cloudL} />
      <Cloud size="tiny" drift slow className={s.cloudR} />
      <Cloud size="big" className={s.anchor} />
      <span className={s.beam} />
      <Mascot size={46} className={s.mascot} />
    </div>
  );
}

export function HomePage() {
  const { t, money, date } = useT();
  const me = useStore(st => st.me);
  const meLoading = useStore(st => st.meLoading);
  const meError = useStore(st => st.meError);
  const outbox = useStore(st => st.outbox);
  const cache = useStore(st => st.groups);
  // The hero is the dashboard, so its sync time is the dashboard's own (me.serverTime).
  const fresh = useMeFreshness();
  const [open, setOpen] = useState<{ owed: boolean; owe: boolean }>({ owed: false, owe: false });

  useEffect(() => {
    void actions.loadMe();
  }, []);
  useCatchUpGroups();

  const dash = useMemo(() => (me ? dashboardView(me, outbox, cache) : null), [me, outbox, cache]);
  const home = me?.user.currency ?? '';
  const multi = !!dash && dash.totals.length >= 2;
  const fx = useHomeFx(multi && home ? home : null);
  const printKey = dash ? dash.totals.map(x => x.currency + ':' + x.owed + '/' + x.owe).join(',') : '';
  const printing = usePrintFeed('home', printKey);

  const whoFor = (currency: string, sign: 1 | -1): string => {
    if (!dash) return '';
    const names = dash.friends
      .filter(f => f.balances.some(b => b.currency === currency && (sign > 0 ? b.amount > 0 : b.amount < 0)))
      .map(f => shortName(f.name));
    if (names.length === 1) return names[0];
    if (names.length > 1) return t(zhJoin(names[0], '等 {n} 人'), names[0] + ' +{k}', { n: names.length, k: names.length - 1 });
    const gs = dash.groups.filter(g => g.currency === currency && (sign > 0 ? g.myNet > 0 : g.myNet < 0));
    if (gs.length === 1) return gs[0].type === 'pair' ? '' : gs[0].name;
    return gs.length ? t('{n} 個群組', '{n} groups', { n: gs.length }) : '';
  };

  const sideLines = (sign: 1 | -1): TallyLine[] => {
    if (!dash) return [];
    const list = dash.totals
      .filter(x => (sign > 0 ? x.owed : x.owe) > 0)
      .map(x => ({ currency: x.currency, amount: sign > 0 ? x.owed : x.owe, who: whoFor(x.currency, sign) }));
    if (fx) {
      // Biggest first by rough home-currency value: for ordering only, never shown.
      const value = (l: TallyLine) => {
        const rate = l.currency === home ? 1 : fx.rates[l.currency];
        try {
          return rate ? convertMinor(l.amount, l.currency, rate, home) : 0;
        } catch {
          return 0;
        }
      };
      list.sort((a, b) => value(b) - value(a));
    }
    return list;
  };

  const owed = sideLines(1);
  const owe = sideLines(-1);
  const tilt = useBeam(dash ? beamTilt(owed, owe, home, fx) : null);

  const header = (
    <PageHeader
      large
      title={<Wordmark />}
      actions={me ? <AccountButton name={me.user.name} color={me.user.color} userId={me.user.id} avatar={me.user.avatar} data-testid="home-account" /> : null}
    />
  );

  if (!me || !dash) {
    if (meError && !meLoading) {
      return (
        <div className={s.page}>
          {header}
          <div className={s.emptyWrap}>
            <EmptyState
              icon={meError.code === 'offline' ? 'offline' : 'warning'}
              title={t('現在無法載入', 'Cannot load right now')}
              body={errorMessage(meError)}
              action={
                <Button variant="secondary" icon="sync" onClick={() => void actions.loadMe()}>
                  {t('再試一次', 'Try again')}
                </Button>
              }
            />
          </div>
        </div>
      );
    }
    return (
      <div className={s.page} aria-busy="true">
        {header}
        <section className={s.hero} aria-label={t('載入中', 'Loading')}>
          <div className={s.sky}>
            <Hill className={s.hill} />
            <div className={s.scale} style={beamStyle(0)}>
              <Rig />
              <div className={s.tags}>
                {[0, 1].map(i => (
                  <div key={i} className={cx(s.tag, s.tagEmpty)}>
                    <div className={s.skel}>
                      <Skeleton height={16} width="60%" />
                      <Skeleton height={24} width="85%" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const groupsById = new Map(dash.groups.map(g => [g.id, g]));
  // Groups with something to settle first, then the most recently changed (the server's order).
  // Archived groups stay off this list; their money still counts in the hero and under 朋友.
  const archivedCount = dash.groups.filter(g => g.type !== 'pair' && g.archived).length;
  const groups = homeGroups(dash.groups);
  const hasAnything = dash.groups.length > 0 || dash.friends.length > 0;

  const allSettled = owed.length === 0 && owe.length === 0;
  const approx = multi ? approximateTotal(dash.totals, home, fx) : null;

  const side = (key: 'owed' | 'owe', title: string, lines: TallyLine[], empty: string) => {
    const shown = open[key] ? lines : lines.slice(0, MAX_LINES);
    const hidden = lines.length - shown.length;
    // The longest amount on the tag sets the type size for all of them (they never wrap or cut).
    const em = Math.max(5, ...shown.map(l => amountEm(l.currency, money(l.amount, l.currency, { bare: true }))));
    return (
      <div className={cx(s.tag, key === 'owed' ? s.tagIn : s.tagOut, lines.length === 0 && s.tagEmpty)} style={{ '--em': em } as CSSProperties}>
        <h3 className={s.tagK}>{title}</h3>
        {lines.length === 0 ? <p className={s.tagNone}>{empty}</p> : null}
        {shown.map(l => (
          <p className={s.tagLine} key={l.currency}>
            <Signed amount={key === 'owed' ? l.amount : -l.amount} currency={l.currency} display className={s.tagAmt} />
            {l.who ? <span className={s.who}>{l.who}</span> : null}
          </p>
        ))}
        {hidden > 0 ? (
          <button type="button" className={s.moreBtn} onClick={() => setOpen(o => ({ ...o, [key]: true }))}>
            {t('另外 {n} 種幣別', count(hidden, 'more currency', 'more currencies'), { n: hidden })}
            <Icon name="chevronDown" size={16} />
          </button>
        ) : null}
      </div>
    );
  };

  const approxText = (() => {
    if (!approx) return null;
    const parts: string[] = [];
    if (approx.owed) parts.push(t('別人欠你 ≈ {a}', "you're owed ≈ {a}", { a: money(approx.owed, approx.currency) }));
    if (approx.owe) parts.push(t('你欠別人 ≈ {a}', 'you owe ≈ {a}', { a: money(approx.owe, approx.currency) }));
    if (!parts.length) return null;
    const when = date(approx.date, 'md');
    const missing = approx.missing.length ? t('，不含 {c}', ', not counting {c}', { c: approx.missing.join(t('、', ', ')) }) : '';
    return t(
      '※ 約合：' + parts.join('，') + '（依 ' + when + ' 匯率' + (approx.stale ? '，離線' : '') + '，只供參考' + missing + '）',
      'Note: roughly ' + parts.join(', ') + ' (' + when + ' rates' + (approx.stale ? ', offline' : '') + ', for reference only' + missing + ')',
    );
  })();

  const items = (n: number) => (n === 1 ? '1 item' : n + ' items');
  const pendingNote =
    dash.pendingCounted > 0
      ? t('※ {n} 筆等待同步，已計入', 'Note: includes ' + items(dash.pendingCounted) + ' waiting to sync.', { n: dash.pendingCounted })
      : dash.pendingUncounted > 0
        ? t('※ {n} 筆等待同步，還沒算進來', 'Note: ' + items(dash.pendingUncounted) + ' waiting to sync, not counted yet.', { n: dash.pendingUncounted })
        : null;

  const notes: ReactNode[] = [];
  if (multi) notes.push(<Foot key="multi">{t('※ 各幣別分開計算，不會自動換匯', 'Note: each currency is totaled separately, never converted.')}</Foot>);
  if (approxText) notes.push(<Foot key="approx">{approxText}</Foot>);
  if (pendingNote) notes.push(<Foot key="pending" right={fresh.stale ? undefined : syncText(fresh.at) || undefined}>{pendingNote}</Foot>);
  if (fresh.stale) notes.push(<StaleFoot key="stale" at={fresh.at} onRetry={() => void actions.loadMe()} />);

  const friends = dash.friends.filter(f => f.balances.length > 0);

  return (
    <div className={s.page}>
      {header}

      {hasAnything ? (
        <section className={cx(s.hero, printing && s.hop)} data-testid="home-totals" aria-labelledby="home-tally-h" data-tilt={tilt}>
          <h2 id="home-tally-h" className="sr-only">
            {t('你的結餘，各幣別分開計算', 'Your balances, each currency on its own')}
          </h2>
          <div className={s.sky}>
            <Hill className={s.hill} />
            <div className={s.scale} style={beamStyle(allSettled ? 0 : tilt)}>
              <Rig />
              {allSettled ? (
                <div className={s.even}>
                  <Stamp label={t('已結清', 'Settled up')} land={printing} />
                  <p className={s.evenText}>{t('沒有人欠你，你也沒有欠別人', "Nobody owes you, and you don't owe anyone")}</p>
                </div>
              ) : (
                <div className={s.tags}>
                  {side('owed', t('別人欠你', "You're owed"), owed, t('沒有人欠你', 'Nobody owes you'))}
                  {side('owe', t('你欠別人', 'You owe'), owe, t('你沒有欠別人', "You don't owe anyone"))}
                </div>
              )}
            </div>
          </div>
          {notes.length ? <div className={s.notes}>{notes}</div> : null}
        </section>
      ) : (
        <div className={s.emptyWrap}>
          {fresh.stale ? <StaleLine at={fresh.at} onRetry={() => void actions.loadMe()} className={s.staleLine} /> : null}
          <EmptyState
            icon="groups"
            title={t('還沒有群組', 'No groups yet')}
            body={t('建立一個群組，邀朋友一起記帳。', 'Create a group and invite friends to track costs together.')}
            action={
              <div className={s.emptyActions}>
                <Button variant="primary" icon="plus" href="/new-group" data-testid="home-new-group">
                  {t('建立群組', 'Create a group')}
                </Button>
                <Button variant="secondary" icon="userPlus" href="/add-friend" data-testid="home-add-friend">
                  {t('新增朋友', 'Add a friend')}
                </Button>
              </div>
            }
          />
        </div>
      )}

      {hasAnything ? (
        <>
          <Section
            title={t('群組', 'Groups')}
            action={
              <a {...linkTo('/new-group')} data-testid="home-new-group">
                {t('建立群組', 'New group')}
              </a>
            }
          >
            {groups.length ? (
              <ul className={s.list}>
                {groups.slice(0, MAX_GROUPS).map(g => (
                  <li key={g.id}>
                    <GroupRow group={g} testId="home-group-row" />
                  </li>
                ))}
              </ul>
            ) : archivedCount ? (
              <p className={s.note}>
                {t('你的群組都封存了。', 'All your groups are archived. ')}
                <a {...linkTo('/groups')} className={s.inlineLink} data-testid="home-archived-link">
                  {t('到「群組」最下面的「已封存」找', 'Find them under Archived on Groups')}
                </a>
              </p>
            ) : (
              <p className={s.note}>{t('還沒有群組。出去玩或一起住，就建一個群組來記帳。', 'No groups yet. For a trip or a shared home, create a group.')}</p>
            )}
            {groups.length > MAX_GROUPS ? (
              <a {...linkTo('/groups')} className={s.allLink}>
                {t('全部群組（{n}）', 'All groups ({n})', { n: groups.length })}
                <Icon name="chevronRight" size={18} />
              </a>
            ) : null}
          </Section>

          <Section
            title={t('朋友', 'Friends')}
            action={<a {...linkTo('/friends')}>{t('全部朋友', 'All friends')}</a>}
          >
            {friends.length ? (
              <ul className={s.list}>
                {friends.slice(0, MAX_FRIENDS).map(f => (
                  <li key={f.key}>
                    <FriendRow friend={f} groups={groupsById} testId="home-friend-row" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className={s.note}>
                {dash.friends.length ? t('跟朋友都結清了', 'You are settled up with everyone') : t('還沒有朋友', 'No friends yet')}
              </p>
            )}
            <div className={s.addFriend}>
              <Button variant="ghost" icon="userPlus" href="/add-friend" data-testid="home-add-friend">
                {t('新增朋友', 'Add a friend')}
              </Button>
            </div>
          </Section>
        </>
      ) : null}

      {/* An older client's field may be missing: not confirmed, so the card shows. */}
      {me.user.emailVerified !== true ? <ProtectCard email={me.user.email} /> : null}
      <PushCard className={s.install} />
      <InstallCard compact className={s.install} />
    </div>
  );
}

/**
 * Accounts without a confirmed email: a nudge (not a wall) to add one, or to confirm the one typed
 * before codes. It opens 我的, whose card at the top takes the email and then the code; once the
 * email is confirmed, this card goes.
 */
function ProtectCard({ email }: { email: string | null }) {
  const { t } = useT();
  return (
    <section className={s.protect} aria-labelledby="home-protect-h" data-testid="home-protect">
      <span className={s.protectIcon} aria-hidden="true">
        <Icon name={email ? 'mail' : 'lock'} size={22} />
      </span>
      <div className={s.protectBody}>
        <h2 id="home-protect-h" className={s.protectTitle}>
          {email ? t('確認你的 Email', 'Confirm your email') : t('保護你的帳號', 'Protect your account')}
        </h2>
        <p className={s.protectText}>
          {email
            ? t('確認 {email} 是你的，換手機時就能用驗證碼登入。', 'Confirm that {email} is yours, so a code sent to it signs you in on a new phone.', { email })
            : t('加上 Email，換手機或清除瀏覽器資料後，用它收驗證碼就能登入。', 'Add your email: on a new phone or after clearing browser data, a code sent to it signs you in.')}
        </p>
        <Button variant="secondary" size="sm" icon="mail" href="/account" className={s.protectBtn} data-testid="home-add-email">
          {email ? t('確認 Email', 'Confirm email') : t('加上 Email', 'Add email')}
        </Button>
      </div>
    </section>
  );
}
