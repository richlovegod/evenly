// 邀請連結: the group's invite link as a boarding pass with a QR code on its stub to scan across
// the table, copy, share (for LINE: a friendly message plus the link), and for admins a reset
// that retires the old link.

import { useState } from 'react';
import type { GroupSnapshotDTO } from '../../../shared/types';
import { Button } from '../../components/Button';
import { confirmDialog } from '../../components/Dialog';
import { QRCode } from '../../components/QRCode';
import { shareLink } from '../../config';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { copyText, shareOrCopy } from '../../lib/share';
import { actions, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import s from './InviteCard.module.css';

export function inviteLink(snap: Pick<GroupSnapshotDTO, 'inviteCode'>): string {
  return shareLink('/join/' + snap.inviteCode);
}

export function InviteCard({ gid, snap }: { gid: string; snap: GroupSnapshotDTO }) {
  const { t } = useT();
  const online = useStore(st => st.online);
  const [resetting, setResetting] = useState(false);
  const link = inviteLink(snap);
  const isAdmin = snap.me.role === 'admin';
  const groupName = snap.group.name;

  async function copy() {
    const ok = await copyText(link);
    showToast(
      ok
        ? { message: t('已複製邀請連結', 'Invite link copied'), kind: 'success' }
        : { message: t('無法複製，請長按連結選取', 'Could not copy. Press and hold the link to select it'), kind: 'error' },
    );
  }

  async function share() {
    const r = await shareOrCopy({
      title: t('加入「{group}」', 'Join {group}', { group: groupName }),
      text: t(
        '一起用 Evenly 分帳「{group}」，點連結、選你的名字就加入了，不用下載 App：',
        "Let's split costs for {group} on Evenly. Open the link and pick your name to join, no app to install:",
        { group: groupName },
      ),
      url: link,
    });
    if (r === 'failed') showToast({ message: t('無法分享，請改用複製', 'Could not share. Use Copy instead'), kind: 'error' });
  }

  async function reset() {
    const yes = await confirmDialog({
      title: t('重設邀請連結？', 'Reset the invite link?'),
      message: t(
        '舊的連結和 QR code 會立刻失效，還沒加入的人要用新的連結。已經在群組裡的人不受影響。',
        'The old link and QR code stop working right away; anyone who has not joined needs the new one. People already in the group are not affected.',
      ),
      confirmLabel: t('重設連結', 'Reset link'),
      danger: true,
    });
    if (!yes) return;
    setResetting(true);
    try {
      await actions.resetInvite(gid);
      showToast({ message: t('已重設邀請連結', 'The invite link was reset'), kind: 'success' });
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error' });
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className={s.card}>
      <div className={s.pass}>
        <div className={s.main}>
          {/* The pass's header strip: the group it lets you into (the page already says so). */}
          <p className={s.head} aria-hidden="true">
            <span className={s.headName}>{groupName}</span>
            <span className={s.headCode}>{snap.group.currency}</span>
          </p>
          <p className={s.lead}>
            {t('傳這個連結給朋友，或讓他們掃 QR code', 'Send this link to friends, or let them scan the QR code')}
          </p>
          <p className={s.note}>
            {t('打開後選自己的名字就加入了，不用註冊', 'They pick their own name to join, no sign-up needed')}
          </p>
        </div>
        <div className={s.stub}>
          <div className={s.qr}>
            <QRCode text={link} size={112} label={t('邀請連結的 QR code', 'QR code for the invite link')} />
          </div>
        </div>
      </div>
      <p className={s.link} data-testid="settings-invite-link">{link}</p>
      <div className={s.actions}>
        <Button variant="secondary" icon="copy" onClick={() => void copy()} data-testid="settings-invite-copy">
          {t('複製連結', 'Copy link')}
        </Button>
        <Button variant="secondary" icon="share" onClick={() => void share()} data-testid="settings-invite-share">
          {t('分享', 'Share')}
        </Button>
      </div>
      {isAdmin ? (
        <button type="button" className={s.reset} onClick={() => void reset()} disabled={resetting || !online}>
          {resetting ? t('重設中…', 'Resetting…') : t('重設邀請連結', 'Reset invite link')}
        </button>
      ) : null}
    </div>
  );
}
