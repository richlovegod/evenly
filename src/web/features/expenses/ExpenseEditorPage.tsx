// 新增費用 / 編輯費用 (#/g/<gid>/add, #/g/<gid>/e/<eid>/edit, copy: #/g/<gid>/add?from=<eid>).
// A full-height page sheet in the picture-book style (design/PICTUREBOOK.md, mockups/picturebook/
// add.png): which group, the amount card, what it was, payer and split as one sentence, the faces
// with each share and what it means for you (每人, 你借出), then date, note and repeat. On a touch
// screen the keypad (paper keys, 儲存 in yolk) is the input; with a mouse there is no keypad and
// the amount is a real input.
//
// Every per-person number comes from editorLogic.evaluate (computeSharesFor with the entry id),
// so the preview is exactly what the server stores. Saving goes through actions.saveExpense
// (the outbox), so it works offline.
//
// A receipt photo (docs/SPEC.md section 8.7) is attached with 附收據 or stays attached after a
// 掃描, shown as a small thumbnail with ×; editing shows the entry's photo with replace (tap the
// thumbnail) and ×. The photo is kept in this component only, never in the draft or the stash
// (hundreds of KB): 儲存 queues it right after the save (actions.attachReceipt), so it goes up once
// the entry exists, offline or not; leaving without saving drops it.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type JSX } from 'react';
import { categoryLabel } from '../../../shared/categories';
import { getCurrency } from '../../../shared/currencies';
import { addDays, REPEATS, todayISO, type Repeat } from '../../../shared/dates';
import { minorToInput } from '../../../shared/money';
import type { ExpenseDTO, GroupSnapshotDTO, MemberDTO, ReceiptScanDTO } from '../../../shared/types';
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
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { receiptPhoto, type ReceiptPhoto } from '../../lib/photo';
import { useReceiptImage } from '../../lib/receipts';
import { back, navigate, useRoute } from '../../lib/router';
import { actions, useGroupView, useStore, type GroupView } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { bottomInset, isTypingField, readViewport, watchTyping } from '../../lib/viewport';
import { useGroupSync } from '../groups/useGroupSync';
import { AmountText, SepText } from './AmountText';
import {
  activePreset,
  amountEm,
  applyPreset,
  applyScan,
  bodyOfExpense,
  decimalsOf,
  descriptionSuggestions,
  draftFromExpense,
  draftSignature,
  editorMembers,
  evaluate,
  findDuplicate,
  hasOperator,
  hasTypedItems,
  mentionedIds,
  newDraft,
  prettyExpression,
  pressKey,
  PRESETS,
  readAmount,
  recentCurrencies,
  revertScan,
  shareRange,
  snapshotFromListItem,
  splitPeople,
  toggleIncluded,
  withCategory,
  withCurrency,
  withDescription,
  withSuggestion,
  type EditorDraft,
  type ItemDraft,
  type PadKey,
  type PresetKey,
  type Reason,
  type ScannedText,
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
  takeScanPrivacyNote,
} from './editorPrefs';
import {
  payerChipText, reasonText, receiptPhotoErrorText, repeatName, scanCurrencyKeptText, scanErrorText, scanSummaryText, splitChipText,
} from './editorText';
import { FxRow } from './FxRow';
import { Keypad } from './Keypad';
import { leaveTo } from './navTrack';
import { PayersEditor, type PayersPatch } from './PayersEditor';
import { scanPhotos, scanReceipt } from './receiptScan';
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

/**
 * How far the on-screen keyboard covers the layout viewport (DESIGN.md 9.5): where the save bar puts
 * its bottom edge (lib/viewport.ts bottomInset). Read in the next frame after each event, because
 * WebKit can fire resize before visualViewport.height changes, and again after a window resize,
 * focus or visibility change, in case the visual viewport sent no event of its own. A layout
 * effect, so the first value lands before paint; back to 0 when typing ends, so the next keyboard
 * never starts from this one's height.
 */
function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useLayoutEffect(() => {
    if (!active) return;
    const vv = window.visualViewport;
    if (!vv) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setInset(bottomInset(readViewport()));
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    vv.addEventListener('resize', later);
    vv.addEventListener('scroll', later);
    window.addEventListener('resize', later);
    window.addEventListener('focus', later);
    document.addEventListener('visibilitychange', later);
    return () => {
      vv.removeEventListener('resize', later);
      vv.removeEventListener('scroll', later);
      window.removeEventListener('resize', later);
      window.removeEventListener('focus', later);
      document.removeEventListener('visibilitychange', later);
      if (frame) cancelAnimationFrame(frame);
      setInset(0);
    };
  }, [active]);
  return active ? inset : 0;
}

/**
 * The color behind the page sheet as .root draws it (the sky page under the scrim), for the status
 * bar. The tokens are read through a probe, so the browser hands them back as rgb() / rgba().
 */
