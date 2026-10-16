// 記錄還款 (settle up): a full-height page sheet (DESIGN.md 8.15). Who paid whom (prefilled from
// the link or the plan), how much (the plan amount by default, printed with separators), in
// which currency (the group's, or another with an exchange-rate row read like the editor's, and a
// second look when a typed rate is far from the market one), when, a note, and the receiver's
// payment details with Venmo and PayPal.me buttons. Saving records a payment (works offline) and
// goes back. When the group's numbers may be out of date, the suggestion says so.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { convertMinor } from '../../../shared/balances';
import { todayISO } from '../../../shared/dates';
import { minorToInput, parseAmount } from '../../../shared/money';
import type { MemberDTO } from '../../../shared/types';
import { AmountInput } from '../../components/AmountInput';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { CurrencyPicker } from '../../components/CurrencyPicker';
import { DateField } from '../../components/DateField';
import { confirmDialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { GroupAvatar } from '../../components/GroupAvatar';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { MemberPicker } from '../../components/MemberPicker';
import { Money } from '../../components/Money';
import { Spinner } from '../../components/Spinner';
import { TextField } from '../../components/TextField';
import { orderedMembers, zhJoin } from '../../lib/describe';
import { errorMessage } from '../../lib/errors';
import { money as moneyText, useT } from '../../lib/i18n';
import { back, useRoute } from '../../lib/router';
import { copyText } from '../../lib/share';
import { actions, useGroupView, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { currentPlan, payLines, summarize } from '../groups/groupMath';
import { groupPath } from '../groups/links';
import { useGroupSync } from '../groups/useGroupSync';
import { useGroupFreshness } from '../home/freshness';
import { RetryButton, staleTime } from '../home/StaleNote';
import { rateLooksOff, settleRate } from './settleRate';
import s from './SettleUpPage.module.css';

const LATIN_START = /^[A-Za-z0-9(]/;

/**
 * An amount for the amount box, with separators (「35,248」, 「1,234.50」), so the number the
 * page fills in reads like every other amount. parseAmount reads it back; formatting on blur
 * then has nothing to change, so tapping the box and leaving it does not unhook it from the plan.
 */
function amountText(minor: number, currency: string): string {
  return moneyText(minor, currency, { bare: true });
}

/** A rate for display: up to 6 significant digits, no trailing zeros. */
function rateText(rate: number): string {
  return String(Number(rate.toPrecision(6)));
}

interface FxState {
  loading: boolean;
  rate: number | null;
  date: string | null;
  stale: boolean;
}

/** Value of 1 `currency` in the group currency on `date` (cached rates when offline). */
function useRate(groupCurrency: string, currency: string, date: string): FxState {
  const needed = !!groupCurrency && !!currency && currency !== groupCurrency;
  const key = groupCurrency + ':' + currency + ':' + date;
  const [res, setRes] = useState<{ key: string; fx: FxState } | null>(null);
  useEffect(() => {
    if (!needed) return;
    let alive = true;
    actions
      .getFx(groupCurrency, date)
      .then(r => {
        if (!alive) return;
        const rate = r?.rates?.[currency];
        setRes({ key, fx: { loading: false, rate: typeof rate === 'number' && rate > 0 ? rate : null, date: r?.date ?? null, stale: !!r?.stale } });
      })
      .catch(() => {
        if (alive) setRes({ key, fx: { loading: false, rate: null, date: null, stale: false } });
      });
    return () => {
      alive = false;
    };
  }, [needed, key, groupCurrency, currency, date]);
  if (!needed) return { loading: false, rate: 1, date: null, stale: false };
  return res && res.key === key ? res.fx : { loading: true, rate: null, date: null, stale: false };
}

type Picking = 'from' | 'to' | 'currency' | null;

export function SettleUpPage({ gid }: { gid: string }) {
  const { t, zh, money, date: fmtDate } = useT();
  const route = useRoute();
  const view = useGroupView(gid);
  useGroupSync(gid);
  const online = useStore(st => st.online);
  const fresh = useGroupFreshness(gid);
  const snap = view.snap;
  const meId = snap?.me.memberId ?? '';
  const base = snap?.group.currency ?? '';
  const backTo = groupPath(gid, 'balances');

  const summary = useMemo(() => (snap ? summarize(snap) : null), [snap]);
  const plan = useMemo(() => (snap && summary ? currentPlan(snap, summary) : []), [snap, summary]);

  // ----- form state -----
  const [ready, setReady] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [raw, setRaw] = useState('');
  const [touched, setTouched] = useState(false);
  const [currency, setCurrency] = useState('');
  const [date, setDate] = useState(() => todayISO());
  const [notes, setNotes] = useState('');
  const [rateInput, setRateInput] = useState('');
  const [editRate, setEditRate] = useState(false);
  const [picking, setPicking] = useState<Picking>(null);
  const [tried, setTried] = useState(false);
  /** A save is under way (asking about the rate, or done): a second tap must not record it twice. */
  const saving = useRef(false);

  const planAmount = (a: string, b: string) => plan.find(tr => tr.from === a && tr.to === b)?.amount ?? 0;

  // Prefill once the group is here: from / to / amount from the link, else from the plan.
  useEffect(() => {
    if (ready || !snap) return;
    const ids = new Set(snap.members.map(m => m.id));
    const q = route.query;
    let f = q.get('from') ?? '';
    let tt = q.get('to') ?? '';
    if (!ids.has(f)) f = '';
    if (!ids.has(tt)) tt = '';
    if (!f || !tt || f === tt) {
      const mine = plan.filter(tr => tr.from === meId || tr.to === meId).sort((a, b) => b.amount - a.amount);
      const owe = mine.find(tr => tr.from === meId);
      const pick = owe ?? mine[0];
      if (pick && !f && !tt) {
        f = pick.from;
        tt = pick.to;
      } else {
        if (!f) f = tt === meId ? orderedMembers(snap.members, meId).find(m => m.id !== meId)?.id ?? '' : meId;
        if (!tt || tt === f) tt = orderedMembers(snap.members, meId).find(m => m.id !== f)?.id ?? '';
      }
    }
    const qa = Number(q.get('amount'));
    const amount = Number.isSafeInteger(qa) && qa > 0 ? qa : planAmount(f, tt);
    setFrom(f);
    setTo(tt);
    setCurrency(snap.group.currency);
    setRaw(amount > 0 ? amountText(amount, snap.group.currency) : '');
    // A link with an amount that differs from the plan counts as typed, so it is kept.
    setTouched(Number.isSafeInteger(qa) && qa > 0 && qa !== planAmount(f, tt));
    setReady(true);
  }, [snap, ready]);

  const fx = useRate(base, currency || base, date);
  const foreign = !!currency && currency !== base;
  // Typed text wins; text that cannot be read gives no rate at all (saving stays blocked), never
  // a silent fallback to the fetched rate.
  const rated = settleRate(foreign, rateInput, fx.rate);
  const rate = rated.rate;
  const typedRate = rated.source === 'typed' ? rated.rate : null;
  const rateOff = rateLooksOff(typedRate, fx.rate);

  // An untouched amount follows the plan: switching people or currency re-suggests it.
  const suggested = from && to ? planAmount(from, to) : 0;
  useEffect(() => {
    if (!ready || touched) return;
    if (!suggested) {
      setRaw('');
      return;
    }
    if (!foreign) setRaw(amountText(suggested, base));
    else if (rate) {
      try {
        // The amount in this currency whose value in the group currency comes closest to the plan.
        const guess = convertMinor(suggested, base, 1 / rate, currency);
        let best = guess;
        let gap = Infinity;
        for (const c of [guess - 1, guess, guess + 1]) {
          if (c <= 0) continue;
          const d = Math.abs(convertMinor(c, currency, rate, base) - suggested);
          if (d < gap) {
            best = c;
            gap = d;
          }
        }
        setRaw(amountText(best, currency));
      } catch {
        /* keep what is there */
      }
    }
  }, [ready, touched, suggested, foreign, rate, currency, base]);

  if (!snap) {
    return (
      <div className={s.behind}>
        <div className={s.sheet}>
          <Header title={t('記錄還款', 'Record a payment')} onCancel={() => back(backTo)} />
          <div className={s.center}>
            {view.error && !view.loading ? (
              <EmptyState
                icon={view.error.code === 'not_found' ? 'groups' : 'warning'}
                title={view.error.code === 'not_found' ? t('找不到這個群組', 'We cannot find this group') : t('現在無法載入這個群組', 'This group cannot load right now')}
                body={errorMessage(view.error)}
              />
            ) : (
              <Spinner size={28} />
            )}
          </div>
        </div>
      </div>
    );
  }

  const byId = new Map(snap.members.map(m => [m.id, m]));
  const active = orderedMembers(snap.members, meId);
  // Pickers list active members, plus anyone the link named who has since left.
  const pickable = (selected: string): MemberDTO[] => {
    const list = [...active];
    const extra = byId.get(selected);
    if (extra && !extra.active) list.push(extra);
    return list;
  };
  const nameOf = (id: string, lower = false) => (id === meId ? (lower ? t('你', 'you') : t('你', 'You')) : byId.get(id)?.name ?? '?');

  const minor = parseAmount(raw, currency || base);
  const converted = foreign && minor && rate ? safeConvert(minor, currency, rate, base) : null;

  const rateUnreadable = rated.source === 'invalid';
  const errors = {
    people: !from || !to ? t('選擇誰付給誰', 'Choose who paid whom') : from === to ? t('付款人和收款人要是不同的人', 'The payer and the receiver must be different people') : '',
    amount: !minor || minor <= 0 ? t('金額要大於 0', 'The amount must be more than 0') : '',
    rate: !foreign ? '' : rateUnreadable ? t('匯率要是大於 0 的數字', 'The rate must be a number above 0') : !rate ? t('請輸入匯率', 'Enter the exchange rate') : '',
  };
  const valid = !errors.people && !errors.amount && !errors.rate;
  /** The fetched rate for display: 「10/16 的匯率 1 USD = 1342.55 KRW」. */
  const marketLine = fx.rate ? '1 ' + currency + ' = ' + rateText(fx.rate) + ' ' + base : '';
  const marketDay = fx.date ? fmtDate(fx.date, 'md') : '';

  // The group's numbers may be out of date: changes the dashboard knows about are not here yet
  // (and cannot be fetched now), or refreshing keeps failing. The suggestion says so.
  const behind = fresh.behind && (!online || fresh.failed);

  const receiver = byId.get(to);
  const lines = receiver ? payLines(receiver) : [];
  const major = minor && minor > 0 ? minorToInput(minor, currency) : '';
  const iPay = from === meId;
  const venmoUrl = receiver?.venmo
    ? 'https://venmo.com/' + encodeURIComponent(receiver.venmo) + '?txn=pay' + (major && currency === 'USD' ? '&amount=' + major : '')
    : null;
  const paypalUrl = receiver?.paypal ? 'https://paypal.me/' + encodeURIComponent(receiver.paypal) + (major ? '/' + major + currency : '') : null;

  const reverse = from && to ? planAmount(to, from) : 0;
  /** A name inside Chinese text: spaces around a Latin name only. */
  const zhSpace = (n: string): string => (zh && LATIN_START.test(n) ? ' ' + n + ' ' : n);

  const swap = () => {
    setFrom(to);
    setTo(from);
  };

  const save = async () => {
    setTried(true);
    if (!valid || !minor || saving.current) return;
    saving.current = true;
    if (foreign && rateOff && typedRate !== null) {
      // A typed rate 5 times or more off the market rate is usually a slip (a comma read the
      // other way, the rate upside down): ask once before booking it.
      const ok = await confirmDialog({
        title: t('匯率跟市場匯率差很多', 'This rate is far from the market rate'),
        message: t(
          '你輸入的是 1 {c} = {r} {b}，{d}匯率是 {m}。還是要用你輸入的匯率嗎？',
          'You typed 1 {c} = {r} {b}; the {d} rate is {m}. Use your rate anyway?',
          { c: currency, r: rateText(typedRate), b: base, d: marketDay ? t(marketDay + ' 的', marketDay) : t('市場', 'market'), m: marketLine },
        ).replace(/\s+/g, ' '),
        confirmLabel: t('用我輸入的匯率', 'Use my rate'),
        cancelLabel: t('再檢查', 'Check again'),
      });
      if (!ok) {
        saving.current = false;
        return;
      }
    }
    const eid = crypto.randomUUID();
    actions.saveExpense(gid, eid, {
      kind: 'payment',
      description: '',
      category: 'payment',
      amount: minor,
      currency,
      fxRate: foreign ? (rate as number) : 1,
      date,
      notes: notes.trim(),
      payers: [{ memberId: from, amount: minor }],
      split: { method: 'exact', entries: [{ memberId: to, value: minor }] },
    });
    const a = nameOf(from);
    const b = nameOf(to, true);
    const line = t(zhJoin(a, '付給') + (LATIN_START.test(b) ? ' ' : '') + b + ' ' + money(minor, currency), a + ' paid ' + b + ' ' + money(minor, currency));
    showToast({
      message: t('已記錄還款：{l}', 'Payment recorded: {l}', { l: line }),
      kind: 'success',
      action: { label: t('復原', 'Undo'), run: () => actions.deleteExpense(gid, eid) },
    });
    back(backTo);
  };

  const copy = async (text: string) => {
    const ok = await copyText(text);
    showToast({ message: ok ? t('已複製', 'Copied') : t('無法複製', 'Could not copy'), kind: ok ? 'success' : 'error' });
  };

  const person = (id: string, which: 'from' | 'to') => {
    const m = byId.get(id);
    return (
      <Chip
        label={id ? nameOf(id) : t('選擇', 'Choose')}
        leading={m ? <Avatar name={m.name} color={m.color} size={24} ring={id === meId} /> : undefined}
        trailingIcon="chevronDown"
        onClick={() => setPicking(which)}
        aria-label={
          which === 'from'
            ? t('付款人：{n}，點一下更換', 'Paid by: {n}, tap to change', { n: id ? nameOf(id) : t('未選擇', 'none') })
            : t('收款人：{n}，點一下更換', 'Paid to: {n}, tap to change', { n: id ? nameOf(id) : t('未選擇', 'none') })
        }
        data-testid={which === 'from' ? 'settle-from' : 'settle-to'}
        className={s.personChip}
      />
    );
  };

  return (
    <div className={s.behind}>
      <main className={s.sheet} aria-labelledby="settle-title">
        <Header
          title={t('記錄還款', 'Record a payment')}
          sub={
            <>
              <GroupAvatar emoji={snap.group.emoji} color={snap.group.color} name={snap.group.name} size={16} />
              <span className={s.subName}>{snap.group.name}</span>
            </>
          }
          onCancel={() => back(backTo)}
        />

        <div className={s.body}>
          <div className={s.whoRow}>
            {person(from, 'from')}
            <span className={s.whoVerb}>{t('付給', 'paid')}</span>
            {person(to, 'to')}
            <IconButton icon="swap" label={t('對調付款人和收款人', 'Swap payer and receiver')} onClick={swap} className={s.swap} />
          </div>
          {tried && errors.people ? <p className={s.err}>{errors.people}</p> : null}
          {from && to && from !== to ? (
            suggested > 0 ? (
              <p className={s.hint}>
                {t('結算建議：{a}', 'Suggested: {a}', { a: money(suggested, base) })}
                {touched && minor !== suggested && !foreign ? (
                  <button
                    type="button"
                    className={s.hintBtn}
                    onClick={() => {
                      setTouched(false);
                      setRaw(amountText(suggested, base));
                    }}
                  >
                    {t('用這個金額', 'Use it')}
                  </button>
                ) : null}
              </p>
            ) : reverse > 0 ? (
              <p className={s.hint}>
                {t('照結算建議，應該是{b}付給{a}', 'The plan has {b} paying {a}', {
                  a: zhSpace(nameOf(from, true)),
                  b: zhSpace(nameOf(to)),
                }).replace(/\s+/g, ' ')}
                <button type="button" className={s.hintBtn} onClick={swap}>
                  {t('對調', 'Swap')}
                </button>
              </p>
            ) : (
              <p className={s.hint}>{t('依結算建議，這兩人之間不用轉帳', 'The plan has no transfer between these two')}</p>
            )
          ) : null}
          {behind ? (
            <p className={s.hint} data-testid="settle-stale">
              {t('※ 這個群組有新的變更還沒下載，結算建議可能不是最新的', 'Note: this group has changes that have not downloaded yet, so the suggestion may be out of date.')}
            </p>
          ) : fresh.stale ? (
            <p className={s.hint} data-testid="settle-stale">
              <span>
                {t('※ 無法更新，結算建議用的是上次同步的資料', 'Note: could not refresh, the suggestion uses the last synced data.')}{' '}
                <RetryButton onClick={() => void actions.loadGroup(gid, { force: true })} />
              </span>
              {fresh.at ? <span className={s.hintWhen}>{staleTime(fresh.at)}</span> : null}
            </p>
          ) : null}

          <div className={s.panel}>
            <AmountInput
              value={raw}
              onChange={v => {
                setRaw(v);
                setTouched(true);
              }}
              currency={currency || base}
              onCurrencyClick={() => setPicking('currency')}
              currencyForeign={foreign}
              size="lg"
              label={t('金額', 'Amount')}
              error={tried && errors.amount ? errors.amount : undefined}
              data-testid="settle-amount"
              onEnter={save}
              bare
            />
            {foreign ? (
              <div className={s.fx} data-testid="settle-fx">
                <div className={s.fxLeft}>
                  <span>{t('以 {c} 記入群組', 'Booked in {c}', { c: base })}</span>
                  {editRate || (!fx.loading && !fx.rate) ? (
                    <label className={s.rateEdit}>
                      <span className={s.rateOne}>1 {currency} =</span>
                      <input
                        className={s.rateInput}
                        value={rateInput}
                        onChange={e => setRateInput(e.target.value)}
                        inputMode="decimal"
                        enterKeyHint="done"
                        autoComplete="off"
                        placeholder={fx.rate ? rateText(fx.rate) : ''}
                        aria-label={t('匯率：1 {c} 等於多少 {b}', 'Rate: how many {b} is 1 {c}', { c: currency, b: base })}
                        data-testid="settle-fx-rate"
                      />
                      <span className={s.rateOne}>{base}</span>
                    </label>
                  ) : fx.loading ? (
                    <span>{t('正在取得匯率…', 'Getting the rate…')}</span>
                  ) : rate ? (
                    <span>
                      {'1 ' + currency + ' = ' + rateText(rate) + ' ' + base}
                      {typedRate
                        ? t('，你輸入的匯率', ', your rate')
                        : fx.date
                          ? fx.stale
                            ? t('，{d} 匯率（離線）', ' at the {d} rate (offline)', { d: fmtDate(fx.date, 'md') })
                            : t('，{d} 匯率', ' at the {d} rate', { d: fmtDate(fx.date, 'md') })
                          : ''}
                    </span>
                  ) : null}
                  {(tried || rateUnreadable) && errors.rate ? (
                    <span className={s.errInline} data-testid="settle-rate-error">
                      {errors.rate}
                    </span>
                  ) : null}
                  {rateOff && marketLine ? (
                    <span className={s.rateWarn} data-testid="settle-rate-warning">
                      {t('跟{d}匯率', 'Far from the {d} rate,', { d: marketDay ? t(' ' + marketDay + ' 的', marketDay) : t('市場', 'market') })}{' '}
                      <span className={s.nowrap}>{marketLine}</span>
                      {t(' 差很多，請再確認', '. Check it')}{' '}
                      <button type="button" className={s.useMarket} onClick={() => fx.rate && setRateInput(rateText(fx.rate))} data-testid="settle-rate-use-market">
                        {t('改用這個匯率', 'Use that rate')}
                      </button>
                    </span>
                  ) : null}
                </div>
                <div className={s.fxRight}>
                  {converted !== null ? (
                    <span className={s.fxAmt}>
                      {'≈ '}
                      <Money amount={converted} currency={base} tone="neutral" sign="never" />
                    </span>
                  ) : null}
                  {!editRate && fx.rate ? (
                    <button
                      type="button"
                      className={s.editRate}
                      onClick={() => {
                        setEditRate(true);
                        if (!rateInput && fx.rate) setRateInput(rateText(fx.rate));
                      }}
                    >
                      {t('改匯率', 'Edit rate')}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <DateField value={date} onChange={setDate} label={t('日期', 'Date')} data-testid="settle-date" />
            <TextField
              label={t('備註', 'Note')}
              value={notes}
              onChange={setNotes}
              placeholder={t('例如：現金、LINE Pay、轉帳', 'For example: cash, Venmo, bank transfer')}
              maxLength={2000}
              autoComplete="off"
              enterKeyHint="done"
              bare
              data-testid="settle-note"
            />
          </div>

          {receiver ? (
            <section className={s.payinfo} aria-labelledby="settle-payinfo-h">
              <h2 id="settle-payinfo-h" className={s.pk}>
                {to === meId ? t('你的收款方式', 'How to pay you') : t('{n} 的收款方式', 'How to pay {n}', { n: receiver.name })}
              </h2>
              {lines.length ? (
                lines.map(l => (
                  <p className={s.payLine} key={l.label}>
                    <b className={s.payK}>{l.label}</b>
                    <span className={l.mono ? s.payVMono : s.payV}>{l.value}</span>
                    <Button variant="secondary" size="sm" icon="copy" onClick={() => void copy(l.copy)} aria-label={t('複製{k}', 'Copy {k}', { k: l.label })}>
                      {t('複製', 'Copy')}
                    </Button>
                  </p>
                ))
              ) : (
                <p className={s.noInfo}>
                  {to === meId
                    ? t('你還沒有設定收款方式，可以到「我的」加上。', 'You have not added payment details yet. Add them on Account.')
                    : t('{n} 還沒有設定收款方式。', '{n} has not added payment details yet.', { n: receiver.name })}
                </p>
              )}
              {iPay && (venmoUrl || paypalUrl) ? (
                <div className={s.payBtns}>
                  {venmoUrl ? (
                    <Button variant="secondary" href={venmoUrl} target="_blank" iconEnd="external" data-testid="settle-venmo">
                      {currency === 'USD' && major ? t('用 Venmo 付 {a}', 'Pay {a} with Venmo', { a: money(minor ?? 0, currency) }) : t('用 Venmo 付款', 'Pay with Venmo')}
                    </Button>
                  ) : null}
                  {paypalUrl ? (
                    <Button variant="secondary" href={paypalUrl} target="_blank" iconEnd="external" data-testid="settle-paypal">
                      {major ? t('用 PayPal 付 {a}', 'Pay {a} with PayPal', { a: money(minor ?? 0, currency) }) : t('用 PayPal 付款', 'Pay with PayPal')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>

        <div className={s.foot}>
          <Button variant="primary" size="lg" block onClick={save} data-testid="settle-save">
            {t('記錄還款', 'Record a payment')}
          </Button>
        </div>
      </main>

      <MemberPicker
        open={picking === 'from' || picking === 'to'}
        onClose={() => setPicking(null)}
        title={picking === 'to' ? t('付給誰？', 'Paid to whom?') : t('誰付的？', 'Who paid?')}
        members={pickable(picking === 'to' ? to : from)}
        value={picking === 'to' ? to : from}
        meId={meId}
        onSelect={(id: string) => {
          if (picking === 'to') {
            if (id === from) setFrom(to);
            setTo(id);
          } else {
            if (id === to) setTo(from);
            setFrom(id);
          }
          setPicking(null);
        }}
      />
      <CurrencyPicker
        open={picking === 'currency'}
        onClose={() => setPicking(null)}
        value={currency || base}
        highlight={[base]}
        onSelect={(code: string) => {
          setCurrency(code);
          setRateInput('');
          setEditRate(false);
          setPicking(null);
        }}
      />
    </div>
  );
}

function safeConvert(minor: number, from: string, rate: number, to: string): number | null {
  try {
    return convertMinor(minor, from, rate, to);
  } catch {
    return null;
  }
}

/** The page sheet's header: 取消 on the left, the title and the group centered. */
function Header({ title, sub, onCancel }: { title: string; sub?: ReactNode; onCancel: () => void }) {
  const { t } = useT();
  return (
    <header className={s.head}>
      <button type="button" className={s.cancel} onClick={onCancel} data-testid="sheet-close">
        {t('取消', 'Cancel')}
      </button>
      <div className={s.headTitle}>
        <h1 id="settle-title">{title}</h1>
        {sub ? <span className={s.headSub}>{sub}</span> : null}
      </div>
      <span aria-hidden="true" />
    </header>
  );
}
