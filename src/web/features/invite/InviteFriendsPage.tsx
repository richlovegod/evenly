// 邀請朋友 (docs/SPEC.md sections 4 and 8.3), under 朋友: my friend invite link as the group
// invite's boarding pass (groups/InviteCard.tsx InvitePass) with its QR code to scan across the
// table; the three ready-made messages (from the API, in the app's language) as chips over a text
// box that starts with the one picked (the last pick is remembered on this device, edits are not);
// 分享 (the share sheet on phones: the message, then the link on its own line), 複製文案 (the same,
// to the clipboard) and 複製連結; and 重設連結 behind a confirmation that the old link stops
// working. Nothing focuses the text box from script, and the app-wide focus release lets go of it
// when the page loses focus (lib/viewport.ts installFocusRelease), so the tab bar never strands
// over a kept keyboard inset (DESIGN.md 9.5).

import { useEffect, useState } from 'react';
import type { InviteTemplateKey, MyInviteDTO } from '../../../shared/types';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { confirmDialog } from '../../components/Dialog';
import { PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { Skeleton } from '../../components/Spinner';
import { TextField } from '../../components/TextField';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { copyText, shareMessage, shareOrCopy } from '../../lib/share';
import { actions, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { ErrorLine, Slip } from '../auth/Receipt';
import { InvitePass } from '../groups/InviteCard';
import pass from '../groups/InviteCard.module.css';
import { lastTemplate, rememberTemplate } from './inviteFlow';
import s from './InviteFriends.module.css';

const TEXT_MAX = 1000;

/** The last answer per session and language, so coming back (or going offline) shows the link at once. */
const answers = new Map<string, MyInviteDTO>();

export function InviteFriendsPage() {
  const { t, locale } = useT();
  const session = useStore(st => st.token);
  const myName = useStore(st => st.me?.user.name ?? '');
  const online = useStore(st => st.online);
  const key = session ? session + ':' + locale : null;
  const [invite, setInvite] = useState<MyInviteDTO | null>(() => (key ? answers.get(key) ?? null : null));
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pick, setPick] = useState<InviteTemplateKey>(() => lastTemplate() ?? 'everyday');
  /** What the box says once edited; null: the picked message as written (it follows the language). */
  const [edited, setEdited] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    const kept = answers.get(key);
    if (kept) setInvite(kept);
    actions.myInvite(locale).then(
      r => {
        if (!alive) return;
        answers.set(key, r);
        setInvite(r);
        setLoadError(null);
      },
      e => {
        if (alive) setLoadError(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
      },
    );
    return () => {
      alive = false;
    };
  }, [key, attempt]);

  const template = invite?.templates.find(x => x.key === pick) ?? invite?.templates[0];
  const text = edited ?? template?.text ?? '';

  function choose(k: InviteTemplateKey) {
    setPick(k);
    setEdited(null);
    rememberTemplate(k);
  }

  async function share() {
    if (!invite) return;
    // Straight from the tap: browsers allow the share sheet only right after a user action.
    const r = await shareOrCopy({ title: t('一起用吉諾分帳所分帳', "Split costs with me on Gino's Split Lab"), text, url: invite.url });
    if (r === 'failed') showToast({ message: t('無法分享，請改用複製', 'Could not share. Use Copy instead'), kind: 'error' });
  }

  async function copyMessage() {
    if (!invite) return;
    const ok = await copyText(shareMessage({ text, url: invite.url }));
    showToast(
      ok
        ? { message: t('已複製文案和連結', 'Message and link copied'), kind: 'success' }
        : { message: t('無法複製，請長按文字選取', 'Could not copy. Press and hold the text to select it'), kind: 'error' },
    );
  }

  async function copyLink() {
    if (!invite) return;
    const ok = await copyText(invite.url);
    showToast(
      ok
        ? { message: t('已複製邀請連結', 'Invite link copied'), kind: 'success' }
        : { message: t('無法複製，請長按連結選取', 'Could not copy. Press and hold the link to select it'), kind: 'error' },
    );
  }

  async function reset() {
    const yes = await confirmDialog({
      title: t('重設邀請連結？', 'Reset your invite link?'),
      message: t(
        '舊的連結和 QR code 會立刻失效，還沒加入的人要用新的連結。已經是朋友的人不受影響。',
        'The old link and QR code stop working right away; anyone who has not joined needs the new one. Friends you already have are not affected.',
      ),
      confirmLabel: t('重設連結', 'Reset link'),
      danger: true,
    });
    if (!yes || !session) return;
    setResetting(true);
    try {
      const r = await actions.resetMyInvite(locale);
      // The other language's answer holds the old code.
      for (const k of [...answers.keys()]) if (k.startsWith(session + ':')) answers.delete(k);
      if (key) answers.set(key, r);
      setInvite(r);
      showToast({ message: t('已重設邀請連結，舊的連結已經失效', 'Your invite link was reset. The old one no longer works.'), kind: 'success' });
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error' });
    } finally {
      setResetting(false);
    }
  }

  const header = <PageHeader title={t('邀請朋友', 'Invite friends')} back="/friends" />;

  if (!invite) {
    return (
      <div className={s.page}>
        {header}
        {loadError ? (
          <Slip>
            <ErrorLine>{errorMessage(loadError)}</ErrorLine>
            <div className={s.gap} />
            <Button variant="secondary" icon="sync" onClick={() => setAttempt(a => a + 1)}>
              {t('再試一次', 'Try again')}
            </Button>
          </Slip>
        ) : (
          <div className={s.skel} aria-busy="true" aria-label={t('載入中', 'Loading')}>
            <Skeleton height={176} radius={22} />
            <Skeleton height={44} width="70%" />
            <Skeleton height={120} radius={16} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={s.page}>
      {header}

      <div className={s.block}>
        <div className={pass.card}>
          <InvitePass
            head={myName ? t('{name} 的朋友邀請', 'Friend invite from {name}', { name: myName }) : t('朋友邀請', 'Friend invite')}
            lead={t('傳這個連結給朋友，或讓他們掃 QR code', 'Send this link to friends, or let them scan the QR code')}
            note={t('打開後登入，你們就是朋友了', 'They open it and sign in, and you are friends')}
            link={invite.url}
            qrLabel={t('邀請朋友連結的 QR code', 'QR code for your invite link')}
            linkTestId="invite-link"
          />
        </div>
      </div>

      <Section title={t('邀請文案', 'Message')}>
        <div className={s.chips} role="group" aria-label={t('文案範本', 'Message templates')}>
          {invite.templates.map(x => (
            <Chip key={x.key} label={x.label} selected={x.key === template?.key} onClick={() => choose(x.key)} data-testid={'invite-template-' + x.key} />
          ))}
        </div>
        <TextField
          bare
          multiline
          rows={5}
          label={t('要傳的話', 'What to send')}
          value={text}
          onChange={setEdited}
          maxLength={TEXT_MAX}
          hint={t('分享時，連結會接在文案的下一行', 'The link goes on its own line after it')}
          data-testid="invite-text"
        />
      </Section>

      <div className={s.actions}>
        <Button variant="primary" size="lg" block icon="share" onClick={() => void share()} data-testid="invite-share">
          {t('分享', 'Share')}
        </Button>
        <div className={s.pair}>
          <Button variant="secondary" icon="copy" onClick={() => void copyMessage()} data-testid="invite-copy-text">
            {t('複製文案', 'Copy message')}
          </Button>
          <Button variant="secondary" icon="link" onClick={() => void copyLink()} data-testid="invite-copy-link">
            {t('複製連結', 'Copy link')}
          </Button>
        </div>
        <button type="button" className={pass.reset} onClick={() => void reset()} disabled={resetting || !online} data-testid="invite-reset">
          {resetting ? t('重設中…', 'Resetting…') : t('重設連結', 'Reset link')}
        </button>
      </div>
    </div>
  );
}
