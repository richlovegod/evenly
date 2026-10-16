// 總覽: the printer band with the wordmark and my account, the slip with my totals per currency
// (別人欠你 / 你欠別人, a name on each line), then 群組, then 朋友 (DESIGN.md 8.4, 8.6), the
// protect-your-account card for device-only accounts and, on iPhone Safari, Add to Home Screen.

import { useEffect, useMemo, useState } from 'react';
import { convertMinor } from '../../../shared/balances';
import { todayISO } from '../../../shared/dates';
import type { FxRes } from '../../../shared/types';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { Money } from '../../components/Money';
import { AccountButton, PageHeader, Wordmark } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { Skeleton } from '../../components/Spinner';
import { zhJoin } from '../../lib/describe';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions, useStore } from '../../lib/store';
import { InstallCard } from '../account/InstallCard';
import { FriendRow } from '../friends/FriendRow';
import { GroupRow } from '../groups/GroupRow';
import { linkTo } from '../groups/links';
import { count } from '../groups/plural';
import { Dash, Foot, Leader, Slip, Stamp, usePrintFeed } from '../groups/Slip';
import { syncText, useLastSyncAt } from '../groups/sync';
import { approximateTotal, dashboardView } from './dashboard';
import s from './HomePage.module.css';

const MAX_LINES = 3;
const MAX_GROUPS = 6;
const MAX_FRIENDS = 5;

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

/** "Abbie Lin" prints as "Abbie" on the slip; Chinese names stay whole. */
function shortName(name: string): string {
  const n = name.trim();
  return /^[A-Za-z][A-Za-z'.]*\s+[A-Za-z]/.test(n) ? n.split(/\s+/)[0] : n;
}

interface TallyLine {
  currency: string;
  amount: number;
  who: string;
}

export function HomePage() {
  const { t, money, date } = useT();
  const me = useStore(st => st.me);
  const meLoading = useStore(st => st.meLoading);
  const meError = useStore(st => st.meError);
  const outbox = useStore(st => st.outbox);
  const cache = useStore(st => st.groups);
  const lastSync = useLastSyncAt();
  const [open, setOpen] = useState<{ owed: boolean; owe: boolean }>({ owed: false, owe: false });

  useEffect(() => {
    void actions.loadMe();
  }, []);

  const dash = useMemo(() => (me ? dashboardView(me, outbox, cache) : null), [me, outbox, cache]);
  const home = me?.user.currency ?? '';
  const multi = !!dash && dash.totals.length >= 2;
  const fx = useHomeFx(multi && home ? home : null);
  const printKey = dash ? dash.totals.map(x => x.currency + ':' + x.owed + '/' + x.owe).join(',') : '';
  const printing = usePrintFeed('home', printKey);

  const header = (
    <PageHeader
      large
      title={<Wordmark />}
      actions={me ? <AccountButton name={me.user.name} color={me.user.color} data-testid="home-account" /> : null}
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
        <Slip label={t('載入中', 'Loading')}>
          <div className={s.skel}>
            <Skeleton height={18} width="40%" />
            <Skeleton height={34} width="75%" />
            <Skeleton height={34} width="60%" />
          </div>
        </Slip>
      </div>
    );
  }

  const groupsById = new Map(dash.groups.map(g => [g.id, g]));
  // Groups with something to settle first, then the most recently changed (the server's order).
  const groups = dash.groups
    .filter(g => g.type !== 'pair')
    .map((g, i) => ({ g, i }))
    .sort((a, b) => (a.g.myNet !== 0 ? 0 : 1) - (b.g.myNet !== 0 ? 0 : 1) || a.i - b.i)
    .map(x => x.g);
  const hasAnything = dash.groups.length > 0 || dash.friends.length > 0;

  const whoFor = (currency: string, sign: 1 | -1): string => {
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
  const allSettled = owed.length === 0 && owe.length === 0;
  const approx = multi ? approximateTotal(dash.totals, home, fx) : null;

  const side = (key: 'owed' | 'owe', title: string, lines: TallyLine[], empty: string) => {
    const shown = open[key] ? lines : lines.slice(0, MAX_LINES);
    const hidden = lines.length - shown.length;
    return (
      <div className={s.tally}>
        <h3 className={s.tallyK}>{title}</h3>
        {lines.length === 0 ? <p className={s.tallyEmpty}>{empty}</p> : null}
        {shown.map(l => (
          <p className={s.tallyLine} key={l.currency}>
            <span className={s.who}>{l.who}</span>
            <Leader />
            <Money amount={l.amount} currency={l.currency} tone={key === 'owed' ? 'positive' : 'negative'} sign="never" display className={s.tallyAmt} />
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

  const friends = dash.friends.filter(f => f.balances.length > 0);

  return (
    <div className={s.page}>
      {header}

      {hasAnything ? (
        <Slip testId="home-totals" labelledBy="home-tally-h" printing={printing}>
          <h2 id="home-tally-h" className="sr-only">
            {t('你的結餘，各幣別分開計算', 'Your balances, each currency on its own')}
          </h2>
          {allSettled ? (
            <div className={s.allSettled}>
              <Stamp label={t('已結清', 'Settled up')} land={printing} />
              <p className={s.allSettledText}>{t('沒有人欠你，你也沒有欠別人', "Nobody owes you, and you don't owe anyone")}</p>
            </div>
          ) : (
            <>
              {side('owed', t('別人欠你', "You're owed"), owed, t('沒有人欠你', 'Nobody owes you'))}
              <Dash className={s.tallyDash} />
              {side('owe', t('你欠別人', 'You owe'), owe, t('你沒有欠別人', "You don't owe anyone"))}
            </>
          )}
          {multi ? <Foot>{t('※ 各幣別分開計算，不會自動換匯', 'Note: each currency is totaled separately, never converted.')}</Foot> : null}
          {approxText ? <Foot>{approxText}</Foot> : null}
          {pendingNote ? <Foot right={syncText(lastSync)}>{pendingNote}</Foot> : null}
        </Slip>
      ) : (
        <div className={s.emptyWrap}>
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

      {me.user.email === null ? <ProtectCard /> : null}
      <InstallCard compact className={s.install} />
    </div>
  );
}

/** Device-only accounts: a nudge (not a wall) to add an email and password. */
function ProtectCard() {
  const { t } = useT();
  return (
    <section className={s.protect} aria-labelledby="home-protect-h">
      <span className={s.protectIcon} aria-hidden="true">
        <Icon name="lock" size={22} />
      </span>
      <div className={s.protectBody}>
        <h2 id="home-protect-h" className={s.protectTitle}>
          {t('保護你的帳戶', 'Protect your account')}
        </h2>
        <p className={s.protectText}>
          {t('加上 Email 和密碼，換手機或清除瀏覽器資料後也能登入。', 'Add an email and password so you can sign in again on a new phone or after clearing browser data.')}
        </p>
        <Button variant="secondary" size="sm" href="/account" className={s.protectBtn}>
          {t('設定登入方式', 'Set up sign-in')}
        </Button>
      </div>
    </section>
  );
}
