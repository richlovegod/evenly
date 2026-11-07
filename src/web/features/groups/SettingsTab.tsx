// 設定 tab: the group's name, type and cover, the whiteboard (notes, saved when you leave the box),
// members, the invite link, the currency (every entry converted at today's rate, after a
// confirmation), 簡化債務, CSV export, Splitwise import, leaving, and (admins) deleting.
// A 1:1 friend ledger has no type, invite link or archive, and no add-by-name, admin or remove
// under 成員, as on the iPhone app; leaving it is worded on its own and goes back to 朋友
// (settingsRules.ts).
// Changing settings needs a connection: offline the boxes and pickers are disabled, and the
// whiteboard is read-only (its text can still be selected and copied). Whiteboard text that did
// not save is kept in memory for this group (notesDrafts.ts) until it does: leaving the tab keeps
// it, and it is sent again when the tab opens online, or when the connection comes back while it
// is open (closing the page or signing out loses it). A save that replaced another member's newer
// text says so, with 復原 for theirs, which writes nothing once the whiteboard has changed again
// since (notesMoved). 類型, the cover's emoji and its color are written once picking stops
// (deferredSetting.ts), not on every arrow key.

import { useEffect, useMemo, useState } from 'react';
import { netBalances } from '../../../shared/balances';
import { categoryLabel } from '../../../shared/categories';
import { currencyName } from '../../../shared/currencies';
import { todayISO } from '../../../shared/dates';
import { applyDefaultSplit } from '../../../shared/defaultSplit';
import type { GroupSnapshotDTO, GroupType } from '../../../shared/types';
import { Button } from '../../components/Button';
import { CurrencyPicker } from '../../components/CurrencyPicker';
import { confirmDialog, promptDialog } from '../../components/Dialog';
import { GroupAvatar } from '../../components/GroupAvatar';
import { Icon } from '../../components/Icon';
import { Section } from '../../components/Section';
import { Switch } from '../../components/Switch';
import { TextField } from '../../components/TextField';
import { ApiError } from '../../lib/api';
import { downloadFile, toCSV } from '../../lib/csv';
import { errorMessage } from '../../lib/errors';
import { t as translate, type Params } from '../../lib/i18n';
import { liveItems, movesBalances } from '../../lib/outbox';
import { navigate } from '../../lib/router';
import { actions, getState, useStore, type GroupView } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { defaultPayerText, defaultSplitNote, defaultSplitSummary } from '../expenses/defaultSplitText';
import { cx } from './cx';
import { useDeferredSetting } from './deferredSetting';
import { DefaultSplitSheet } from './DefaultSplitSheet';
import { summarize, usableEntries } from './groupMath';
import { ImportSplitwise } from './ImportSplitwise';
import { InviteCard } from './InviteCard';
import { groupPath } from './links';
import { MembersEditor } from './MembersEditor';
import { CoverPicker, GroupTypePicker, clipEmoji, useNamedT, zhSpaced, type PickableGroupType } from './NewGroupPage';
import { notesDrafts, notesMoved, notesOnLeave } from './notesDrafts';
import { leaveMessage, listPathOf } from './settingsRules';
import { buildExportRows, type ExportLabels } from './splitwiseImport';
import s from './SettingsTab.module.css';

const NOTES_MAX = 2000;
/** Group names: at most 80 UTF-16 units, as the Worker's zod rule and the iPhone app count (an emoji takes two). */
const NAME_MAX = 80;
/** Byte order mark: tells Excel the CSV is UTF-8 (else Chinese text turns into garbage). */
const BOM = String.fromCharCode(0xfeff);

