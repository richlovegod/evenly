// 設定 tab: the group's name, type and cover, the whiteboard (notes, saved when you leave the box),
// members, the invite link, the currency (every entry converted at today's rate, after a
// confirmation), 簡化債務, CSV export, Splitwise import, leaving, and (admins) deleting.

import { useEffect, useMemo, useRef, useState } from 'react';
import { netBalances } from '../../../shared/balances';
import { categoryLabel } from '../../../shared/categories';
import { currencyName } from '../../../shared/currencies';
import { todayISO } from '../../../shared/dates';
import type { GroupSnapshotDTO } from '../../../shared/types';
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
import { navigate } from '../../lib/router';
import { actions, useStore, type GroupView } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { cx } from './cx';
import { usableEntries } from './groupMath';
import { ImportSplitwise } from './ImportSplitwise';
import { InviteCard } from './InviteCard';
import { groupPath } from './links';
import { MembersEditor } from './MembersEditor';
import { CoverPicker, GroupTypePicker, clipEmoji, useNamedT, zhSpaced, type PickableGroupType } from './NewGroupPage';
import { buildExportRows, type ExportLabels } from './splitwiseImport';
import s from './SettingsTab.module.css';

const NOTES_MAX = 2000;
const NAME_MAX = 80;
/** Byte order mark: tells Excel the CSV is UTF-8 (else Chinese text turns into garbage). */
const BOM = String.fromCharCode(0xfeff);

/** English singular or plural template (Chinese needs none). */
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

