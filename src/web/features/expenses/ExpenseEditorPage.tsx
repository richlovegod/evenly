// 新增費用 / 編輯費用 (#/g/<gid>/add, #/g/<gid>/e/<eid>/edit, copy: #/g/<gid>/add?from=<eid>).
// A full-height page sheet (DESIGN.md 8.15, 9): payer and split as one sentence with the faces
// under it, then the receipt being written (date, item, amount, 每人, 你借出) rising out of the
// register's slot right above the keys and 儲存. On a touch screen the register keypad is the
// input; with a mouse there is no keypad and the amount is a real input.
//
// Every per-person number comes from editorLogic.evaluate (computeSharesFor with the entry id),
// so the preview is exactly what the server stores. Saving goes through actions.saveExpense
// (the outbox), so it works offline.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { categoryLabel } from '../../../shared/categories';
import { getCurrency } from '../../../shared/currencies';
import { addDays, REPEATS, todayISO, type Repeat } from '../../../shared/dates';
import { minorToInput } from '../../../shared/money';
import type { ExpenseDTO, GroupSnapshotDTO, MemberDTO } from '../../../shared/types';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { CategoryIcon } from '../../components/CategoryIcon';
import { CategoryPicker } from '../../components/CategoryPicker';
import { Chip } from '../../components/Chip';
import { CurrencyPicker } from '../../components/CurrencyPicker';
import { DateField } from '../../components/DateField';
import { confirmDialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { GroupAvatar, ticketArt } from '../../components/GroupAvatar';
import { Icon } from '../../components/Icon';
import { MemberPicker } from '../../components/MemberPicker';
import { AmountInput } from '../../components/AmountInput';
import { Sheet } from '../../components/Sheet';
import { Spinner } from '../../components/Spinner';
import { useT } from '../../lib/i18n';
import { back, navigate, useRoute } from '../../lib/router';
import { actions, useGroupView, useStore, type GroupView } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { AmountText, SepText } from './AmountText';
import {
  activePreset,
  amountEm,
  applyPreset,
  bodyOfExpense,
  decimalsOf,
  descriptionSuggestions,
  draftFromExpense,
  draftSignature,
  editorMembers,
  evaluate,
  findDuplicate,
  hasOperator,
  mentionedIds,
  newDraft,
  prettyExpression,
  pressKey,
  PRESETS,
  readAmount,
  recentCurrencies,
  shareRange,
  splitPeople,
  toggleIncluded,
  withCategory,
  withCurrency,
  withDescription,
  withSuggestion,
  type EditorDraft,
  type PadKey,
  type PresetKey,
  type Reason,
} from './editorLogic';
import {
  clearCarried,
  clearStash,
  carryDraft,
  lastCurrency,
  peekCarried,
  peekStash,
  rememberCurrency,
  rememberedRate,
  rememberLastGroup,
  rememberRate,
  stashDraft,
  takeFaceHint,
} from './editorPrefs';
import { payerChipText, reasonText, repeatName, splitChipText } from './editorText';
import { FxRow } from './FxRow';
import { Keypad } from './Keypad';
import { leaveTo } from './navTrack';
import { PayersEditor, type PayersPatch } from './PayersEditor';
import { SplitEditor } from './SplitEditor';
import { useFx } from './useFx';
import styles from './ExpenseEditorPage.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type SheetName = 'currency' | 'category' | 'payer' | 'split' | 'date' | 'notes' | 'repeat' | 'group' | 'sender' | 'recipient';

/** True on a mouse or trackpad (no keypad, a real amount input: DESIGN.md 9.1). */
function usePointerFine(): boolean {
  const q = '(pointer: fine)';
  const [fine, setFine] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia(q);
    const on = () => setFine(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return fine;
}

/** How far the on-screen keyboard covers the layout viewport (DESIGN.md 9.5). */
function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!active) return;
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop))));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [active]);
  return active ? inset : 0;
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---------- the route ----------

export function ExpenseEditorPage({ gid, eid }: { gid: string; eid?: string }) {
  const route = useRoute();
  const from = eid ? '' : route.query.get('from') ?? '';
  // A fresh form for every route (another group, another entry, another copy).
  return <EditorLoader key={`${gid}:${eid ?? 'new'}:${from}`} gid={gid} eid={eid} copyFrom={from || undefined} />;
}

function EditorLoader({ gid, eid, copyFrom }: { gid: string; eid?: string; copyFrom?: string }) {
  const { t } = useT();
  const view = useGroupView(gid);
  useEffect(() => {
    void actions.loadGroup(gid);
  }, [gid]);

  const snap = view.snap;
  if (!snap) {
    if (view.error && !view.loading) {
      return (
        <div className={styles.fallback}>
          <EmptyState
            icon="warning"
            title={view.error.code === 'not_found' ? t('找不到這個群組', 'Group not found') : t('打不開這個群組', 'Could not open this group')}
            body={view.error.code === 'not_found' ? t('它可能已被刪除，或你不在這個群組。', 'It may have been deleted, or you are not in it.') : t('請檢查網路後再試一次。', 'Check your connection and try again.')}
            action={<Button variant="secondary" onClick={() => back('/')}>{t('返回', 'Back')}</Button>}
          />
        </div>
      );
    }
    return (
      <div className={styles.fallback} aria-busy="true">
        <Spinner size={28} label={t('載入中', 'Loading')} />
      </div>
    );
  }

  const existing = eid ? snap.expenses.find(e => e.id === eid) : undefined;
  if (eid && !existing) {
    if (view.loading) {
      return (
        <div className={styles.fallback} aria-busy="true">
          <Spinner size={28} label={t('載入中', 'Loading')} />
        </div>
      );
    }
    return (
      <div className={styles.fallback}>
        <EmptyState
          icon="warning"
          title={t('找不到這筆費用', 'Expense not found')}
          body={t('它可能已被刪除。', 'It may have been deleted.')}
          action={<Button variant="secondary" onClick={() => back(`/g/${gid}`)}>{t('回到群組', 'Back to the group')}</Button>}
        />
      </div>
    );
  }
  const copySource = !eid && copyFrom ? snap.expenses.find(e => e.id === copyFrom) : undefined;
  return <Editor gid={gid} snap={snap} view={view} existing={existing} copySource={copySource} />;
}

// ---------- the form ----------

interface EditorProps {
  gid: string;
  snap: GroupSnapshotDTO;
  view: GroupView;
  existing?: ExpenseDTO;
  copySource?: ExpenseDTO;
}

