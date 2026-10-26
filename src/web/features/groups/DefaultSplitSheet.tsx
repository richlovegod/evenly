// 設定 > 預設分法 (docs/SPEC.md section 4, Default split): the group's default split in the split
// sheet, with 平均 / 比例 / 份數 only and no amount, and who pays by default (whoever adds the
// expense, or one member). 儲存 sets it for everyone in the group (PATCH /api/groups/:gid, which
// needs a connection); the active members are the ones offered.

import { useMemo, useState } from 'react';
import { applyDefaultSplit } from '../../../shared/defaultSplit';
import type { SplitErrorCode } from '../../../shared/split';
import type { GroupSnapshotDTO } from '../../../shared/types';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { defaultFromDraft, editorMembers, emptySplit, splitDraftFromInput, type SplitDraft } from '../expenses/editorLogic';
import { defaultSplitNote } from '../expenses/defaultSplitText';
import { splitErrorText } from '../expenses/editorText';
import { SplitEditor } from '../expenses/SplitEditor';

const SPLIT_CODES: readonly string[] = [
  'invalid_total', 'no_participants', 'duplicate_member', 'invalid_value', 'exact_mismatch', 'percent_mismatch', 'zero_weights',
  'negative_share', 'no_items', 'item_no_members', 'items_exceed_total',
];

export function DefaultSplitSheet({ gid, snap, onClose }: { gid: string; snap: GroupSnapshotDTO; onClose: () => void }) {
  const { t } = useT();
  const online = useStore(st => st.online);
  const meId = snap.me.memberId;
  const currency = snap.group.currency;
  // Active members only, me first: a default never holds someone who left.
  const members = useMemo(() => editorMembers(snap.members, meId), [snap.members, meId]);
  const ids = useMemo(() => members.map(m => m.id), [members]);
  const applied = useMemo(() => applyDefaultSplit(snap.group.defaultSplit, snap.members), [snap.group.defaultSplit, snap.members]);
  const [split, setSplit] = useState<SplitDraft>(() => (applied?.split ? splitDraftFromInput(applied.split, ids) : emptySplit(ids)));
  const [payerId, setPayerId] = useState<string | null>(() => applied?.payerId ?? null);
  const [saving, setSaving] = useState(false);

  const candidate = defaultFromDraft(split, ids, currency);
  const error =
    !candidate.ok && candidate.reason === 'invalid'
      ? candidate.code && SPLIT_CODES.includes(candidate.code)
        ? splitErrorText(candidate.code as SplitErrorCode, candidate.diff, currency)
        : t('這個分法還不完整', 'This split is not complete yet')
      : null;
  const nameOf = (id: string) => (id === meId ? t('你', 'you') : snap.members.find(m => m.id === id)?.name ?? t('（已移除）', '(removed)'));
  const note = defaultSplitNote(applied, nameOf, 'settings');

  const save = async () => {
    if (!candidate.ok || saving) return;
    if (!online) {
      showToast({ message: t('連線後才能設定預設分法', 'Setting the default split needs a connection'), kind: 'error' });
      return;
    }
    setSaving(true);
    try {
      await actions.setDefaultSplit(gid, { ...candidate.input, payerId });
      showToast({ message: t('已儲存預設分法', 'Default split saved'), kind: 'success' });
      onClose();
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error' });
      setSaving(false);
    }
  };

  return (
    <SplitEditor
      open
      onClose={onClose}
      onDone={() => void save()}
      title={t('預設分法', 'Default split')}
      doneLabel={saving ? t('儲存中…', 'Saving…') : t('儲存', 'Save')}
      doneDisabled={!candidate.ok || !online || saving}
      methods={['equal', 'percent', 'shares']}
      topNote={t(
        '新費用都會從這個分法開始，群組裡每個人都一樣；每一筆還是可以再改。',
        'Every new expense in the group starts from this split, for everyone; each one can still be changed.',
      )}
      members={members}
      meId={meId}
      currency={currency}
      total={null}
      split={split}
      onChange={setSplit}
      shares={[]}
      error={error}
      payer={{ value: payerId, onChange: setPayerId }}
      notices={[note, online ? null : t('離線中，連線後才能儲存預設分法', 'You are offline. Saving the default split needs a connection')]}
    />
  );
}