function behindSheetColor(): string | null {
  if (typeof document === 'undefined' || !document.body) return null;
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  document.body.appendChild(probe);
  const read = (value: string): number[] | null => {
    probe.style.backgroundColor = value;
    const css = getComputedStyle(probe).backgroundColor;
    const n = /^rgba?\(/.test(css) ? css.match(/[\d.]+/g)?.map(Number) : null;
    return n && n.length >= 3 ? n : null;
  };
  const ground = read('var(--water-t)');
  const scrim = read('var(--scrim)');
  probe.remove();
  if (!ground || !scrim) return null;
  const a = scrim.length > 3 ? scrim[3] : 1;
  const mix = [0, 1, 2].map(i => Math.round(ground[i] * (1 - a) + scrim[i] * a));
  return `rgb(${mix.join(', ')})`;
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
  const online = useStore(s => s.online);
  const listed = useStore(s => s.me?.groups.find(g => g.id === gid));
  useEffect(() => {
    void actions.loadGroup(gid);
  }, [gid]);
  // While the phone has no copy of the group (or of the entry being edited), keep trying (every
  // 20 s, when the connection or the app comes back), so the form opens by itself once it loads.
  // An open form is never polled, so the group does not change under it.
  const missing = !view.snap || (!!eid && !view.snap.expenses.some(e => e.id === eid));
  useGroupSync(missing ? gid : null);

  // Offline, a new entry in a group this phone never opened starts from the group as the last
  // /api/me listed it (name, currency, members). It is saved to the outbox like any other entry.
  const offline = !online || view.error?.code === 'offline';
  const listedSnap = useMemo(() => (listed ? snapshotFromListItem(listed) : null), [listed]);
  const provisional = !view.snap && !eid && offline && !!listedSnap;
  const snap = view.snap ?? (provisional ? listedSnap : null);
  const retry = () => void actions.loadGroup(gid, { force: true });

  if (!snap) {
    if (view.error && !view.loading) {
      const notFound = view.error.code === 'not_found';
      return (
        <div className={styles.fallback}>
          <EmptyState
            icon={view.error.code === 'offline' ? 'offline' : 'warning'}
            title={notFound ? t('找不到這個群組', 'Group not found') : t('現在無法載入這個群組', 'This group cannot load right now')}
            body={notFound ? t('它可能已被刪除，或你不在這個群組。', 'It may have been deleted, or you are not in it.') : errorMessage(view.error)}
            action={
              <>
                {notFound ? null : (
                  <Button variant="secondary" icon="sync" onClick={retry} data-testid="editor-retry">
                    {t('再試一次', 'Try again')}
                  </Button>
                )}
                <Button variant={notFound ? 'secondary' : 'ghost'} onClick={() => back('/')}>
                  {t('返回', 'Back')}
                </Button>
              </>
            }
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
    // The copy on this phone does not have it and the group could not be fetched: say that,
    // rather than that it was deleted.
    const failed = !!view.error && view.error.code !== 'not_found';
    return (
      <div className={styles.fallback}>
        <EmptyState
          icon={failed && view.error?.code === 'offline' ? 'offline' : 'warning'}
          title={failed ? t('現在無法載入這筆費用', 'This expense cannot load right now') : t('找不到這筆費用', 'Expense not found')}
          body={failed ? errorMessage(view.error) : t('它可能已被刪除。', 'It may have been deleted.')}
          action={
            <>
              {failed ? (
                <Button variant="secondary" icon="sync" onClick={retry} data-testid="editor-retry">
                  {t('再試一次', 'Try again')}
                </Button>
              ) : null}
              <Button variant={failed ? 'ghost' : 'secondary'} onClick={() => back(`/g/${gid}`)}>
                {t('回到群組', 'Back to the group')}
              </Button>
            </>
          }
        />
      </div>
    );
  }
  const copySource = !eid && copyFrom ? snap.expenses.find(e => e.id === copyFrom) : undefined;
  return <Editor gid={gid} snap={snap} view={view} existing={existing} copySource={copySource} provisional={snap !== view.snap} />;
}

// ---------- the form ----------

interface EditorProps {
  gid: string;
  snap: GroupSnapshotDTO;
  view: GroupView;
  existing?: ExpenseDTO;
  copySource?: ExpenseDTO;
  /** `snap` stands in for a group this phone has no copy of (offline, from /api/me). */
  provisional?: boolean;
}

/**
 * The receipt photo change 儲存 makes: none (the entry keeps what it has), a new photo (from
 * 附收據 or a scan), or taking the entry's photo off.
 */
type PhotoChoice = { kind: 'keep' } | { kind: 'new'; photo: ReceiptPhoto } | { kind: 'remove' };

interface Init {
  draft: EditorDraft;
  /** What counts as "no changes" (the fresh form, or the saved entry). */
  base: EditorDraft;
  restored: boolean;
}

function Editor({ gid, snap, view, existing, copySource, provisional }: EditorProps) {
  const { t, locale, money, date: fmtDate, zh } = useT();
  const fine = usePointerFine();
  /** The pointer now, for the typing watch (it reads this at every check). */
  const fineRef = useRef(fine);
  fineRef.current = fine;
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
      d = { ...d, payerAmounts: amounts, fxManual: d.currency !== groupCurrency ? rememberedRate(gid, groupCurrency, d.currency) : '' };
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
      fxManual: currency !== groupCurrency ? rememberedRate(gid, groupCurrency, currency) : '',
    };
    const carried = peekCarried(gid);
    if (carried) {
      const d = { ...fresh, ...carried, fxManual: carried.currency !== groupCurrency ? rememberedRate(gid, groupCurrency, carried.currency) : '' };
      return { draft: d, base: fresh, restored: false };
    }
    const stashed = peekStash(stashKey);
    if (stashed) return { draft: { ...stashed, id: stashed.id || id }, base: fresh, restored: true };
    return { draft: fresh, base: fresh, restored: false };
  });

  const [draft, setDraft] = useState<EditorDraft>(init.draft);
  /** The entry as it was when this form opened (the base of a 3-way merge on save). */
  const openedRef = useRef<ExpenseDTO | null>(existing ?? null);
  const baseSig = useMemo(() => draftSignature(init.base), [init.base]);
  const dirty = draftSignature(draft) !== baseSig;
  const [photoChoice, setPhotoChoice] = useState<PhotoChoice>({ kind: 'keep' });

  const [sheet, setSheet] = useState<SheetName | null>(null);
  /** The person whose field the split sheet should focus when it opens from their face. */
  const [splitFocus, setSplitFocus] = useState<string | null>(null);
  /**
   * The form as it was when the open sheet appeared. The sheets apply edits as they are made, so
   * the faces and the slip follow live; 完成 (or a choice that closes the sheet) keeps them, and
   * 取消, Escape, the scrim or a drag down puts back what the sheet started with (DESIGN.md 8.15:
   * 取消 on the left, 完成 confirms).
   */
  const sheetStart = useRef<EditorDraft | null>(null);
  const openSheet = (name: SheetName) => {
    sheetStart.current = draft;
    setSheet(name);
  };
  /** Close the sheet and keep what was changed in it. */
  const closeSheet = () => {
    sheetStart.current = null;
    setSheet(null);
    setSplitFocus(null);
  };
  /** Close the sheet and undo what it changed: `restore` copies its fields back from the start. */
  const cancelSheet = (restore: (d: EditorDraft, start: EditorDraft) => EditorDraft) => {
    const start = sheetStart.current;
    if (start) setDraft(d => restore(d, start));
    closeSheet();
  };
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

  // ----- the group currency changed under the open form (a sync brought the group's new one) -----
  // A typed or remembered rate meant "1 X = r <old group currency>", and so did the rate an edited
  // entry was saved with: read in the new currency they would be wrong by the exchange rate between
  // the two. Drop them, offer what was typed against the new currency (if anything), and say so.
  const shownBase = useRef(groupCurrency);
  useEffect(() => {
    if (shownBase.current === groupCurrency) return;
    shownBase.current = groupCurrency;
    const hadRate = draft.currency !== groupCurrency && !!draft.fxManual.trim();
    setDraft(d => ({
      ...d,
      fxManual: d.currency !== groupCurrency ? rememberedRate(gid, groupCurrency, d.currency) : '',
      fxStored: existing ? { rate: existing.fxRate, currency: existing.currency, date: existing.date } : null,
    }));
    if (hadRate) {
      showToast({
        message: t('群組幣別改成 {c} 了，請再確認一次匯率', 'The group currency is now {c}. Check the exchange rate again', { c: groupCurrency }),
        duration: 6000,
      });
    }
  }, [groupCurrency]); // only when the group currency changes

  // The amount card is at the top of the sheet now (picture-book layout), so the sheet opens at its
  // top: on a short screen the amount and the description are what shows above the keys, and the
  // faces and date scroll up from under them.

  // The status bar continues the dimmed page behind the sheet (sky under the scrim), then goes back.
  useEffect(() => {
    const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
    const prev = metas.map(m => m.content);
    const behind = behindSheetColor();
    if (behind) for (const m of metas) m.content = behind;
    return () => {
      metas.forEach((m, i) => {
        m.content = prev[i];
      });
    };
  }, []);

  // ----- leaving without saving: guard, and keep the form for 30 minutes -----
  const latest = useRef({ draft, dirty, photo: false });
  // `photo`: a photo change waits too (the stash keeps only the draft, so it alone stashes nothing).
  latest.current = { draft, dirty, photo: photoChoice.kind !== 'keep' };
  useEffect(() => {
    const keep = () => {
      const l = latest.current;
      if (l.dirty && !savedRef.current && !leftRef.current) stashDraft(stashKey, l.draft);
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const l = latest.current;
      // A photo change alone warns too, though only the draft can be kept.
      if ((!l.dirty && !l.photo) || savedRef.current || leftRef.current) return;
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

  // ----- is someone typing in a text field (then the keypad hides and a save bar rides the keyboard) -----
  // lib/viewport.ts watchTyping (DESIGN.md 9.5): a focused text field while the page itself has
  // focus, so the keypad comes back when Chrome for iOS puts the keyboard away without a blur; with
  // a mouse, focus alone. The keypad's amount input and the receipt photo picker (type file) are
  // not text fields.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return watchTyping({
      root,
      isField: a => a !== amountRef.current && isTypingField(a),
      fine: () => fineRef.current,
      onChange: setTyping,
    });
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
      return next === d ? d : { ...next, fxManual: code !== groupCurrency ? rememberedRate(gid, groupCurrency, code) : '' };
    });
  };

  const doShake = () => {
    setShake(true);
    window.setTimeout(() => setShake(false), 420);
  };

  /**
   * Point at what stops saving: shake, say it, and open or focus the right place. Called only from
   * save, which runs in the handler of the tap or key that asked to save (儲存, the keypad's 儲存,
   * Return, Cmd/Ctrl+Enter), so the focus() calls here are inside it and iOS raises the keyboard
   * for the rate field; the phone's amount input has inputmode none and raises none (DESIGN.md 9.5).
   */
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
        openSheet(payment ? 'sender' : 'payer');
        break;
      case 'split':
        openSheet('split');
        break;
      case 'recipient_missing':
      case 'payment_self':
        openSheet('recipient');
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
    // Tell the server which version the form started from and what it looked like then, so it
    // merges this save with anything someone else changed meanwhile instead of overwriting it.
    const opened = openedRef.current;
    let body = ev.body;
    if (existing) {
      const from = opened && opened.id === existing.id ? opened : existing;
      const { baseVersion: _bv, base: _b, ...was } = bodyOfExpense(from);
      body = { ...ev.body, baseVersion: from.version, base: was };
    }
    savedRef.current = true;
    actions.saveExpense(gid, draft.id, body);
    // Queued after the save, so a new entry exists when its photo goes up.
    if (photoChoice.kind === 'new') actions.attachReceipt(gid, draft.id, photoChoice.photo);
    else if (photoChoice.kind === 'remove' && existing) actions.removeReceipt(gid, existing.id);
    clearStash();
    rememberLastGroup(gid);
    if (!existing) rememberCurrency(gid, draft.currency);
    if (foreign && ev.fx.source === 'manual') rememberRate(gid, groupCurrency, draft.currency, draft.fxManual);
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
      // A group this phone has no copy of cannot show its page offline: go back to where the
      // sheet was opened from instead (the entry waits in the outbox and syncs on reconnect).
      if (provisional) back('/');
      else leaveTo(`/g/${gid}`, { groupId: gid });
    }
  };

  const cancel = async () => {
    if (latest.current.dirty || latest.current.photo) {
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

  // ----- 掃描: fill the form from a receipt photo (adding only; docs/PLAN-push-scan-cookies.md 3.2) -----
  // The photo is shrunk here, read once by the Worker and dropped; it never enters the draft.
  const canScan = !isEdit && !payment;
  const fileRef = useRef<HTMLInputElement>(null);
  /** The scan running now: its abort switch and the form as it was when it started. */
  const scanRef = useRef<{ ctrl: AbortController; started: EditorDraft } | null>(null);
  const [scanning, setScanning] = useState(false);
  /** The 品項 lines the last scan put in: a new scan replaces those without asking. */
  const scannedItems = useRef<ItemDraft[] | null>(null);
  /** The store name and category scans put in: a new receipt replaces those as well. */
  const scannedText = useRef<ScannedText | null>(null);
  const sheetNow = useRef(sheet);
  sheetNow.current = sheet;
  // Leaving the editor stops a scan that is still running.
  useEffect(() => () => scanRef.current?.ctrl.abort(), []);

  const onScanTap = () => {
    const running = scanRef.current;
    if (running) {
      // Tapping again stops it.
      running.ctrl.abort();
      scanRef.current = null;
      setScanning(false);
      showToast({ message: t('已停止讀取收據', 'Stopped reading the receipt') });
      return;
    }
    if (!online) {
      showToast({ message: t('離線中不能掃描收據，連線後再試', 'Scanning a receipt needs a connection. Try again when you are online'), kind: 'error' });
      return;
    }
    // Opened right in the tap (iOS shows the picker only then): the camera or the photo library.
    fileRef.current?.click();
  };

  /** Put a scan into the form: one setDraft, an undo in the toast, and what to check. `kept`: its photo stays attached. */
  const fillFromScan = async (scan: ReceiptScanDTO, started: EditorDraft, signal: AbortSignal, kept: boolean) => {
    // An open sheet edits live and its 取消 would put back what it started with: close it first,
    // keeping what was changed in it.
    if (sheetNow.current) closeSheet();
    const opts = {
      started, base: init.base, groupCurrency, today: todayISO(), lastScanned: scannedText.current,
      rateFor: (code: string) => rememberedRate(gid, groupCurrency, code),
    };
    let res = applyScan(latest.current.draft, scan, opts);
    const typed = latest.current.draft.split.items;
    if (res.filled.includes('items') && hasTypedItems(typed, scannedItems.current)) {
      const n = typed.filter(i => i.name.trim() || i.amountRaw.trim() || i.memberIds.length).length;
      const replace = await confirmDialog({
        title: t('換成收據上的品項？', 'Use the items on the receipt?'),
        message: t('你輸入的 {n} 個品項會被換掉。', n === 1 ? 'The item you typed will be replaced.' : 'The {n} items you typed will be replaced.', { n }),
        confirmLabel: t('換掉', 'Replace'),
        cancelLabel: t('保留我的', 'Keep mine'),
      });
      if (signal.aborted) return;
      res = applyScan(latest.current.draft, scan, { ...opts, replaceItems: replace });
    }
    const before = latest.current.draft;
    const after = res.draft;
    const itemsBefore = scannedItems.current;
    const textBefore = scannedText.current;
    const text = res.scannedText;
    setDraft(after);
    if (res.filled.includes('items')) scannedItems.current = after.split.items;
    scannedText.current = text;
    if (res.openSplit) {
      // The split already is 品項: say who had each line. The sheet starts from the filled-in form,
      // so its 取消 keeps the scan.
      sheetStart.current = after;
      setSheet('split');
    }
    const warnings = Array.isArray(scan.warnings) ? scan.warnings.filter((w): w is string => typeof w === 'string') : [];
    const changed = res.filled.length > 0;
    showToast({
      message: scanSummaryText(res, warnings, takeScanPrivacyNote(), kept),
      kind: changed ? 'success' : 'info',
      action: changed
        ? {
            label: t('復原', 'Undo'),
            run: () => {
              if (sheetNow.current) closeSheet();
              const cur = latest.current.draft;
              const undone = revertScan(cur, before, after);
              setDraft(undone);
              // The form no longer shows what this scan put in, so what the scans before it left
              // counts again (unless a newer scan has come since).
              if (scannedText.current === text) scannedText.current = textBefore;
              if (scannedItems.current === after.split.items && undone.split.items === before.split.items) scannedItems.current = itemsBefore;
              // Numbers typed after the scan keep its currency (revertScan): say why it stayed.
              if (before.currency !== after.currency && cur.currency === after.currency && undone.currency === after.currency) {
                showToast({ message: scanCurrencyKeptText(after.currency) });
              }
            },
          }
        : undefined,
      duration: warnings.length || res.notes.length ? 10000 : 7000,
    });
  };

  const runScan = async (file: File) => {
    scanRef.current?.ctrl.abort();
    const job = { ctrl: new AbortController(), started: latest.current.draft };
    scanRef.current = job;
    setScanning(true);
    try {
      const { scan: image, receipt } = await scanPhotos(file);
      if (job.ctrl.signal.aborted) return;
      // The scanned photo stays attached (× takes it off), also when the reading fails.
      if (receipt) setPhotoChoice({ kind: 'new', photo: receipt });
      // The hint is the form's currency, not the group's: a receipt that shows none is read in the
      // hint's decimals and goes into this form, so a 9.75 on a USD form is never read as TWD.
      const scan = await scanReceipt(image, { currency: job.started.currency, locale, signal: job.ctrl.signal });
      if (job.ctrl.signal.aborted || scanRef.current !== job) return;
      scanRef.current = null;
      setScanning(false);
      await fillFromScan(scan, job.started, job.ctrl.signal, !!receipt);
    } catch (err) {
      if (!job.ctrl.signal.aborted) showToast({ message: scanErrorText(err), kind: 'error', duration: 6000 });
    } finally {
      if (scanRef.current === job) {
        scanRef.current = null;
        setScanning(false);
      }
    }
  };

  const onScanFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // the same photo can be picked again, and the input lets go of this one
    if (file) void runScan(file);
  };

  // ----- 附收據: a receipt photo kept with the entry, without scanning -----
  const photoFileRef = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  /** A photo the outbox still holds for this entry (an earlier save that has not uploaded it yet). */
  const queuedPhoto = existing ? view.pendingReceipts[existing.id]?.photo ?? null : null;
  const storedPhoto = useReceiptImage(gid, draft.id, existing?.receipt);
  const photoSrc =
    photoChoice.kind === 'new' ? photoChoice.photo.image : photoChoice.kind === 'keep' ? queuedPhoto?.image ?? storedPhoto.src : null;
  const hasPhoto = photoChoice.kind === 'new' || (photoChoice.kind === 'keep' && (!!queuedPhoto || !!existing?.receipt));

  /** Opened right in the tap (iOS shows the picker only then): the camera or the photo library. */
  const onAttachTap = () => {
    if (preparing) return;
    photoFileRef.current?.click();
  };

  const onPhotoFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPreparing(true);
    try {
      // Shrunk here (1600 px, JPEG 0.7, EXIF and GPS gone); it needs no connection.
      const photo = await receiptPhoto(file);
      if (photo) setPhotoChoice({ kind: 'new', photo });
      else showToast({ message: receiptPhotoErrorText(), kind: 'error' });
    } catch {
      showToast({ message: receiptPhotoErrorText(), kind: 'error' });
    } finally {
      setPreparing(false);
    }
  };

  /** ×: a photo picked here goes (the entry's own shows again); the entry's own is taken off on 儲存. */
  const onRemovePhoto = () => {
    if (photoChoice.kind === 'new') setPhotoChoice({ kind: 'keep' });
    else setPhotoChoice({ kind: 'remove' });
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
  // Archived groups are off my lists, except the one this form is in.
  const groupChoices: { id: string; name: string; emoji: string; color: string; currency: string }[] = myGroups?.length
    ? myGroups.filter(g => !g.archived || g.id === gid).map(g => ({ id: g.id, name: g.name, emoji: g.emoji, color: g.color, currency: g.currency }))
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
      openSheet('split');
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

  // ----- the result lines beside the faces: each share, then what it means for you -----
  const range = shareRange(ev.shares);
  const baseRange = ev.base && foreign ? shareRange(ev.base.owed) : null;
  let firstLead: JSX.Element;
  if (!payment && draft.split.method === 'equal' && range) {
    // Rounding can leave one unit more for some people: then it is "about" the smaller share.
    const uneven = range.min !== range.max || (!!baseRange && baseRange.min !== baseRange.max);
    firstLead = (
      <p className={styles.lead}>
        <span className={styles.leadLabel}>{uneven ? t('每人約', 'Each, about') : t('每人', 'Each')}</span>
        <span className={cx('amt', styles.leadVal)}>
          <AmountText text={money(range.min, draft.currency)} />
        </span>
        {baseRange ? (
          <span className={cx('amt', styles.leadBase)}>
            {'≈ '}
            <AmountText text={money(baseRange.min, groupCurrency)} />
          </span>
        ) : null}
      </p>
    );
  } else if (!payment && ev.shares.some(s => s.memberId === meId)) {
    const mine = ev.shares.find(s => s.memberId === meId)?.amount ?? 0;
    const mineBase = ev.base && foreign ? ev.base.owed.find(o => o.memberId === meId)?.amount ?? null : null;
    firstLead = (
      <p className={styles.lead}>
        <span className={styles.leadLabel}>{t('你的份', 'Your share')}</span>
        <span className={cx('amt', styles.leadVal)}>
          <AmountText text={money(mine, draft.currency)} />
        </span>
        {mineBase !== null ? (
          <span className={cx('amt', styles.leadBase)}>
            {'≈ '}
            <AmountText text={money(mineBase, groupCurrency)} />
          </span>
        ) : null}
      </p>
    );
  } else {
    // Nothing to say per person yet (no amount), or I am not in an unequal split: the total.
    const equalNoAmount = draft.split.method === 'equal' && ev.total === null;
    firstLead = (
      <p className={cx(styles.lead, styles.leadMute)}>
        <span className={styles.leadLabel}>{equalNoAmount ? t('每人', 'Each') : t('總額', 'Total')}</span>
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
  // Top to bottom, like the picture-book sheet (design/mockups/picturebook/add.png): which group,
  // the amount card, what it was, 「由 [你] 付款，[平均分給 6 人]」, the faces with each share and
  // what it means for you, then date, note and repeat; the keypad and 儲存 stay pinned below.
  const amountStyle = { '--amt-em': em } as CSSProperties;
  const payerChip = (
    <Chip
      className={styles.whoChip}
      label={payerText}
      leading={
        draft.payerMode === 'multi' && !payment ? (
          <Icon name="users" size={20} />
        ) : byId.get(draft.payerId) ? (
          <Avatar
            name={byId.get(draft.payerId)!.name}
            color={byId.get(draft.payerId)!.color}
            userId={byId.get(draft.payerId)!.userId}
            avatar={byId.get(draft.payerId)!.avatar}
            size={26}
            ring={draft.payerId === meId}
          />
        ) : undefined
      }
      trailingIcon="chevronDown"
      onClick={() => openSheet(payment ? 'sender' : 'payer')}
      aria-label={payment ? t('付款的人：{w}，點一下更換', 'Who paid: {w}, tap to change', { w: payerText }) : t('付款人：{w}，點一下更換', 'Paid by: {w}, tap to change', { w: payerText })}
      data-testid="editor-payer"
    />
  );
  const people = t('{n} 人', activeIds.length === 1 ? '{n} person' : '{n} people', { n: activeIds.length });
  const cover = art ? <Icon name={art} size={22} strokeWidth={2} /> : group.emoji ? <span className={styles.emoji}>{group.emoji}</span> : null;
  const showFaces = !payment && !twoPeople;

  return (
    <div ref={rootRef} className={cx(styles.root, fine && styles.fine, typing && !fine && styles.typing)}>
      <div className={styles.peek} aria-hidden="true" />
      <main className={styles.sheet} aria-labelledby="editor-title">
        <div className={styles.grabber} aria-hidden="true" />
        <header className={styles.head}>
          <button type="button" className={styles.textBtn} onClick={() => void cancel()} data-testid="editor-cancel">
            {t('取消', 'Cancel')}
          </button>
          <h1 id="editor-title" className={styles.title}>{title}</h1>
          {canScan ? (
            // 掃描 in the header's empty right cell: no new row, so the form keeps its height.
            <button
              type="button"
              className={cx(styles.textBtn, styles.scanBtn)}
              onClick={onScanTap}
              aria-disabled={!online && !scanning ? true : undefined}
              aria-busy={scanning || undefined}
              aria-label={scanning ? t('讀取中，點一下停止', 'Reading, tap to stop') : t('掃描收據', 'Scan a receipt')}
              data-testid="editor-scan"
            >
              {scanning ? <Spinner size={18} decorative /> : <Icon name="camera" size={20} />}
              <span className={styles.scanText}>{scanning ? t('讀取中', 'Reading') : t('掃描', 'Scan')}</span>
            </button>
          ) : (
            <span />
          )}
        </header>
        {canScan ? (
          // No `capture`: iOS then offers the camera and the photo library (receipts kept from a trip).
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className={styles.fileInput}
            tabIndex={-1}
            aria-hidden="true"
            onChange={onScanFile}
            data-testid="editor-scan-file"
          />
        ) : null}

        <div ref={bodyRef} className={styles.body}>
          {/* where it is recorded: a sky pill (a choice while adding, a plain label while editing) */}
          {isEdit ? (
            <p className={cx(styles.ctx, styles.ctxStatic)}>
              {cover ? <span className={styles.cover} aria-hidden="true">{cover}</span> : null}
              <span className={styles.ctxName}>{group.name}</span>
              <span className={styles.ctxMeta}>{people}</span>
            </p>
          ) : (
            <button
              type="button"
              className={styles.ctx}
              onClick={() => openSheet('group')}
              aria-label={t('群組：{g}，點一下更換', 'Group: {g}, tap to change', { g: group.name })}
              data-testid="editor-group"
            >
              {cover ? <span className={styles.cover} aria-hidden="true">{cover}</span> : null}
              <span className={styles.ctxName}>{group.name}</span>
              <span className={styles.ctxMeta}>{people}</span>
              <Icon name="chevronDown" size={20} strokeWidth={2.2} className={styles.dn} />
            </button>
          )}

          {/* the amount card: currency pill and the amount, the expression above it, the rate below */}
          <div className={cx(styles.card, shake && styles.shake)}>
            {expr && !fine ? (
              <p className={styles.expr} aria-hidden="true">
                <SepText text={prettyExpression(draft.amountRaw)} />
                {pad ? <span className={styles.caretSm} /> : null}
              </p>
            ) : null}

            {fine ? (
              // With a mouse: the shared AmountInput, a real input in the same type (DESIGN.md 9.1).
              // Its chip gets data-testid="editor-currency"; it shows 「= result」 and formats on blur.
              <AmountInput
                size="xl"
                bare
                // A new entry starts typing the amount; AmountInput's autoFocus focuses with a
                // mouse only (lib/autoFocus.ts), and this branch is the mouse's anyway.
                autoFocus={!isEdit}
                className={styles.amountWide}
                value={draft.amountRaw}
                onChange={raw => update(d => ({ ...d, amountRaw: raw.slice(0, 40) }))}
                currency={draft.currency}
                onCurrencyClick={() => openSheet('currency')}
                currencyForeign={foreign}
                error={amountProblem ?? undefined}
                onEnter={() => {
                  // Return in the amount moves on to the description: a focus inside the key's
                  // own handler, which keeps a keyboard up, so a plain focus().
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
                  onClick={() => openSheet('currency')}
                  aria-label={
                    foreign
                      ? t('幣別：{n} {c}，不是群組幣別，點一下更換', 'Currency: {n} {c}, not the group currency, tap to change', { n: zh ? getCurrency(draft.currency).zh : getCurrency(draft.currency).en, c: draft.currency })
                      : t('幣別：{n} {c}，點一下更換', 'Currency: {n} {c}, tap to change', { n: zh ? getCurrency(draft.currency).zh : getCurrency(draft.currency).en, c: draft.currency })
                  }
                  data-testid="editor-currency"
                >
                  {draft.currency}
                  <Icon name="chevronDown" size={18} strokeWidth={2.4} />
                </button>
                <div className={styles.amountBox} style={amountStyle}>
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
                onReset={() => rememberRate(gid, groupCurrency, draft.currency, '')}
              />
            ) : null}
          </div>

          {/* what it was: the category circle, the description, the auto category or recents */}
          <div className={styles.descLine}>
            {payment ? (
              <span className={styles.catStatic} aria-hidden="true">
                <CategoryIcon category="payment" size={40} />
              </span>
            ) : (
              <button
                type="button"
                className={styles.catBtn}
                onClick={() => openSheet('category')}
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
                    <span className={styles.rcText}>{s.description}</span>
                  </button>
                ))}
              </div>
            ) : !payment && (draft.categoryManual || !descEmpty) ? (
              // 「自動 餐廳」: the category picked from the description (or the one chosen by hand),
              // a second way into the category picker; the circle on the left is the labelled one.
              <button type="button" className={styles.catTxt} tabIndex={-1} aria-hidden="true" onClick={() => openSheet('category')}>
                {draft.categoryManual ? null : <small className={styles.catAuto}>{t('自動', 'Auto')}</small>}
                <span className={styles.catName}>{categoryLabel(draft.category, locale)}</span>
              </button>
            ) : null}
          </div>

          {/* paid by, split: one sentence with two blanks */}
          {payment ? (
            <p className={styles.who}>
              {payerChip}
              <span>{t('付給', 'paid')}</span>
              <Chip
                className={styles.whoChip}
                label={draft.recipientId ? nameOf(draft.recipientId) : t('選擇', 'choose')}
                leading={
                  byId.get(draft.recipientId) ? (
                    <Avatar
                      name={byId.get(draft.recipientId)!.name}
                      color={byId.get(draft.recipientId)!.color}
                      userId={byId.get(draft.recipientId)!.userId}
                      avatar={byId.get(draft.recipientId)!.avatar}
                      size={26}
                      ring={draft.recipientId === meId}
                    />
                  ) : undefined
                }
                trailingIcon="chevronDown"
                onClick={() => openSheet('recipient')}
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
                onClick={() => openSheet('split')}
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

          {/* who shares it (tap a face to leave someone out), each share, and what it means for you */}
          <div className={cx(styles.split, !showFaces && styles.splitBare)}>
            {showFaces && showHint && draft.split.method === 'equal' ? (
              <p className={styles.hint}>{t('點頭像可排除沒參與的人', 'Tap a face to leave someone out')}</p>
            ) : null}
            {showFaces ? (
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
            <div className={styles.result}>
              {payment ? null : firstLead}
              <p className={cx(styles.lead, effect.tone)}>
                <span className={styles.leadLabel}>{effect.label}</span>
                {effect.amount !== null ? (
                  <span className={cx('amt', styles.leadVal)}>
                    <AmountText text={money(effect.amount, effect.currency)} />
                  </span>
                ) : null}
              </p>
            </div>
          </div>

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

          {/* when, a note, repeat: outlined pills (yolk tint when set) */}
          <div className={styles.opts}>
            <button
              type="button"
              className={cx(styles.opt, styles.optOn)}
              onClick={() => openSheet('date')}
              aria-label={t('日期：{d}，點一下更換', 'Date: {d}, tap to change', { d: fmtDate(draft.date, 'long') + ' ' + dayWord })}
              data-testid="editor-date"
            >
              <Icon name="calendar" size={19} strokeWidth={2.2} />
              <span className={styles.optNum}>{fmtDate(draft.date, 'md')}</span>
              <span>{dayWord}</span>
            </button>
            <button
              type="button"
              className={cx(styles.opt, draft.notes.trim() && styles.optOn)}
              onClick={() => openSheet('notes')}
              aria-label={draft.notes.trim() ? t('備註：{n}', 'Note: {n}', { n: draft.notes.trim() }) : t('加備註', 'Add a note')}
              data-testid="editor-notes"
            >
              <Icon name="note" size={19} strokeWidth={2.2} />
              <span>{t('備註', 'Note')}</span>
            </button>
            <button
              type="button"
              className={cx(styles.opt, draft.repeat !== 'none' && styles.optOn)}
              onClick={() => openSheet('repeat')}
              aria-label={t('重複：{r}', 'Repeat: {r}', { r: repeatName(draft.repeat) })}
              data-testid="editor-repeat"
            >
              <Icon name="repeat" size={19} strokeWidth={2.2} />
              <span>{draft.repeat !== 'none' ? repeatName(draft.repeat) : t('重複', 'Repeat')}</span>
            </button>
            {hasPhoto ? (
              // The attached photo: the thumbnail picks another one, × takes it off.
              <span className={styles.receiptPill}>
                <button
                  type="button"
                  className={styles.receiptThumbBtn}
                  onClick={onAttachTap}
                  aria-busy={preparing || undefined}
                  aria-label={t('收據照片，點一下換一張', 'Receipt photo, tap to choose another')}
                  data-testid="editor-receipt-thumb"
                >
                  {preparing ? (
                    <Spinner size={16} decorative />
                  ) : photoSrc ? (
                    <img className={styles.receiptThumb} src={photoSrc} alt="" draggable={false} onError={photoChoice.kind === 'keep' && !queuedPhoto ? storedPhoto.onError : undefined} />
                  ) : (
                    <Icon name="receipt" size={19} strokeWidth={2.2} />
                  )}
                  <span>{t('收據', 'Receipt')}</span>
                </button>
                <button type="button" className={styles.receiptRemove} onClick={onRemovePhoto} aria-label={t('移除收據照片', 'Remove the receipt photo')} data-testid="editor-receipt-remove">
                  <Icon name="close" size={16} strokeWidth={2.6} />
                </button>
              </span>
            ) : (
              <button
                type="button"
                className={styles.opt}
                onClick={onAttachTap}
                aria-busy={preparing || undefined}
                aria-label={t('附收據照片', 'Attach a receipt photo')}
                data-testid="editor-receipt-attach"
              >
                {preparing ? <Spinner size={16} decorative /> : <Icon name="receipt" size={19} strokeWidth={2.2} />}
                <span>{t('附收據', 'Attach receipt')}</span>
              </button>
            )}
          </div>
          {/* No `capture`: iOS offers the camera and the photo library. */}
          <input
            ref={photoFileRef}
            type="file"
            accept="image/*"
            className={styles.fileInput}
            tabIndex={-1}
            aria-hidden="true"
            onChange={e => void onPhotoFile(e)}
            data-testid="editor-receipt-file"
          />
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
        <div className={styles.saveBar} style={{ bottom: keyboardInset, paddingBottom: keyboardInset > 0 ? 4 : `calc(4px + var(--safe-b))` }} onPointerDown={e => e.preventDefault()} data-testid="editor-savebar">
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
      {/* Pickers change nothing until a choice closes them; the payer, split, date and notes
          sheets edit live, so their 取消 / Escape / scrim / drag puts the start back (cancelSheet). */}
      {sheet === 'currency' ? (
        <CurrencyPicker
          open
          onClose={closeSheet}
          value={draft.currency}
          highlight={highlight}
          onSelect={(code: string) => {
            setCurrency(code);
            closeSheet();
          }}
        />
      ) : null}
      {sheet === 'category' ? (
        <CategoryPicker
          open
          onClose={closeSheet}
          value={draft.category}
          onSelect={(key: string) => {
            update(d => withCategory(d, key));
            closeSheet();
          }}
        />
      ) : null}
      {sheet === 'payer' ? (
        <PayersEditor
          open
          onClose={() => cancelSheet((d, s) => ({ ...d, payerMode: s.payerMode, payerId: s.payerId, payerAmounts: s.payerAmounts }))}
          onDone={closeSheet}
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
          onClose={() => cancelSheet((d, s) => ({ ...d, split: s.split }))}
          onDone={closeSheet}
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
          onClose={closeSheet}
          title={sheet === 'sender' ? t('誰付的錢', 'Who paid') : t('付給誰', 'Paid to')}
          members={members.filter(m => m.active || m.id === draft.payerId || m.id === draft.recipientId)}
          value={sheet === 'sender' ? draft.payerId : draft.recipientId}
          meId={meId}
          onSelect={(id: string) => {
            update(d => (sheet === 'sender' ? { ...d, payerId: id } : { ...d, recipientId: id }));
            closeSheet();
          }}
        />
      ) : null}
      {sheet === 'date' ? (
        <Sheet
          open
          onClose={() => cancelSheet((d, s) => ({ ...d, date: s.date }))}
          title={t('日期', 'Date')}
          footer={
            <Button variant="primary" block onClick={closeSheet} data-testid="editor-date-done">
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
          onClose={() => cancelSheet((d, s) => ({ ...d, notes: s.notes }))}
          title={t('備註', 'Note')}
          footer={
            <Button variant="primary" block onClick={closeSheet} data-testid="editor-notes-done">
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
                  closeSheet();
                }
              }}
              rows={5}
              maxLength={2000}
              placeholder={t('例如：訂位代號、誰還沒給錢', 'For example a booking code, or who has not paid yet')}
              // The sheet focuses it as it opens with a mouse only; on a phone the sheet itself
              // takes focus, and a tap here raises the keyboard (Sheet.tsx useOverlay, DESIGN.md 9.5).
              data-autofocus=""
              data-testid="editor-notes-input"
            />
          </div>
        </Sheet>
      ) : null}
      {sheet === 'repeat' ? (
        <Sheet open onClose={closeSheet} title={t('重複', 'Repeat')}>
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
                    closeSheet();
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
        <Sheet open onClose={closeSheet} title={t('記到哪個群組', 'Which group')}>
          <ul className={styles.options} role="radiogroup" aria-label={t('記到哪個群組', 'Which group')}>
            {groupChoices.map(g => (
              <li key={g.id} role="none">
                <button
                  type="button"
                  role="radio"
                  aria-checked={g.id === gid}
                  className={styles.option}
                  onClick={() => {
                    closeSheet();
                    if (g.id === gid) return;
                    carryDraft(g.id, draft);
                    // Also keep the form here: if the other group cannot open, coming back to this
                    // group's add sheet brings it back (the other editor clears it when it opens).
                    if (dirty) stashDraft(stashKey, draft);
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
  // More faces than fit scroll sideways: the edge where faces are hidden fades (set from the
  // scroll position, like the split method tabs).
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const mark = () => {
      const more = el.scrollWidth - el.clientWidth;
      el.dataset.fade = more <= 1 ? '' : el.scrollLeft <= 1 ? 'end' : el.scrollLeft >= more - 1 ? 'start' : 'both';
    };
    mark();
    el.addEventListener('scroll', mark, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(mark) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', mark);
      ro?.disconnect();
    };
  }, [members.length]);
  return (
    <div ref={rowRef} className={cx(styles.beads, 'no-scrollbar')} role="group" aria-label={equal ? t('分給誰，點頭像可排除沒參與的人', 'Who shares it: tap a face to leave someone out') : t('每個人的份，點一下修改', 'Each person\'s share, tap to change')}>
      {members.map(m => {
        const name = m.id === meId ? t('你', 'You') : m.name;
        const on = equal ? included.includes(m.id) : shareOf.has(m.id);
        const share = shareOf.get(m.id);
        return (
          <button
            key={m.id}
            type="button"
            className={cx(styles.bead, !on && styles.beadOut)}
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
              <Avatar name={m.name} color={m.color} userId={m.userId} avatar={m.avatar} size={34} ring={m.id === meId} className={cx(styles.av, !on && styles.avOut)} />
              {equal && on ? (
                <span className={styles.check} aria-hidden="true">
                  <Icon name="check" size={11} strokeWidth={3.4} />
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