interface Init {
  draft: EditorDraft;
  /** What counts as "no changes" (the fresh form, or the saved entry). */
  base: EditorDraft;
  restored: boolean;
}

function Editor({ gid, snap, view, existing, copySource }: EditorProps) {
  const { t, locale, money, date: fmtDate, zh } = useT();
  const fine = usePointerFine();
  const online = useStore(s => s.online);
  const myGroups = useStore(s => s.me?.groups);
  const meId = snap.me.memberId;
  const group = snap.group;
  const groupCurrency = group.currency;
  const isEdit = !!existing;
  const stashKey = `${gid}:${existing?.id ?? 'new'}`;

  // Members offered: me first, active by sort, plus removed members an edited entry mentions.
  const mentioned = useMemo(() => (existing ? mentionedIds(existing) : []), [existing]);
  const members = useMemo(() => editorMembers(snap.members, meId, mentioned), [snap.members, meId, mentioned]);
  const memberIds = useMemo(() => members.map(m => m.id), [members]);
  const byId = useMemo(() => new Map(members.map(m => [m.id, m])), [members]);
  const activeIds = useMemo(() => members.filter(m => m.active).map(m => m.id), [members]);

  // The first draft. No side effects in here (React may call it twice); cleanup runs after mount.
  const [init] = useState<Init>(() => {
    const today = todayISO();
    if (existing) {
      const d = draftFromExpense(existing, { memberIds });
      const stashed = peekStash(stashKey);
      if (stashed && stashed.id === existing.id) return { draft: stashed, base: d, restored: true };
      return { draft: d, base: d, restored: false };
    }
    const id = newId();
    if (copySource) {
      let d = draftFromExpense(copySource, { memberIds: activeIds, copy: { id, date: today } });
      if (!activeIds.includes(d.payerId)) d = { ...d, payerId: meId };
      const amounts: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.payerAmounts)) if (activeIds.includes(k)) amounts[k] = v;
      d = { ...d, payerAmounts: amounts, fxManual: d.currency !== groupCurrency ? rememberedRate(gid, d.currency) : '' };
      return { draft: d, base: d, restored: false };
    }
    // Default to the group currency. Only when the group's two latest expenses were both in
    // another currency (a TWD group on a yen trip) start in that one; a single foreign entry
    // must not silently flip every later entry (Splitwise's "yen saved as $" problem).
    const latest = (view.snap?.expenses ?? [])
      .filter(e => e.kind === 'expense' && !e.deletedAt)
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, 2);
    const currency = latest.length === 2 && latest[0].currency === latest[1].currency && latest[0].currency !== groupCurrency
      ? latest[0].currency
      : groupCurrency;
    const fresh: EditorDraft = {
      ...newDraft({ id, memberIds: activeIds, meId, currency, date: today }),
      fxManual: currency !== groupCurrency ? rememberedRate(gid, currency) : '',
    };
    const carried = peekCarried(gid);
    if (carried) {
      const d = { ...fresh, ...carried, fxManual: carried.currency !== groupCurrency ? rememberedRate(gid, carried.currency) : '' };
      return { draft: d, base: fresh, restored: false };
    }
    const stashed = peekStash(stashKey);
    if (stashed) return { draft: { ...stashed, id: stashed.id || id }, base: fresh, restored: true };
    return { draft: fresh, base: fresh, restored: false };
  });

  const [draft, setDraft] = useState<EditorDraft>(init.draft);
  const baseSig = useMemo(() => draftSignature(init.base), [init.base]);
  const dirty = draftSignature(draft) !== baseSig;

  const [sheet, setSheet] = useState<SheetName | null>(null);
  /** The person whose field the split sheet should focus when it opens from their face. */
  const [splitFocus, setSplitFocus] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [shake, setShake] = useState(false);
  const [showHint] = useState(() => !isEdit && takeFaceHint());
  const savedRef = useRef(false);
  const leftRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLInputElement>(null);

  const fx = useFx(groupCurrency, draft.date, draft.currency);
  const ev = useMemo(
    () => evaluate(draft, { memberIds, meId, groupCurrency, fetchedRate: fx.rate, locale }),
    [draft, memberIds, meId, groupCurrency, fx.rate, locale],
  );

  const keyboardInset = useKeyboardInset(typing && !fine);
  const pad = !fine && !typing;
  const decimals = decimalsOf(draft.currency);
  const foreign = draft.currency !== groupCurrency;
  const payment = draft.kind === 'payment';
  const twoPeople = !payment && activeIds.length === 2 && activeIds.includes(meId);
  const otherId = twoPeople ? activeIds.find(id => id !== meId) ?? '' : '';

  // ----- after mount: consume the carried draft / stash, say if a form was brought back -----
  const toldRestore = useRef(false);
  useEffect(() => {
    clearCarried();
    clearStash();
    if (init.restored && !toldRestore.current) {
      toldRestore.current = true;
      showToast({
        message: t('已恢復上次沒儲存的內容', 'Brought back what you had not saved'),
        action: { label: t('清除', 'Clear'), run: () => setDraft(init.base) },
        duration: 6000,
      });
    }
  }, []); // once, after the first render

  // The sheet opens scrolled to the bottom (the amount and its result, DESIGN.md 9.7), and stays
  // there while the slip grows (an exchange-rate block, a longer expression) if it was there.
  const slipRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    const slip = slipRef.current;
    if (!slip || typeof ResizeObserver === 'undefined') return;
    let atBottom = true;
    const onScroll = () => {
      atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    };
    const ro = new ResizeObserver(() => {
      if (atBottom) el.scrollTop = el.scrollHeight;
    });
    el.addEventListener('scroll', onScroll, { passive: true });
    ro.observe(slip);
    if (slip.previousElementSibling) ro.observe(slip.previousElementSibling);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, []);

  // The status bar continues the dark area behind the page sheet (DESIGN.md 11), then goes back.
  useEffect(() => {
    const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
    const prev = metas.map(m => m.content);
    const slot = getComputedStyle(document.documentElement).getPropertyValue('--slot').trim();
    if (slot) for (const m of metas) m.content = slot;
    return () => {
      metas.forEach((m, i) => {
        m.content = prev[i];
      });
    };
  }, []);

  // ----- leaving without saving: guard, and keep the form for 30 minutes -----
  const latest = useRef({ draft, dirty });
  latest.current = { draft, dirty };
  useEffect(() => {
    const keep = () => {
      const l = latest.current;
      if (l.dirty && !savedRef.current && !leftRef.current) stashDraft(stashKey, l.draft);
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const l = latest.current;
      if (!l.dirty || savedRef.current || leftRef.current) return;
      keep();
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', keep);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', keep);
      keep();
    };
  }, [stashKey]);

  // ----- is a text field focused (then the keypad hides and a save bar rides the keyboard) -----
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const check = () => {
      const a = document.activeElement;
      const isText =
        !!a &&
        root.contains(a) &&
        a !== amountRef.current &&
        ((a instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(a.type)) || a instanceof HTMLTextAreaElement);
      setTyping(isText);
    };
    const onIn = () => check();
    const onOut = () => window.setTimeout(check, 0);
    root.addEventListener('focusin', onIn);
    root.addEventListener('focusout', onOut);
    return () => {
      root.removeEventListener('focusin', onIn);
      root.removeEventListener('focusout', onOut);
    };
  }, []);

  // ----- editing helpers -----
  const update = useCallback((fn: (d: EditorDraft) => EditorDraft) => setDraft(d => fn(d)), []);

  const onKey = useCallback(
    (k: PadKey) => {
      const a = document.activeElement;
      if (a instanceof HTMLElement && a !== amountRef.current && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) a.blur();
      update(d => ({ ...d, amountRaw: pressKey(d.amountRaw, k, decimalsOf(d.currency)) }));
    },
    [update],
  );

  const setCurrency = (code: string) => {
    update(d => {
      const next = withCurrency(d, code);
      return next === d ? d : { ...next, fxManual: code !== groupCurrency ? rememberedRate(gid, code) : '' };
    });
  };

  const doShake = () => {
    setShake(true);
    window.setTimeout(() => setShake(false), 420);
  };

  /** Point at what stops saving: shake, say it, and open or focus the right place. */
  const guide = (r: Reason) => {
    doShake();
    showToast({ message: reasonText(r, draft.currency), kind: 'error' });
    switch (r.code) {
      case 'amount_empty':
      case 'amount_invalid':
      case 'amount_zero':
        (rootRef.current?.querySelector('[data-testid="editor-amount"]') as HTMLInputElement | null)?.focus();
        break;
      case 'payer_missing':
      case 'payers':
        setSheet(payment ? 'sender' : 'payer');
        break;
      case 'split':
        setSheet('split');
        break;
      case 'recipient_missing':
      case 'payment_self':
        setSheet('recipient');
        break;
      case 'fx_missing':
      case 'fx_invalid':
        (rootRef.current?.querySelector('[data-testid="fx-rate-input"]') as HTMLInputElement | null)?.focus();
        break;
      default:
        break;
    }
  };

  const save = () => {
    if (savedRef.current) return;
    if (ev.reason || !ev.body) {
      if (ev.reason) guide(ev.reason);
      return;
    }
    const body = existing ? { ...ev.body, baseVersion: existing.version } : ev.body;
    savedRef.current = true;
    actions.saveExpense(gid, draft.id, body);
    clearStash();
    rememberLastGroup(gid);
    if (!existing) rememberCurrency(gid, draft.currency);
    if (foreign && ev.fx.source === 'manual') rememberRate(gid, draft.currency, draft.fxManual);
    (document.activeElement as HTMLElement | null)?.blur?.();
    const label = payment
      ? t('已儲存付款', 'Payment saved')
      : t('已儲存「{d}」', 'Saved "{d}"', { d: body.description });
    if (existing) {
      const prev = bodyOfExpense(existing);
      showToast({ message: label, kind: 'success', action: { label: t('復原', 'Undo'), run: () => actions.saveExpense(gid, existing.id, prev) } });
      leaveTo(`/g/${gid}/e/${existing.id}`);
    } else {
      const id = draft.id;
      showToast({ message: label, kind: 'success', action: { label: t('復原', 'Undo'), run: () => actions.deleteExpense(gid, id) } });
      leaveTo(`/g/${gid}`, { groupId: gid });
    }
  };

  const cancel = async () => {
    if (latest.current.dirty) {
      const ok = await confirmDialog({
        title: isEdit ? t('放棄這次的修改？', 'Discard your changes?') : t('放棄這筆費用？', 'Discard this expense?'),
        message: t('還沒儲存的內容會不見。', 'What you typed will not be saved.'),
        confirmLabel: t('放棄', 'Discard'),
        cancelLabel: t('繼續編輯', 'Keep editing'),
        danger: true,
      });
      if (!ok) return;
    }
    leftRef.current = true;
    clearStash();
    back(existing ? `/g/${gid}/e/${existing.id}` : `/g/${gid}`);
  };

  // Keep the latest handlers for the window key listener.
  const handlers = useRef({ save, cancel, onKey });
  handlers.current = { save, cancel, onKey };
  const sheetOpen = sheet !== null;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (sheetOpen || e.defaultPrevented || e.isComposing) return;
      if (document.querySelector('[data-testid="dialog-confirm"]')) return;
      const target = e.target as HTMLElement | null;
      const inField = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handlers.current.save();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        void handlers.current.cancel();
        return;
      }
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      let key: PadKey | null = null;
      if (/^[0-9]$/.test(k)) key = k as PadKey;
      else if (k === '.' || k === ',') key = '.';
      else if (k === '+' || k === '-' || k === '*' || k === '/') key = k;
      else if (k === 'Backspace') key = 'del';
      if (key) {
        e.preventDefault();
        handlers.current.onKey(key);
      } else if (k === 'Enter' && target?.tagName !== 'BUTTON' && target?.tagName !== 'A') {
        e.preventDefault();
        handlers.current.save();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sheetOpen]);

  // ----- derived view data -----
  const symbol = getCurrency(draft.currency).symbol;
  const expr = hasOperator(draft.amountRaw);
  const amountText = expr
    ? ev.total !== null
      ? money(ev.total, draft.currency)
      : ''
    : draft.amountRaw.trim()
      ? symbol + prettyExpression(draft.amountRaw.trim())
      : symbol + '0';
  const amountEmpty = !draft.amountRaw.trim();
  const numberPart = amountText.slice(amountText.indexOf(symbol) >= 0 ? amountText.indexOf(symbol) + symbol.length : 0);
  const em = amountEm(symbol, numberPart, { caret: pad && !expr, equals: expr });
  const spokenAmount =
    ev.total !== null
      ? t('金額 {v} {c}', 'Amount {v} {c}', { v: money(ev.total, draft.currency, { bare: true }), c: zh ? getCurrency(draft.currency).zh : draft.currency })
      : t('金額，還沒輸入', 'Amount, not entered yet');

  const suggestions = useMemo(
    () => (payment ? [] : descriptionSuggestions(view.snap?.expenses ?? [], draft.description, 5)),
    [view.snap?.expenses, draft.description, payment],
  );
  const descEmpty = !draft.description.trim();

  const duplicate = useMemo(() => {
    if (ev.total === null || !ev.payers.length) return null;
    return findDuplicate(view.snap?.expenses ?? [], {
      id: draft.id,
      kind: draft.kind,
      amount: ev.total,
      currency: draft.currency,
      date: draft.date,
      payerIds: ev.payers.map(p => p.memberId),
    });
  }, [view.snap?.expenses, draft.id, draft.kind, draft.currency, draft.date, ev.total, ev.payers]);

  const highlight = useMemo(() => recentCurrencies(view.snap?.expenses ?? [], groupCurrency), [view.snap?.expenses, groupCurrency]);
  const groupChoices: { id: string; name: string; emoji: string; color: string; currency: string }[] = myGroups?.length
    ? myGroups.map(g => ({ id: g.id, name: g.name, emoji: g.emoji, color: g.color, currency: g.currency }))
    : [{ id: group.id, name: group.name, emoji: group.emoji, color: group.color, currency: group.currency }];

  const nameOf = (id: string) => (id === meId ? t('你', 'you') : byId.get(id)?.name ?? t('（已移除）', '(removed)'));
  const sharePeople = ev.shares.length || splitPeople(ev.split);
  const singleId = draft.split.method === 'equal' && draft.split.included.length === 1 ? draft.split.included[0] : ev.shares.length === 1 ? ev.shares[0].memberId : '';
  const splitText = splitChipText(draft.split.method, sharePeople, singleId ? nameOf(singleId) : undefined);
  const payerText = payerChipText(draft, members, meId);
  const preset = twoPeople ? activePreset(draft, meId, otherId) : null;

  const splitProblem = ev.splitReason ? reasonText(ev.splitReason, draft.currency) : null;
  const payerProblem = ev.payerReason && ev.total !== null ? reasonText(ev.payerReason, draft.currency) : null;
  const amountProblem = ev.reason && (ev.reason.code === 'amount_invalid' || ev.reason.code === 'amount_zero') ? reasonText(ev.reason, draft.currency) : null;
  const blocked = !!ev.reason;
  const blockedText = ev.reason ? reasonText(ev.reason, draft.currency) : null;

  const today = todayISO();
  const dayWord =
    draft.date === today ? t('今天', 'Today') : draft.date === addDays(today, -1) ? t('昨天', 'Yesterday') : draft.date === addDays(today, 1) ? t('明天', 'Tomorrow') : fmtDate(draft.date, 'weekday');
  const saveNote = t('到 {g}', 'to {g}', { g: group.name });
  const title = isEdit ? (payment ? t('編輯付款', 'Edit payment') : t('編輯費用', 'Edit expense')) : t('新增費用', 'Add expense');
  const art = ticketArt(group.emoji);

  // ----- faces -----
  const toggleFace = (id: string) => {
    if (draft.split.method !== 'equal') {
      // With an unequal split a face opens the split editor on that person (DESIGN.md 8.13).
      setSplitFocus(id);
      setSheet('split');
      return;
    }
    const inc = draft.split.included;
    if (inc.length === 1 && inc[0] === id) {
      doShake();
      showToast({ message: t('至少要有一個人分這筆', 'At least one person has to share this'), kind: 'error' });
      return;
    }
    update(d => ({ ...d, split: toggleIncluded(d.split, id, memberIds) }));
  };

  // ----- the result lines on the slip -----
  const range = shareRange(ev.shares);
  const baseRange = ev.base && foreign ? shareRange(ev.base.owed) : null;
  let firstLead: JSX.Element;
  if (!payment && draft.split.method === 'equal' && range) {
    // Rounding can leave one unit more for some people: then it is "about" the smaller share.
    const uneven = range.min !== range.max || (!!baseRange && baseRange.min !== baseRange.max);
    firstLead = (
      <p className={styles.lead}>
        <span className={styles.leadLabel}>{uneven ? t('每人約', 'Each, about') : t('每人', 'Each')}</span>
        <i className={styles.leader} aria-hidden="true" />
        <span className={cx('amt', styles.leadVal)}>
          <AmountText text={money(range.min, draft.currency)} />
          {baseRange ? (
            <>
              {' ≈ '}
              <AmountText text={money(baseRange.min, groupCurrency)} />
            </>
          ) : null}
        </span>
      </p>
    );
  } else if (!payment && ev.shares.some(s => s.memberId === meId)) {
    const mine = ev.shares.find(s => s.memberId === meId)?.amount ?? 0;
    const mineBase = ev.base && foreign ? ev.base.owed.find(o => o.memberId === meId)?.amount ?? null : null;
    firstLead = (
      <p className={styles.lead}>
        <span className={styles.leadLabel}>{t('你的份', 'Your share')}</span>
        <i className={styles.leader} aria-hidden="true" />
        <span className={cx('amt', styles.leadVal)}>
          <AmountText text={money(mine, draft.currency)} />
          {mineBase !== null ? (
            <>
              {' ≈ '}
              <AmountText text={money(mineBase, groupCurrency)} />
            </>
          ) : null}
        </span>
      </p>
    );
  } else {
    // Nothing to say per person yet (no amount), or I am not in an unequal split: the total.
    const equalNoAmount = draft.split.method === 'equal' && ev.total === null;
    firstLead = (
      <p className={cx(styles.lead, styles.leadMute)}>
        <span className={styles.leadLabel}>{equalNoAmount ? t('每人', 'Each') : t('總額', 'Total')}</span>
        <i className={styles.leader} aria-hidden="true" />
        <span className={cx('amt', styles.leadVal)}>
          <AmountText text={money(equalNoAmount ? 0 : ev.total ?? 0, draft.currency)} />
        </span>
      </p>
    );
  }

  let effect: { label: string; tone: string; amount: number | null; currency: string };
  if (!ev.me) {
    effect = { label: t('你的部分', 'Your part'), tone: styles.leadMute, amount: 0, currency: foreign ? groupCurrency : draft.currency };
  } else if (!ev.me.involved) {
    effect = { label: t('你沒參與', 'Not involved'), tone: styles.leadMute, amount: null, currency: ev.me.currency };
  } else if (payment) {
    effect =
      ev.me.net > 0
        ? { label: t('你付出', 'You sent'), tone: '', amount: ev.me.net, currency: ev.me.currency }
        : ev.me.net < 0
          ? { label: t('你收到', 'You received'), tone: '', amount: -ev.me.net, currency: ev.me.currency }
          : { label: t('剛好平衡', 'Even'), tone: styles.leadMute, amount: null, currency: ev.me.currency };
  } else if (ev.me.net > 0) {
    effect = { label: t('你借出', 'You lent'), tone: 'pos', amount: ev.me.net, currency: ev.me.currency };
  } else if (ev.me.net < 0) {
    effect = { label: t('你借入', 'You borrowed'), tone: 'neg', amount: -ev.me.net, currency: ev.me.currency };
  } else {
    effect = { label: t('剛好平衡', 'Even'), tone: styles.leadMute, amount: null, currency: ev.me.currency };
  }

  // ----- render -----
  const amountStyle = { '--amt-em': em } as CSSProperties;
  const payerChip = (
    <Chip
      className={styles.whoChip}
      label={payerText}
      leading={
        draft.payerMode === 'multi' && !payment ? (
          <Icon name="users" size={20} />
        ) : byId.get(draft.payerId) ? (
          <Avatar name={byId.get(draft.payerId)!.name} color={byId.get(draft.payerId)!.color} size={24} ring={draft.payerId === meId} />
        ) : undefined
      }
      trailingIcon="chevronDown"
      onClick={() => setSheet(payment ? 'sender' : 'payer')}
      aria-label={payment ? t('付款的人：{w}，點一下更換', 'Who paid: {w}, tap to change', { w: payerText }) : t('付款人：{w}，點一下更換', 'Paid by: {w}, tap to change', { w: payerText })}
      data-testid="editor-payer"
    />
  );

  return (
    <div ref={rootRef} className={cx(styles.root, fine && styles.fine, typing && !fine && styles.typing)}>
      <div className={styles.peek} aria-hidden="true" />
      <main className={styles.sheet} aria-labelledby="editor-title">
        <div className={styles.grabber} aria-hidden="true" />
        <header className={styles.head}>
          <button type="button" className={styles.textBtn} onClick={() => void cancel()} data-testid="editor-cancel">
            {t('取消', 'Cancel')}
          </button>
          <div className={styles.titleBox}>
            <h1 id="editor-title" className={styles.title}>{title}</h1>
            {isEdit ? (
              <span className={styles.groupName}>{group.name}</span>
            ) : (
              <button
                type="button"
                className={styles.groupPick}
                onClick={() => setSheet('group')}
                aria-label={t('群組：{g}，點一下更換', 'Group: {g}, tap to change', { g: group.name })}
                data-testid="editor-group"
              >
                {art ? <Icon name={art} size={16} strokeWidth={1.8} /> : group.emoji ? <span className={styles.emoji}>{group.emoji}</span> : null}
                <span className={styles.groupText}>{group.name}</span>
                <Icon name="chevronDown" size={15} strokeWidth={2.2} className={styles.dn} />
              </button>
            )}
          </div>
          <span />
        </header>

        <div ref={bodyRef} className={styles.body}>
          <div className={styles.top}>
            {payment ? (
              <p className={styles.who}>
                {payerChip}
                <span>{t('付給', 'paid')}</span>
                <Chip
                  className={styles.whoChip}
                  label={draft.recipientId ? nameOf(draft.recipientId) : t('選擇', 'choose')}
                  leading={
                    byId.get(draft.recipientId) ? (
                      <Avatar name={byId.get(draft.recipientId)!.name} color={byId.get(draft.recipientId)!.color} size={24} ring={draft.recipientId === meId} />
                    ) : undefined
                  }
                  trailingIcon="chevronDown"
                  onClick={() => setSheet('recipient')}
                  data-testid="editor-recipient"
                />
              </p>
            ) : (
              <p className={styles.who}>
                <span>{t('由', 'Paid by')}</span>
                {payerChip}
                <span className={zh ? undefined : styles.comma}>{t('付款，', ',')}</span>
                <Chip
                  className={styles.whoChip}
                  label={splitText}
                  trailingIcon="chevronDown"
                  onClick={() => setSheet('split')}
                  aria-label={t('分法：{s}，點一下更換', 'Split: {s}, tap to change', { s: splitText })}
                  data-testid="editor-split"
                />
              </p>
            )}

            {twoPeople ? (
              <div className={cx(styles.presets, 'no-scrollbar')} role="group" aria-label={t('快速設定', 'Quick choices')}>
                {PRESETS.map(k => (
                  <Chip key={k} size="sm" label={presetLabel(k, t)} selected={preset === k} onClick={() => update(d => applyPreset(d, k, meId, otherId))} data-testid={`preset-${k}`} />
                ))}
              </div>
            ) : null}

            {!payment && !twoPeople ? (
              <Faces
                members={members.filter(m => m.active || draft.split.included.includes(m.id) || ev.shares.some(s => s.memberId === m.id))}
                meId={meId}
                method={draft.split.method}
                included={draft.split.included}
                shares={ev.shares}
                currency={draft.currency}
                onTap={toggleFace}
                withTestIds={sheet !== 'split'}
              />
            ) : null}
            {!payment && !twoPeople && showHint && draft.split.method === 'equal' ? (
              <p className={styles.hint}>{t('點頭像可排除沒參與的人', 'Tap a face to leave someone out')}</p>
            ) : null}

            {payerProblem ? (
              <p className={styles.problem} role="alert" data-testid="payer-error">
                <Icon name="warning" size={16} />
                <span>{payerProblem}</span>
              </p>
            ) : null}
            {splitProblem && sheet !== 'split' ? (
              <p className={styles.problem} role="alert" data-testid="split-error">
                <Icon name="warning" size={16} />
                <span>{splitProblem}</span>
              </p>
            ) : null}
            {duplicate ? (
              <p className={styles.note} data-testid="editor-duplicate">
                <Icon name="info" size={16} />
                <span>
                  {t('同一天已經有一筆一樣金額的費用：{d}', 'There is already an entry with this amount on this day: {d}', {
                    d: duplicate.description || t('付款', 'payment'),
                  })}
                </span>
              </p>
            ) : null}
            {!online ? (
              <p className={styles.note} data-testid="editor-offline">
                <Icon name="offline" size={16} />
                <span>{t('離線中，儲存後會在連線時自動同步', 'You are offline. It syncs when you reconnect')}</span>
              </p>
            ) : null}
          </div>

          <div ref={slipRef} className={cx(styles.slipWrap, shake && styles.shake)}>
            <div className={styles.slip}>
              <div className={styles.rHead}>
                <button
                  type="button"
                  className={styles.mini}
                  onClick={() => setSheet('date')}
                  aria-label={t('日期：{d}，點一下更換', 'Date: {d}, tap to change', { d: fmtDate(draft.date, 'long') + ' ' + dayWord })}
                  data-testid="editor-date"
                >
                  <Icon name="calendar" size={15} />
                  <span className={styles.miniNum}>{fmtDate(draft.date, 'md')}</span>
                  <span>{dayWord}</span>
                </button>
                <span className={styles.rHeadR}>
                  <button
                    type="button"
                    className={cx(styles.mini, draft.notes.trim() && styles.miniOn)}
                    onClick={() => setSheet('notes')}
                    aria-label={draft.notes.trim() ? t('備註：{n}', 'Note: {n}', { n: draft.notes.trim() }) : t('加備註', 'Add a note')}
                    data-testid="editor-notes"
                  >
                    <Icon name="note" size={15} />
                    <span>{t('備註', 'Note')}</span>
                  </button>
                  <button
                    type="button"
                    className={cx(styles.mini, draft.repeat !== 'none' && styles.miniOn)}
                    onClick={() => setSheet('repeat')}
                    aria-label={t('重複：{r}', 'Repeat: {r}', { r: repeatName(draft.repeat) })}
                    data-testid="editor-repeat"
                  >
                    <Icon name="repeat" size={15} />
                    <span>{draft.repeat !== 'none' ? repeatName(draft.repeat) : t('重複', 'Repeat')}</span>
                  </button>
                </span>
              </div>

              <div className={styles.descLine}>
                {payment ? (
                  <span className={styles.catStatic} aria-hidden="true">
                    <CategoryIcon category="payment" size={40} />
                  </span>
                ) : (
                  <button
                    type="button"
                    className={styles.catBtn}
                    onClick={() => setSheet('category')}
                    aria-label={t('分類：{c}，點一下更換', 'Category: {c}, tap to change', { c: categoryLabel(draft.category, locale) })}
                    data-testid="editor-category"
                  >
                    <CategoryIcon category={draft.category} size={40} className={cx(!draft.categoryManual && descEmpty && styles.catBlank)} />
                  </button>
                )}
                <label className="sr-only" htmlFor="editor-description">
                  {t('說明', 'Description')}
                </label>
                <input
                  ref={descRef}
                  id="editor-description"
                  className={cx(styles.desc, descEmpty && suggestions.length > 0 && styles.descShort)}
                  value={draft.description}
                  onChange={e => {
                    const v = e.target.value;
                    update(d => withDescription(d, v));
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      if (fine && !ev.reason) save();
                      else (e.target as HTMLInputElement).blur();
                    }
                  }}
                  placeholder={payment ? t('說明（選填）', 'Description (optional)') : t('說明', 'Description')}
                  maxLength={120}
                  enterKeyHint="done"
                  autoComplete="off"
                  autoCapitalize="sentences"
                  data-testid="editor-description"
                />
                {suggestions.length > 0 && (descEmpty || typing) ? (
                  <div className={cx(styles.recents, !descEmpty && styles.recentsNarrow, 'no-scrollbar')} role="group" aria-label={descEmpty ? t('這個群組最近用過的說明', 'Recent descriptions in this group') : t('相符的說明', 'Matching descriptions')}>
                    {suggestions.map(s => (
                      <button
                        key={s.description}
                        type="button"
                        className={styles.rc}
                        onPointerDown={e => e.preventDefault()}
                        onClick={() => update(d => withSuggestion(d, s))}
                        data-testid="editor-suggestion"
                      >
                        {s.description}
                      </button>
                    ))}
                  </div>
                ) : !payment ? (
                  <button type="button" className={styles.catTxt} tabIndex={-1} aria-hidden="true" onClick={() => setSheet('category')}>
                    {draft.categoryManual
                      ? t('分類：{c}', 'Category: {c}', { c: categoryLabel(draft.category, locale) })
                      : draft.description.trim()
                        ? t('自動分類：{c}', 'Auto: {c}', { c: categoryLabel(draft.category, locale) })
                        : ''}
                  </button>
                ) : null}
              </div>

              {expr && !fine ? (
                <p className={styles.expr} aria-hidden="true">
                  <SepText text={prettyExpression(draft.amountRaw)} />
                  {pad ? <span className={styles.caretSm} /> : null}
                </p>
              ) : (
                <hr className={styles.dash} />
              )}

              {fine ? (
                // With a mouse: the shared AmountInput, a real input in the same type (DESIGN.md 9.1).
                // Its chip gets data-testid="editor-currency"; it shows 「= result」 and formats on blur.
                <AmountInput
                  size="xl"
                  bare
                  autoFocus={!isEdit}
                  className={styles.amountWide}
                  value={draft.amountRaw}
                  onChange={raw => update(d => ({ ...d, amountRaw: raw.slice(0, 40) }))}
                  currency={draft.currency}
                  onCurrencyClick={() => setSheet('currency')}
                  currencyForeign={foreign}
                  error={amountProblem ?? undefined}
                  onEnter={() => {
                    if (!draft.description.trim() && !payment) descRef.current?.focus();
                    else save();
                  }}
                  aria-label={t('金額', 'Amount')}
                  data-testid="editor-amount"
                />
              ) : (
              <div className={styles.amountLine}>
                <button
                  type="button"
                  className={cx(styles.curChip, foreign && styles.curFx)}
                  onClick={() => setSheet('currency')}
                  aria-label={
                    foreign
                      ? t('幣別：{n} {c}，不是群組幣別，點一下更換', 'Currency: {n} {c}, not the group currency, tap to change', { n: zh ? getCurrency(draft.currency).zh : getCurrency(draft.currency).en, c: draft.currency })
                      : t('幣別：{n} {c}，點一下更換', 'Currency: {n} {c}, tap to change', { n: zh ? getCurrency(draft.currency).zh : getCurrency(draft.currency).en, c: draft.currency })
                  }
                  data-testid="editor-currency"
                >
                  {draft.currency}
                  <Icon name="chevronDown" size={18} strokeWidth={2.2} />
                </button>
                <div className={styles.amountBox} style={amountStyle}>
                  {
                    <>
                      <p className={cx('amt', 'amt-display', styles.amount, amountEmpty && styles.amountEmpty)} aria-hidden="true">
                        {expr ? <span className={styles.eq}>=</span> : null}
                        <AmountText text={amountText} />
                        {pad && !expr ? <span className={styles.caret} /> : null}
                      </p>
                      <input
                        ref={amountRef}
                        className={styles.amountInput}
                        value={draft.amountRaw}
                        onChange={e => {
                          const v = e.target.value.slice(0, 40);
                          // Pasted text ("NT$ 1,200", "１２００") is kept as the number it means; anything else is refused.
                          if (/[^\d.,+\-*/]/.test(v)) {
                            const r = readAmount(v, draft.currency);
                            if (r.state !== 'ok' || r.value === null) {
                              showToast({ message: t('貼上的不是金額', 'That is not an amount'), kind: 'error' });
                              return;
                            }
                            const clean = minorToInput(r.value, draft.currency);
                            update(d => ({ ...d, amountRaw: clean }));
                            return;
                          }
                          update(d => ({ ...d, amountRaw: v }));
                        }}
                        inputMode="none"
                        autoComplete="off"
                        aria-label={t('金額', 'Amount')}
                        aria-describedby="editor-amount-spoken"
                        data-testid="editor-amount"
                      />
                    </>
                  }
                  <span id="editor-amount-spoken" className="sr-only" aria-live="polite">
                    {spokenAmount}
                  </span>
                </div>
              </div>
              )}
              {amountProblem && !fine ? (
                <p className={styles.amountProblem} role="alert">
                  {amountProblem}
                </p>
              ) : null}

              {foreign ? (
                <FxRow
                  currency={draft.currency}
                  groupCurrency={groupCurrency}
                  date={draft.date}
                  fx={fx}
                  rate={ev.fx.rate}
                  source={ev.fx.source}
                  converted={ev.converted}
                  manual={draft.fxManual}
                  onManualChange={raw => update(d => ({ ...d, fxManual: raw }))}
                  onReset={() => rememberRate(gid, draft.currency, '')}
                />
              ) : null}

              {payment ? null : firstLead}
              <p className={cx(styles.lead, effect.tone)}>
                <span className={styles.leadLabel}>{effect.label}</span>
                <i className={styles.leader} aria-hidden="true" />
                {effect.amount !== null ? (
                  <span className={cx('amt', styles.leadVal)}>
                    <AmountText text={money(effect.amount, effect.currency)} />
                  </span>
                ) : null}
              </p>
            </div>
          </div>
          {pad ? <div className={styles.lip} aria-hidden="true" /> : null}
        </div>

        {fine ? (
          <footer className={styles.footer}>
            <Button variant="ghost" onClick={() => void cancel()} data-testid="editor-cancel-footer">
              {t('取消', 'Cancel')}
            </Button>
            <Button variant="primary" size="lg" block className={styles.footerSave} onClick={save} aria-disabled={blocked || undefined} data-testid="editor-save">
              <span className={styles.barSaveText}>{t('儲存到 {g}', 'Save to {g}', { g: group.name })}</span>
              {blockedText ? <span className="sr-only">{blockedText}</span> : null}
            </Button>
          </footer>
        ) : pad ? (
          <div className={styles.register}>
            <Keypad onKey={onKey} decimals={decimals} onSave={save} saveDisabled={blocked} saveNote={saveNote} saveReason={blockedText ?? undefined} />
          </div>
        ) : null}
      </main>

      {!fine && typing ? (
        <div className={styles.saveBar} style={{ bottom: keyboardInset, paddingBottom: keyboardInset > 0 ? 4 : `calc(4px + var(--safe-b))` }} onPointerDown={e => e.preventDefault()}>
          <button type="button" className={styles.barDone} onClick={() => (document.activeElement as HTMLElement | null)?.blur?.()} data-testid="editor-done">
            {t('完成', 'Done')}
          </button>
          <button type="button" className={styles.barSave} onClick={save} aria-disabled={blocked || undefined} data-testid="editor-save">
            <span className={styles.barSaveText}>{t('儲存到 {g}', 'Save to {g}', { g: group.name })}</span>
            {blockedText ? <span className="sr-only">{blockedText}</span> : null}
          </button>
        </div>
      ) : null}

      {/* ----- sheets (mounted only while open, so their test ids never appear twice) ----- */}
      {sheet === 'currency' ? (
        <CurrencyPicker
          open
          onClose={() => setSheet(null)}
          value={draft.currency}
          highlight={highlight}
          onSelect={(code: string) => {
            setCurrency(code);
            setSheet(null);
          }}
        />
      ) : null}
      {sheet === 'category' ? (
        <CategoryPicker
          open
          onClose={() => setSheet(null)}
          value={draft.category}
          onSelect={(key: string) => {
            update(d => withCategory(d, key));
            setSheet(null);
          }}
        />
      ) : null}
      {sheet === 'payer' ? (
        <PayersEditor
          open
          onClose={() => setSheet(null)}
          members={members.filter(m => m.active || m.id === draft.payerId || !!draft.payerAmounts[m.id])}
          meId={meId}
          currency={draft.currency}
          total={ev.total}
          mode={draft.payerMode}
          payerId={draft.payerId}
          amounts={draft.payerAmounts}
          onChange={(patch: PayersPatch) => update(d => ({ ...d, ...patch }))}
        />
      ) : null}
      {sheet === 'split' ? (
        <SplitEditor
          open
          onClose={() => {
            setSheet(null);
            setSplitFocus(null);
          }}
          focusMemberId={splitFocus ?? undefined}
          members={members}
          meId={meId}
          currency={draft.currency}
          total={ev.total}
          split={draft.split}
          onChange={s => update(d => ({ ...d, split: s }))}
          shares={ev.shares}
          error={splitProblem}
          badMemberId={ev.splitReason?.memberId}
          badItemId={ev.splitReason?.itemId}
        />
      ) : null}
      {sheet === 'sender' || sheet === 'recipient' ? (
        <MemberPicker
          open
          onClose={() => setSheet(null)}
          title={sheet === 'sender' ? t('誰付的錢', 'Who paid') : t('付給誰', 'Paid to')}
          members={members.filter(m => m.active || m.id === draft.payerId || m.id === draft.recipientId)}
          value={sheet === 'sender' ? draft.payerId : draft.recipientId}
          meId={meId}
          onSelect={(id: string) => {
            update(d => (sheet === 'sender' ? { ...d, payerId: id } : { ...d, recipientId: id }));
            setSheet(null);
          }}
        />
      ) : null}
      {sheet === 'date' ? (
        <Sheet
          open
          onClose={() => setSheet(null)}
          title={t('日期', 'Date')}
          footer={
            <Button variant="primary" block onClick={() => setSheet(null)} data-testid="editor-date-done">
              {t('完成', 'Done')}
            </Button>
          }
        >
          <div className={styles.sheetPad}>
            <DateField value={draft.date} onChange={(iso: string) => update(d => ({ ...d, date: iso }))} min="2000-01-01" max={addDays(todayISO(), 365)} data-testid="editor-date-input" />
          </div>
        </Sheet>
      ) : null}
      {sheet === 'notes' ? (
        <Sheet
          open
          onClose={() => setSheet(null)}
          title={t('備註', 'Note')}
          footer={
            <Button variant="primary" block onClick={() => setSheet(null)} data-testid="editor-notes-done">
              {t('完成', 'Done')}
            </Button>
          }
        >
          <div className={styles.sheetPad}>
            <label className={styles.notesLabel} htmlFor="editor-notes-input">
              {t('備註會顯示在這筆的明細裡', 'Notes show on this entry')}
            </label>
            <textarea
              id="editor-notes-input"
              className={styles.notes}
              value={draft.notes}
              onChange={e => {
                const v = e.target.value;
                update(d => ({ ...d, notes: v }));
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  setSheet(null);
                }
              }}
              rows={5}
              maxLength={2000}
              placeholder={t('例如：訂位代號、誰還沒給錢', 'For example a booking code, or who has not paid yet')}
              autoFocus
              data-testid="editor-notes-input"
            />
          </div>
        </Sheet>
      ) : null}
      {sheet === 'repeat' ? (
        <Sheet open onClose={() => setSheet(null)} title={t('重複', 'Repeat')}>
          <ul className={styles.options} role="radiogroup" aria-label={t('重複', 'Repeat')}>
            {REPEATS.map(r => (
              <li key={r} role="none">
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft.repeat === r}
                  className={styles.option}
                  onClick={() => {
                    update(d => ({ ...d, repeat: r as Repeat }));
                    setSheet(null);
                  }}
                  data-testid={`repeat-option-${r}`}
                >
                  <span className={styles.optionText}>
                    {repeatName(r)}
                    {r !== 'none' ? <small className={styles.optionSub}>{repeatHint(r, draft.date, fmtDate, t)}</small> : null}
                  </span>
                  {draft.repeat === r ? <Icon name="check" size={22} strokeWidth={2.4} /> : null}
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      ) : null}
      {sheet === 'group' ? (
        <Sheet open onClose={() => setSheet(null)} title={t('記到哪個群組', 'Which group')}>
          <ul className={styles.options} role="radiogroup" aria-label={t('記到哪個群組', 'Which group')}>
            {groupChoices.map(g => (
              <li key={g.id} role="none">
                <button
                  type="button"
                  role="radio"
                  aria-checked={g.id === gid}
                  className={styles.option}
                  onClick={() => {
                    setSheet(null);
                    if (g.id === gid) return;
                    carryDraft(g.id, draft);
                    leftRef.current = true;
                    navigate(`/g/${g.id}/add`, { replace: true });
                  }}
                  data-testid="editor-group-option"
                  data-id={g.id}
                >
                  <GroupAvatar emoji={g.emoji} color={g.color} name={g.name} size={36} />
                  <span className={styles.optionText}>
                    <span className={styles.optionName}>{g.name}</span>
                    <small className={styles.optionSub}>{g.currency}</small>
                  </span>
                  {g.id === gid ? <Icon name="check" size={22} strokeWidth={2.4} /> : null}
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      ) : null}
    </div>
  );
}

function presetLabel(k: PresetKey, t: ReturnType<typeof useT>['t']): string {
  switch (k) {
    case 'i-equal': return t('我付，平分', 'I paid, split equally');
    case 'i-full': return t('我付，對方全付', 'I paid, they owe it all');
    case 'they-equal': return t('對方付，平分', 'They paid, split equally');
    case 'they-full': return t('對方付，我全付', 'They paid, I owe it all');
  }
}

function repeatHint(r: Repeat, date: string, fmtDate: ReturnType<typeof useT>['date'], t: ReturnType<typeof useT>['t']): string {
  const day = Number(date.slice(8, 10));
  switch (r) {
    case 'weekly': return t('每{w}自動新增一筆', 'Added again every {w}', { w: fmtDate(date, 'weekday') });
    case 'biweekly': return t('每兩週的{w}自動新增一筆', 'Added again every other {w}', { w: fmtDate(date, 'weekday') });
    case 'monthly': return t('每月 {d} 日自動新增一筆', 'Added again on day {d} of each month', { d: day });
    case 'yearly': return t('每年 {d} 自動新增一筆', 'Added again every year on {d}', { d: fmtDate(date, 'md') });
    default: return '';
  }
}

// ---------- the faces ----------

function Faces({
  members,
  meId,
  method,
  included,
  shares,
  currency,
  onTap,
  withTestIds,
}: {
  members: readonly MemberDTO[];
  meId: string;
  method: EditorDraft['split']['method'];
  included: readonly string[];
  shares: readonly { memberId: string; amount: number }[];
  currency: string;
  onTap: (id: string) => void;
  withTestIds: boolean;
}) {
  const { t, money } = useT();
  const equal = method === 'equal';
  const shareOf = new Map(shares.map(s => [s.memberId, s.amount]));
  return (
    <div className={cx(styles.beads, 'no-scrollbar')} role="group" aria-label={equal ? t('分給誰，點頭像可排除沒參與的人', 'Who shares it: tap a face to leave someone out') : t('每個人的份，點一下修改', 'Each person\'s share, tap to change')}>
      {members.map(m => {
        const name = m.id === meId ? t('你', 'You') : m.name;
        const on = equal ? included.includes(m.id) : shareOf.has(m.id);
        const share = shareOf.get(m.id);
        return (
          <button
            key={m.id}
            type="button"
            className={styles.bead}
            aria-pressed={equal ? on : undefined}
            aria-label={
              equal
                ? on
                  ? t('{n}，參與', '{n}, in', { n: name })
                  : t('{n}，沒參與', '{n}, left out', { n: name })
                : t('{n}：{a}，點一下修改分法', '{n}: {a}, tap to change the split', { n: name, a: money(share ?? 0, currency) })
            }
            onClick={() => onTap(m.id)}
            data-testid={withTestIds ? `split-check-${m.id}` : undefined}
            data-on={on ? 'true' : 'false'}
          >
            <span className={styles.beadAv}>
              <Avatar name={m.name} color={m.color} size={36} ring={m.id === meId} className={cx(styles.av, !on && styles.avOut)} />
              {equal && on ? (
                <span className={styles.check} aria-hidden="true">
                  <Icon name="check" size={12} strokeWidth={3} />
                </span>
              ) : null}
            </span>
            <span className={styles.beadName} aria-hidden="true">{name}</span>
            {!equal ? (
              <span className={cx('amt', styles.beadShare, share === undefined && styles.beadShareNone)} aria-hidden="true">
                <AmountText text={money(share ?? 0, currency)} />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