function norm(v: string): string {
  return v.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A file name without characters that file systems refuse. */
function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Evenly';
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
  const snap = view.snap;
  const group = snap?.group;

  const [name, setName] = useState(group?.name ?? '');
  const [nameFocus, setNameFocus] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [notes, setNotes] = useState(group?.notes ?? '');
  const [notesFocus, setNotesFocus] = useState(false);
  const [notesState, setNotesState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [coverOpen, setCoverOpen] = useState(false);
  const [emoji, setEmoji] = useState(group?.emoji ?? '');
  const [color, setColor] = useState(group?.color ?? '');
  const [simplify, setSimplify] = useState(group?.simplify ?? true);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const emojiTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow the server (another member may change things) unless someone is typing here.
  useEffect(() => {
    // Not while a rename is on its way, or the old name would flash back in.
    if (group && !nameFocus && busy !== 'name') setName(group.name);
  }, [group?.name, nameFocus, busy]);
  useEffect(() => {
    if (group && !notesFocus && notesState !== 'saving') setNotes(group.notes);
  }, [group?.notes, notesFocus]);
  useEffect(() => {
    if (group && !emojiTimer.current) setEmoji(group.emoji);
  }, [group?.emoji]);
  useEffect(() => {
    if (group) setColor(group.color);
  }, [group?.color]);
  useEffect(() => {
    if (group) setSimplify(group.simplify);
  }, [group?.simplify]);
  // Leaving the tab while an emoji is still being typed saves it right away.
  const pendingEmoji = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (!emojiTimer.current) return;
      clearTimeout(emojiTimer.current);
      emojiTimer.current = null;
      if (pendingEmoji.current !== null) void actions.updateGroup(gid, { emoji: pendingEmoji.current }).catch(() => undefined);
    },
    [gid],
  );

  const nets = useMemo(() => {
    if (!snap) return {} as Record<string, number>;
    const base = snap.group.currency;
    try {
      return netBalances(usableEntries(snap.expenses, base), base, snap.members.map(m => m.id));
    } catch {
      return {} as Record<string, number>;
    }
  }, [snap]);

  if (!snap || !group) return null;
  const meId = snap.me.memberId;
  const isAdmin = snap.me.role === 'admin';
  const isPair = group.type === 'pair';
  const pendingCount = Object.keys(view.pending).length;

  async function save(req: Parameters<typeof actions.updateGroup>[1], key: string): Promise<boolean> {
    setBusy(key);
    try {
      await actions.updateGroup(gid, req);
      return true;
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error' });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function saveName() {
    if (!group) return;
    const v = name.replace(/\s+/g, ' ').trim();
    if (!v) {
      setNameError(t('群組名稱不能空白', 'The name cannot be empty'));
      setName(group.name);
      return;
    }
    if (Array.from(v).length > NAME_MAX) {
      setNameError(t('群組名稱最多 80 個字', 'Use at most 80 characters'));
      return;
    }
    setNameError(undefined);
    if (v === group.name) {
      setName(v);
      return;
    }
    if (await save({ name: v }, 'name')) showToast({ message: t('已改名為「{name}」', 'Renamed to {name}', { name: v }), kind: 'success', duration: 2500 });
  }

  async function saveNotes() {
    if (!group) return;
    const v = notes.slice(0, NOTES_MAX);
    if (v.trim() === group.notes.trim()) return;
    setNotesState('saving');
    try {
      await actions.updateGroup(gid, { notes: v.trim() });
      setNotesState('saved');
    } catch (e) {
      setNotesState('error');
      showToast({ message: errorMessage(e), kind: 'error' });
    }
  }

  function pickEmoji(v: string) {
    setEmoji(v);
    if (emojiTimer.current) clearTimeout(emojiTimer.current);
    const e = clipEmoji(v);
    pendingEmoji.current = group && e !== group.emoji ? e : null;
    // Typed emoji arrive one keystroke at a time: save once typing stops.
    emojiTimer.current = setTimeout(() => {
      emojiTimer.current = null;
      const next = pendingEmoji.current;
      pendingEmoji.current = null;
      if (next !== null) void save({ emoji: next }, 'emoji');
    }, 600);
  }

  async function pickColor(c: string) {
    setColor(c);
    if (group && c.toUpperCase() !== group.color.toUpperCase() && !(await save({ color: c }, 'color'))) setColor(group.color);
  }

  async function pickType(v: PickableGroupType) {
    if (!group || v === group.type) return;
    await save({ type: v }, 'type');
  }

  async function toggleSimplify(v: boolean) {
    setSimplify(v);
    if (!(await save({ simplify: v }, 'simplify')) && group) setSimplify(group.simplify);
  }

  async function pickCurrency(code: string) {
    setCurrencyOpen(false);
    if (!group || code === group.currency) return;
    if (pendingCount > 0) {
      showToast({
        message: t('還有費用在等待同步。等同步完成再換幣別，才不會換算錯。', 'Some entries are still waiting to sync. Change the currency once they are synced, so nothing is converted wrong.'),
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

  function exportCsv() {
    if (!snap) return;
    try {
      exportGroupCsv(snap, locale);
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error' });
    }
  }

  async function leave() {
    if (!group) return;
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
    const yes = await confirmDialog({
      title: t('離開「{name}」？', 'Leave {name}?', { name: group.name }),
      message: t(
        '你的帳已經結清。離開後，這個群組會從你的列表消失，舊的費用還是會顯示你的名字。想回來的話，請別人再傳邀請連結給你。',
        'You are settled up. The group disappears from your list, and old expenses still show your name. To come back, ask someone for the invite link.',
      ),
      confirmLabel: t('離開群組', 'Leave group'),
      danger: true,
    });
    if (!yes) return;
    const groupName = group.name;
    setBusy('leave');
    try {
      await actions.removeMember(gid, meId);
      navigate('/groups', { replace: true });
      showToast({ message: t('已離開「{name}」', 'You left {name}', { name: groupName }), kind: 'success' });
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error', duration: 6000 });
      setBusy(null);
    }
  }

  async function deleteGroup() {
    if (!group) return;
    const groupName = group.name;
    const yes = await confirmDialog({
      title: t('刪除「{name}」？', 'Delete {name}?', { name: groupName }),
      message: t(
        '所有費用、付款和留言都會刪除，群組裡的每個人都會看不到這個群組。刪除後無法在 App 裡復原。',
        'Every expense, payment and comment goes, for everyone in the group. This cannot be undone in the app.',
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
    setBusy('delete');
    try {
      await actions.deleteGroup(gid);
      navigate('/groups', { replace: true });
      showToast({ message: t('已刪除「{name}」', 'Deleted {name}', { name: groupName }), kind: 'success' });
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error' });
      setBusy(null);
    }
  }

  const activeCount = snap.members.filter(m => m.active).length;

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
              <GroupAvatar emoji={emoji} color={color || group.color} name={group.name} currency={group.currency} size={44} />
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
                disabled={busy === 'name'}
                bare
                data-testid="settings-name"
              />
            </div>
          </div>
          <div id="settings-cover" hidden={!coverOpen} className={s.coverBox}>
            <CoverPicker emoji={emoji} color={color || group.color} onEmoji={pickEmoji} onColor={c => void pickColor(c)} />
          </div>
          {!isPair ? (
            <div className={s.typeBox}>
              <p className={s.label} id="settings-type-label">{t('類型', 'Type')}</p>
              <GroupTypePicker
                value={group.type as PickableGroupType}
                onChange={v => void pickType(v)}
                labelId="settings-type-label"
                disabled={busy === 'type'}
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
          <TextField
            label={t('大家都看得到的筆記', 'Notes everyone in the group can see')}
            value={notes}
            onChange={v => setNotes(v.slice(0, NOTES_MAX))}
            multiline
            rows={4}
            maxLength={NOTES_MAX}
            placeholder={t('例如：Airbnb 門鎖密碼、集合地點、收款帳號', 'e.g. the Airbnb door code, where to meet, payment details')}
            hint={
              notesState === 'saving'
                ? t('儲存中…', 'Saving…')
                : notesState === 'saved'
                  ? t('已儲存', 'Saved')
                  : notesState === 'error'
                    ? t('沒有存到，離開這個欄位時會再試一次', 'Not saved; it tries again when you leave the box')
                    : t('離開這個欄位時自動儲存', 'Saved when you leave the box')
            }
            data-testid="settings-notes"
          />
        </div>
      </Section>

      <Section title={t('成員', 'Members')} action={<span className={s.count}>{t('{n} 人', plural(activeCount, '{n} person', '{n} people'), { n: activeCount })}</span>}>
        <MembersEditor gid={gid} view={view} />
      </Section>

      <Section title={t('邀請連結', 'Invite link')}>
        <InviteCard gid={gid} snap={snap} />
      </Section>

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
    </div>
  );
}