/** English singular or plural template (Chinese needs none). */
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Colors are compared without case (#2f6fb5 is #2F6FB5). */
function sameColor(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

function norm(v: string): string {
  return v.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A file name without characters that file systems refuse. */
function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Split Lab';
}

/** The CSV export of a group, in the current language (uses translate(), so call it from an event). */
export function exportGroupCsv(snap: GroupSnapshotDTO, locale: string): void {
  const t = (zh: string, en: string, p?: Params) => translate(zhSpaced(zh, p), en, p);
  const labels: ExportLabels = {
    date: t('日期', 'Date'),
    description: t('說明', 'Description'),
    category: t('分類', 'Category'),
    kind: t('類型', 'Kind'),
    amount: t('金額', 'Amount'),
    currency: t('幣別', 'Currency'),
    fxRate: t('匯率', 'FX rate'),
    baseAmount: t('換算成 {cur}', 'Amount in {cur}', { cur: snap.group.currency }),
    paidBy: t('付款人', 'Paid by'),
    expense: t('費用', 'Expense'),
    payment: t('付款', 'Payment'),
    refund: t('退款', 'Refund'),
    total: t('結餘總計', 'Total balance'),
    categoryLabel: key => categoryLabel(key, locale),
    paymentDescription: (a, b) => t('{a} 付給 {b}', '{a} paid {b}', { a, b }),
    separator: t('、', ', '),
    unknownMember: t('（已移除）', '(removed)'),
  };
  const csv = toCSV(buildExportRows(snap, labels));
  const content = csv.charCodeAt(0) === 0xfeff ? csv : BOM + csv;
  downloadFile(`${fileSafe(snap.group.name)} ${todayISO()}.csv`, 'text/csv;charset=utf-8', content);
}

export function SettingsTab({ gid, view }: { gid: string; view: GroupView }) {
  const { t, money, locale } = useNamedT();
  const online = useStore(st => st.online);
  // My own flag, from GET /api/me (the group snapshot does not carry it).
  const archived = useStore(st => !!st.me?.groups.find(g => g.id === gid)?.archived);
  const snap = view.snap;
  const group = snap?.group;

  // This member's unsaved whiteboard text for this group (notesDrafts).
  const draftKey = snap ? gid + ':' + snap.me.memberId : '';
  const [name, setName] = useState(group?.name ?? '');
  const [nameFocus, setNameFocus] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [notes, setNotes] = useState(() => notesDrafts.get(draftKey)?.text ?? group?.notes ?? '');
  const [notesFocus, setNotesFocus] = useState(false);
  const [notesState, setNotesState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // The server's name and whiteboard as each box last matched them (filled from the server, or saved).
  // A box that still says its base was not typed in and saves nothing, so leaving it never writes an
  // older copy over another member's newer edit (the iOS app's GroupsTextEdits).
  const [nameBase, setNameBase] = useState(group?.name ?? '');
  const [notesBase, setNotesBase] = useState(() => notesDrafts.get(draftKey)?.base ?? group?.notes ?? '');
  const [coverOpen, setCoverOpen] = useState(false);
  // Bumped when an emoji could not be saved: the picker starts over, its typed-emoji box too.
  const [coverKey, setCoverKey] = useState(0);
  // Picked emoji, color and type show at once and are written once picking stops (deferredSetting.ts).
  const emojiPick = useDeferredSetting(gid, group?.emoji ?? '', { failed: () => setCoverKey(k => k + 1) });
  const colorPick = useDeferredSetting(gid, group?.color ?? '', { same: sameColor });
  const typePick = useDeferredSetting<GroupType>(gid, group?.type ?? 'other');
  const [simplify, setSimplify] = useState(group?.simplify ?? true);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [defaultOpen, setDefaultOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // This group's unsynced changes that move balances (a comment or a receipt photo moves none).
  const outbox = useStore(st => st.outbox);
  const waiting = useMemo(() => liveItems(outbox.filter(i => i.groupId === gid)).filter(i => movesBalances(i.op)), [outbox, gid]);

  // Follow the server (another member may change things) unless someone is typing here.
  useEffect(() => {
    // Not while a rename is on its way, or the old name would flash back in.
    if (group && !nameFocus && busy !== 'name') {
      setName(group.name);
      setNameBase(group.name);
    }
  }, [group?.name, nameFocus, busy]);
  useEffect(() => {
    if (!group || notesFocus || notesState === 'saving') return;
    const draft = notesDrafts.get(draftKey);
    if (draft && draft.text.trim() !== group.notes.trim()) {
      // Typed here and not saved yet: it stays in the box whatever the server has meanwhile, and
      // goes once this tab is open online (another member's newer text then gets 復原 in the toast).
      setNotes(draft.text);
      setNotesBase(draft.base);
      return;
    }
    if (draft) notesDrafts.delete(draftKey);
    setNotes(group.notes);
    setNotesBase(group.notes);
  }, [group?.notes, notesFocus, draftKey]);
  // Whiteboard text that did not save goes again once the connection is back, and as the tab opens
  // (it was left with the text unsaved). A box being typed in saves when it is left. Nothing else
  // sends it, so the hint says it saves on this page (review G10-contract-01).
  useEffect(() => {
    const draft = notesDrafts.get(draftKey);
    if (!online || !draft || notesFocus) return;
    void sendNotes(draft.text, draft.base);
  }, [online, draftKey]);
  useEffect(() => {
    if (group) setSimplify(group.simplify);
  }, [group?.simplify]);

  const nets = useMemo(() => {
    if (!snap) return {} as Record<string, number>;
    const base = snap.group.currency;
    try {
      return netBalances(usableEntries(snap.expenses, base), base, snap.members.map(m => m.id));
    } catch {
      return {} as Record<string, number>;
    }
  }, [snap]);
  // The settle-up plan as the group page shows it: with 簡化債務 off it keeps debts pair by pair, so
  // a member at net 0 can still be in it, and the server refuses a leave while it names me (review B2-01).
  const plan = useMemo(() => {
    if (!snap) return [];
    try {
      return summarize(snap).transfers;
    } catch {
      return [];
    }
  }, [snap]);

  if (!snap || !group) return null;
  const meId = snap.me.memberId;
  const isAdmin = snap.me.role === 'admin';
  const isPair = group.type === 'pair';

  async function save(req: Parameters<typeof actions.updateGroup>[1], key: string): Promise<boolean> {
    setBusy(key);
    try {
      await actions.updateGroup(gid, req);
      return true;
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error' });
      return false;
    } finally {
      // Only its own: a cover or type pick written meanwhile must not end a rename's busy state.
      setBusy(b => (b === key ? null : b));
    }
  }

  async function saveName() {
    if (!group) return;
    const v = name.replace(/\s+/g, ' ').trim();
    // Not typed in since the box last matched the server: nothing to save (the effect above then shows the server's name).
    if (v === nameBase.replace(/\s+/g, ' ').trim()) return;
    if (!v) {
      setNameError(t('群組名稱不能空白', 'The name cannot be empty'));
      setName(group.name);
      setNameBase(group.name);
      return;
    }
    if (v.length > NAME_MAX) {
      setNameError(t('群組名稱最多 80 個字', 'Use at most 80 characters'));
      return;
    }
    setNameError(undefined);
    if (v === group.name) {
      setName(v);
      setNameBase(v);
      return;
    }
    if (await save({ name: v }, 'name')) {
      setNameBase(v);
      showToast({ message: t('已改名為「{name}」', 'Renamed to {name}', { name: v }), kind: 'success', duration: 2500 });
    }
  }

  async function saveNotes() {
    if (!group) return;
    const v = notes.slice(0, NOTES_MAX);
    // Back at the text it was typed over, or at what the server has: nothing to save, and a draft
    // left from a save that did not go is dropped, so the effect above shows the server's copy
    // instead of bringing that draft back (notesOnLeave, review G10-correct-01).
    const leave = notesOnLeave(v, notesBase, group.notes, notesDrafts.has(draftKey));
    if (leave === 'drop') {
      notesDrafts.delete(draftKey);
      setNotesState('idle');
    }
    if (leave === 'send') await sendNotes(v, notesBase);
  }

  /**
   * Save whiteboard text typed over `base` (the server's text the box had). It is kept in
   * notesDrafts until it saves: offline it waits for the connection (the effect above sends it).
   */
  async function sendNotes(v: string, base: string) {
    if (!group || !draftKey) return;
    const key = draftKey;
    notesDrafts.set(key, { text: v, base });
    if (!online) {
      setNotesState('error');
      return;
    }
    if (v.trim() === group.notes.trim()) {
      notesDrafts.delete(key);
      setNotesState('idle');
      return;
    }
    // Someone else changed it meanwhile: what was typed here still wins, and the toast says so, with
    // 復原 for their text. The notice keeps what this save writes (`ours`, trimmed as the server keeps it).
    const theirs = group.notes;
    const ours = v.trim();
    const replaces = theirs.trim() !== base.trim();
    setNotesState('saving');
    try {
      await actions.updateGroup(gid, { notes: ours });
      if (notesDrafts.get(key)?.text === v) notesDrafts.delete(key);
      setNotesBase(ours);
      setNotesState('saved');
      if (replaces)
        showToast({
          message: t('白板剛被別人改過，已換成你寫的內容', 'Someone else just changed the whiteboard. It now has what you wrote'),
          action: { label: t('復原', 'Undo'), run: () => undoTheirNotes(theirs, ours, key) },
        });
    } catch (e) {
      setNotesState('error');
      showToast({ message: errorMessage(e), kind: 'error' });
    }
  }

  /**
   * 復原 on that notice: puts `theirs` back, unless the whiteboard has changed again since the save
   * wrote `ours` (a newer save of mine, or another member's edit a refresh brought), as the iPhone
   * app refuses it (notesMoved, review G2-correct-01). The group is read from the store when 復原
   * is pressed, not as this tab last drew it: the toast stays up after the tab has gone. A newer
   * save from this device that has not landed counts as a change too (its draft under `key`): on a
   * desktop, pressing 復原 while typing in the box blurs it first, which sends the new text.
   */
  function undoTheirNotes(theirs: string, ours: string, key: string) {
    if (notesMoved(getState().groups[gid]?.snap?.group.notes, ours, notesDrafts.has(key))) {
      showToast({ message: t('白板之後又改過了，所以沒有復原', 'The whiteboard changed again since, so nothing was undone'), kind: 'error' });
      return;
    }
    void actions.updateGroup(gid, { notes: theirs }).catch(e => showToast({ message: errorMessage(e), kind: 'error' }));
  }

  function pickEmoji(v: string) {
    // Typed emoji arrive one keystroke at a time: saved once typing stops.
    emojiPick.pick(clipEmoji(v), e => save({ emoji: e }, 'emoji'));
  }

  function pickColor(c: string) {
    colorPick.pick(c, v => save({ color: v }, 'color'));
  }

  function pickType(v: PickableGroupType) {
    typePick.pick(v, x => save({ type: x }, 'type'));
  }

  async function toggleSimplify(v: boolean) {
    setSimplify(v);
    if (!(await save({ simplify: v }, 'simplify')) && group) setSimplify(group.simplify);
  }

  async function pickCurrency(code: string) {
    setCurrencyOpen(false);
    if (!group || code === group.currency) return;
    // Unsynced saves, deletes and restores were made at the old currency's rates (comments and
    // photos do not count). A failed one never goes by itself: it is named as such.
    if (waiting.length > 0) {
      const failed = new Set(waiting.filter(i => i.error).map(i => i.expenseId)).size;
      showToast({
        message:
          failed > 0
            ? t(
                '有 {n} 筆變更同步失敗，先在費用列表重試或放棄，再換幣別',
                plural(failed, '{n} change failed to sync. Retry or discard it in the list, then change the currency', '{n} changes failed to sync. Retry or discard them in the list, then change the currency'),
                { n: failed },
              )
            : t('還有費用在等待同步。等同步完成再換幣別，才不會換算錯。', 'Some entries are still waiting to sync. Change the currency once they are synced, so nothing is converted wrong.'),
        kind: 'error',
        duration: 6000,
      });
      return;
    }
    const yes = await confirmDialog({
      title: t('把群組幣別換成 {code}？', 'Switch the group currency to {code}?', { code }),
      message: t(
        '每一筆費用（包括已結清的）都會用今天的匯率換算成 {code}，每個人的結餘也會跟著換算。每筆費用原本的金額和幣別都會保留。',
        'Every entry, settled ones included, is converted to {code} at today\'s exchange rate, and so is everyone\'s balance. Each entry keeps its original amount and currency.',
        { code },
      ),
      confirmLabel: t('換成 {code}', 'Switch to {code}', { code }),
    });
    if (!yes) return;
    setBusy('currency');
    try {
      await actions.updateGroup(gid, { currency: code });
      showToast({ message: t('群組幣別已換成 {code}', 'The group currency is now {code}', { code }), kind: 'success' });
    } catch (e) {
      const msg =
        e instanceof ApiError && e.code === 'fx_unavailable'
          ? t('暫時拿不到匯率，請稍後再試', 'Exchange rates are not available right now. Try again later')
          : errorMessage(e);
      showToast({ message: msg, kind: 'error' });
    } finally {
      setBusy(null);
    }
  }

  /** 清除 the default split: new expenses split equally again; 復原 in the toast puts it back. */
  async function clearDefault() {
    const before = group?.defaultSplit;
    if (!before) return;
    setBusy('default');
    try {
      await actions.setDefaultSplit(gid, null);
      showToast({
        message: t('已清除預設分法', 'Default split cleared'),
        kind: 'success',
        action: {
          label: t('復原', 'Undo'),
          run: () =>
            void actions
              .setDefaultSplit(gid, { method: before.method, entries: before.entries, payerId: before.payerId })
              .catch(e => showToast({ message: errorMessage(e), kind: 'error' })),
        },
      });
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error' });
    } finally {
      setBusy(null);
    }
  }

  function exportCsv() {
    if (!snap) return;
    try {
      exportGroupCsv(snap, locale);
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error' });
    }
  }

  async function leave() {
    if (!group || !snap) return;
    const net = nets[meId] ?? 0;
    if (net !== 0) {
      const go = await confirmDialog({
        title: t('還不能離開', 'You cannot leave yet'),
        message:
          net > 0
            ? t('大家還欠你 {amt}。結清以後就能離開。', 'You still get back {amt}. Settle up first, then you can leave.', { amt: money(net, group.currency) })
            : t('你還要付 {amt}。結清以後就能離開。', 'You still owe {amt}. Settle up first, then you can leave.', { amt: money(-net, group.currency) }),
        confirmLabel: t('去結算', 'Settle up'),
      });
      if (go) navigate(groupPath(gid, 'balances'));
      return;
    }
    if (plan.some(tr => tr.from === meId || tr.to === meId)) {
      const go = await confirmDialog({
        title: t('還不能離開', 'You cannot leave yet'),
        message: t(
          '結算建議裡還有你要付或要收的錢。先記錄這些還款，或開啟「簡化債務」，就能離開。',
          'The settle-up plan still has money for you to pay or get back. Record those payments, or turn on Simplify debts, and then you can leave.',
        ),
        confirmLabel: t('去結算', 'Settle up'),
      });
      if (go) navigate(groupPath(gid, 'balances'));
      return;
    }
    const yes = await confirmDialog({
      title: t('離開「{name}」？', 'Leave {name}?', { name: group.name }),
      // A 1:1 ledger has no invite link to come back with: worded on its own.
      message: leaveMessage(snap),
      confirmLabel: t('離開群組', 'Leave group'),
      danger: true,
    });
    if (!yes) return;
    const groupName = group.name;
    const back = listPathOf(group);
    setBusy('leave');
    try {
      await actions.removeMember(gid, meId);
      navigate(back, { replace: true });
      showToast({ message: t('已離開「{name}」', 'You left {name}', { name: groupName }), kind: 'success' });
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error', duration: 6000 });
      setBusy(null);
    }
  }

  /**
   * 封存群組 (docs/SPEC.md section 4, Archive): off my 總覽 and 群組 list. A group I have not
   * settled up asks first, naming my balance; a settled one goes at once, with 復原 in the toast.
   */
  async function toggleArchive() {
    if (!group) return;
    const groupName = group.name;
    if (archived) {
      setBusy('archive');
      try {
        await actions.setArchived(gid, false);
        showToast({ message: t('已取消封存「{name}」', 'Unarchived "{name}"', { name: groupName }), kind: 'success' });
      } catch (e) {
        showToast({ message: errorMessage(e), kind: 'error' });
      } finally {
        setBusy(null);
      }
      return;
    }
    const net = nets[meId] ?? 0;
    if (net !== 0) {
      const amt = money(Math.abs(net), group.currency);
      const yes = await confirmDialog({
        title: t('確定要封存嗎？', 'Archive this group?'),
        message:
          net > 0
            ? t(
                '你在這個群組還有 {amt} 沒結清（你可以拿回）。封存只會把它從你的總覽和群組列表收起來，結餘照樣算在總覽裡；別人新增費用時，它會自己回來。',
                'You still have {amt} to settle here (you get it back). Archiving only takes the group off your Home and Groups lists: the balance still counts on Home, and the group comes back when someone else adds an entry.',
                { amt },
              )
            : t(
                '你在這個群組還有 {amt} 沒結清（你欠）。封存只會把它從你的總覽和群組列表收起來，結餘照樣算在總覽裡；別人新增費用時，它會自己回來。',
                'You still have {amt} to settle here (you owe it). Archiving only takes the group off your Home and Groups lists: the balance still counts on Home, and the group comes back when someone else adds an entry.',
                { amt },
              ),
        confirmLabel: t('封存', 'Archive'),
        cancelLabel: t('先不要', 'Not now'),
      });
      if (!yes) return;
    }
    setBusy('archive');
    try {
      await actions.setArchived(gid, true);
      showToast({
        message: t('已封存「{name}」，在群組頁最下面', 'Archived "{name}". It is at the bottom of Groups', { name: groupName }),
        kind: 'success',
        action: {
          label: t('復原', 'Undo'),
          run: () => void actions.setArchived(gid, false).catch(e => showToast({ message: errorMessage(e), kind: 'error' })),
        },
      });
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error' });
    } finally {
      setBusy(null);
    }
  }

  async function deleteGroup() {
    if (!group) return;
    const groupName = group.name;
    const yes = await confirmDialog({
      title: t('刪除「{name}」？', 'Delete {name}?', { name: groupName }),
      // The server only hides a deleted group and keeps its entries (the privacy page says so), and
      // the daily job deletes its receipt photos: hidden, not deleted, and no date for the photos
      // (review B4b-07, the same words as the iPhone app's GroupSettingsView.deleteWarning).
      message: t(
        '群組裡的每個人都會看不到這個群組，費用、付款和留言也一起隱藏，附上的收據照片之後會刪掉。刪除後無法在 App 裡復原。',
        'Everyone in the group stops seeing it. Its expenses, payments and comments are hidden with it, and its receipt photos are deleted afterwards. This cannot be undone in the app.',
      ),
      confirmLabel: t('繼續', 'Continue'),
      danger: true,
    });
    if (!yes) return;
    const typed = await promptDialog({
      title: t('輸入群組名稱確認刪除', 'Type the group name to delete it'),
      message: t('請輸入「{name}」', 'Type "{name}"', { name: groupName }),
      label: t('群組名稱', 'Group name'),
      placeholder: groupName,
      confirmLabel: t('刪除群組', 'Delete group'),
      danger: true,
    });
    if (typed === null) return;
    if (norm(typed) !== norm(groupName)) {
      showToast({ message: t('名稱不一樣，所以沒有刪除', 'The name does not match, so nothing was deleted'), kind: 'error' });
      return;
    }
    const back = listPathOf(group);
    setBusy('delete');
    try {
      await actions.deleteGroup(gid);
      navigate(back, { replace: true });
      showToast({ message: t('已刪除「{name}」', 'Deleted {name}', { name: groupName }), kind: 'success' });
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error' });
      setBusy(null);
    }
  }

  const activeCount = snap.members.filter(m => m.active).length;
  // The default split in words, who pays by default, and why it is not used as it is (if so).
  const def = group.defaultSplit;
  const nameOf = (id: string) => (id === meId ? t('你', 'you') : snap.members.find(m => m.id === id)?.name ?? t('（已移除）', '(removed)'));
  const applied = applyDefaultSplit(def, snap.members);
  const defNote = defaultSplitNote(applied, nameOf, 'settings');

  return (
    <div className={s.tab}>
      <Section title={t('群組', 'Group')}>
        <div className={cx(s.card, s.yolk, s.form)}>
          <div className={s.nameRow}>
            <button
              type="button"
              className={s.cover}
              onClick={() => setCoverOpen(v => !v)}
              aria-expanded={coverOpen}
              aria-controls="settings-cover"
              aria-label={t('更換封面', 'Change the cover')}
            >
              <GroupAvatar emoji={emojiPick.value} color={colorPick.value || group.color} name={group.name} currency={group.currency} size={44} />
              <span className={s.coverEdit} aria-hidden="true">
                <Icon name="edit" size={12} strokeWidth={2.4} />
              </span>
            </button>
            <div
              className={s.nameField}
              onFocus={() => setNameFocus(true)}
              onBlur={() => {
                setNameFocus(false);
                void saveName();
              }}
            >
              <TextField
                label={t('群組名稱', 'Group name')}
                value={name}
                onChange={v => {
                  setName(v);
                  if (nameError) setNameError(undefined);
                }}
                maxLength={NAME_MAX}
                error={nameError}
                autoComplete="off"
                onEnter={() => (document.activeElement as HTMLElement | null)?.blur()}
                disabled={busy === 'name' || !online}
                bare
                data-testid="settings-name"
              />
            </div>
          </div>
          <div id="settings-cover" hidden={!coverOpen} className={s.coverBox}>
            <CoverPicker key={coverKey} emoji={emojiPick.value} color={colorPick.value || group.color} onEmoji={pickEmoji} onColor={pickColor} disabled={!online} />
          </div>
          {!isPair ? (
            <div className={s.typeBox}>
              <p className={s.label} id="settings-type-label">{t('類型', 'Type')}</p>
              {/* Disabled offline only: never under the focus while a pick is being saved. */}
              <GroupTypePicker
                value={typePick.value as PickableGroupType}
                onChange={pickType}
                labelId="settings-type-label"
                disabled={!online}
                testIdPrefix="settings-type"
              />
            </div>
          ) : null}
        </div>
      </Section>

      <Section title={t('白板', 'Whiteboard')}>
        <div
          className={s.notes}
          onFocus={() => {
            setNotesFocus(true);
            setNotesState('idle');
          }}
          onBlur={() => {
            setNotesFocus(false);
            void saveNotes();
          }}
        >
          {/* Read-only offline, not disabled: a door code in it can still be selected and copied. */}
          <TextField
            label={t('大家都看得到的筆記', 'Notes everyone in the group can see')}
            value={notes}
            onChange={v => setNotes(v.slice(0, NOTES_MAX))}
            multiline
            rows={4}
            maxLength={NOTES_MAX}
            readOnly={!online}
            placeholder={t('例如：Airbnb 門鎖密碼、集合地點、收款帳號', 'e.g. the Airbnb door code, where to meet, payment details')}
            hint={
              notesState === 'saving'
                ? t('儲存中…', 'Saving…')
                : notesDrafts.has(draftKey)
                  ? online
                    ? t('沒有存到，離開這個欄位時會再試一次', 'Not saved; it tries again when you leave the box')
                    : t('還沒存到，連上網路後回到這一頁就會儲存', 'Not saved yet. It saves when you are back online on this page')
                  : notesState === 'saved'
                    ? t('已儲存', 'Saved')
                    : !online
                      ? t('離線中，連上網路才能修改白板', 'You are offline. Connect to edit the whiteboard')
                      : t('離開這個欄位時自動儲存', 'Saved when you leave the box')
            }
            data-testid="settings-notes"
          />
        </div>
      </Section>

      <Section title={t('成員', 'Members')} action={<span className={s.count}>{t('{n} 人', plural(activeCount, '{n} person', '{n} people'), { n: activeCount })}</span>}>
        <MembersEditor gid={gid} view={view} />
      </Section>

      {!isPair ? (
        // A 1:1 ledger takes nobody else (the Worker refuses a third person), so it has no invite
        // link, as on the iPhone app; a friend added by name gets their 專屬連結 under 成員.
        <Section title={t('邀請連結', 'Invite link')}>
          <InviteCard gid={gid} snap={snap} />
        </Section>
      ) : null}

      <Section title={t('幣別與結算', 'Currency and settling up')}>
        <div className={cx(s.card, s.sky)}>
          <button
            type="button"
            className={s.prow}
            onClick={() => setCurrencyOpen(true)}
            disabled={busy === 'currency' || !online}
            aria-haspopup="dialog"
            data-testid="settings-currency"
          >
            <span className={s.prowK}>{t('群組幣別', 'Group currency')}</span>
            <span className={s.prowV}>
              <span className={s.code}>{group.currency}</span>
              <span className={s.prowName}>{currencyName(group.currency, locale)}</span>
            </span>
            {busy === 'currency' ? <span className={s.working}>{t('換算中…', 'Converting…')}</span> : <Icon name="chevronRight" size={18} className={s.chev} />}
          </button>
          <div className={s.switchRow}>
            <Switch
              checked={simplify}
              onChange={v => void toggleSimplify(v)}
              disabled={busy === 'simplify' || !online}
              label={t('簡化債務', 'Simplify debts')}
              description={t('讓大家轉帳的次數最少，每個人該付的總額不變', 'Fewer transfers to settle up; nobody pays more in total')}
            />
          </div>
        </div>
      </Section>

      <Section title={t('預設分法', 'Default split')}>
        <div className={s.card}>
          <div className={s.defLine}>
            <button
              type="button"
              className={cx(s.prow, s.defMain)}
              onClick={() => setDefaultOpen(true)}
              disabled={!online || busy === 'default'}
              aria-haspopup="dialog"
              data-testid="settings-default-split"
            >
              <span className={s.prowTile} aria-hidden="true">
                <Icon name="users" size={22} strokeWidth={2.2} />
              </span>
              <span className={s.prowMain}>
                <span className={s.prowT} data-testid="settings-default-split-text">
                  {def ? defaultSplitSummary(def, nameOf) : t('沒有設定', 'None')}
                </span>
                <span className={s.prowS}>
                  {def
                    ? defaultPayerText(applied?.payerId ?? null, nameOf, meId)
                    : t('新費用平均分給全部的人；點這裡設定一個，群組裡每個人都會用', 'New expenses split equally among everyone. Tap to set one for everyone in the group')}
                </span>
              </span>
              <Icon name="chevronRight" size={18} className={s.chev} />
            </button>
            {def ? (
              <Button
                variant="ghost"
                size="sm"
                className={s.defClear}
                onClick={() => void clearDefault()}
                loading={busy === 'default'}
                disabled={!online}
                data-testid="settings-default-split-clear"
              >
                {t('清除', 'Clear')}
              </Button>
            ) : null}
          </div>
          {defNote ? (
            <p className={cx(s.hint, s.defNote)} data-testid="settings-default-split-note">
              {defNote}
            </p>
          ) : null}
        </div>
      </Section>

      <Section title={t('資料', 'Data')}>
        <div className={s.card}>
          <button type="button" className={s.prow} onClick={exportCsv} data-testid="settings-export">
            <span className={s.prowTile} aria-hidden="true">
              <Icon name="download" size={22} strokeWidth={2.2} />
            </span>
            <span className={s.prowMain}>
              <span className={s.prowT}>{t('匯出 CSV', 'Export CSV')}</span>
              <span className={s.prowS}>{t('每筆費用和每個人的帳，可以用 Excel 或 Numbers 打開', 'Every entry and everyone\'s part, for Excel or Numbers')}</span>
            </span>
          </button>
          <button type="button" className={s.prow} onClick={() => setImportOpen(true)} disabled={!online} data-testid="settings-import">
            <span className={s.prowTile} aria-hidden="true">
              <Icon name="upload" size={22} strokeWidth={2.2} />
            </span>
            <span className={s.prowMain}>
              <span className={s.prowT}>{t('從 Splitwise 匯入', 'Import from Splitwise')}</span>
              <span className={s.prowS}>{t('把 Splitwise 匯出的 CSV 檔搬進這個群組', 'Bring a Splitwise CSV export into this group')}</span>
            </span>
            <Icon name="chevronRight" size={18} className={s.chev} />
          </button>
        </div>
      </Section>

      {!isPair ? (
        // 1:1 ledgers live under 朋友, not on the 群組 list, so they have nothing to archive from.
        <Section title={t('你的列表', 'Your lists')}>
          <div className={s.card}>
            <button
              type="button"
              className={s.prow}
              onClick={() => void toggleArchive()}
              disabled={!online || busy === 'archive'}
              data-testid="settings-archive"
              data-archived={archived ? 'true' : 'false'}
            >
              <span className={s.prowTile} aria-hidden="true">
                <Icon name={archived ? 'restore' : 'archive'} size={22} strokeWidth={2.2} />
              </span>
              <span className={s.prowMain}>
                <span className={s.prowT}>{archived ? t('取消封存', 'Unarchive') : t('封存群組', 'Archive group')}</span>
                <span className={s.prowS}>
                  {archived
                    ? t('這個群組已封存：放回你的總覽和群組列表', 'This group is archived: put it back on your Home and Groups lists')
                    : t('從你的總覽和群組列表收起來，別人不會看到變化，結餘照樣算', 'Take it off your Home and Groups lists. Nobody else sees a change, and its balance still counts')}
                </span>
              </span>
              {busy === 'archive' ? <span className={s.working}>{t('處理中…', 'Working…')}</span> : null}
            </button>
          </div>
        </Section>
      ) : null}

      <div className={s.danger}>
        <Button variant="secondary" icon="logout" block onClick={() => void leave()} loading={busy === 'leave'} disabled={!online} data-testid="settings-leave">
          {t('離開群組', 'Leave group')}
        </Button>
        {isAdmin ? (
          <Button variant="danger-quiet" icon="trash" block onClick={() => void deleteGroup()} loading={busy === 'delete'} disabled={!online} data-testid="settings-delete">
            {t('刪除群組', 'Delete group')}
          </Button>
        ) : null}
        {!online ? <p className={cx(s.hint, s.center)}>{t('離線中，改設定需要網路', 'You are offline. Changing settings needs a connection')}</p> : null}
      </div>

      <CurrencyPicker
        open={currencyOpen}
        onClose={() => setCurrencyOpen(false)}
        value={group.currency}
        onSelect={(code: string) => void pickCurrency(code)}
        highlight={[group.currency, ...Array.from(new Set(snap.expenses.filter(e => !e.deletedAt).map(e => e.currency)))].filter((c, i, a) => a.indexOf(c) === i)}
      />
      <ImportSplitwise open={importOpen} onClose={() => setImportOpen(false)} gid={gid} snap={snap} />
      {defaultOpen ? <DefaultSplitSheet gid={gid} snap={snap} onClose={() => setDefaultOpen(false)} /> : null}
    </div>
  );
}
