// #/claim/<token>: a one-time link made for one person in a group ("你被邀請以「Abbie」的身分加入").
// Accepting creates an account inline when signed out (name prefilled), claims the member and
// opens the group.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ClaimInfoDTO } from '../../../shared/types';
import { rememberReturn } from '../../App';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { GroupAvatar } from '../../components/GroupAvatar';
import { IconButton } from '../../components/IconButton';
import { PageHeader, Wordmark } from '../../components/PageHeader';
import { Skeleton } from '../../components/Spinner';
import { TextField } from '../../components/TextField';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { offerInstallOnce } from '../account/InstallCard';
import { InAppHint } from '../auth/InAppHint';
import { BarePage, clockTime, Dash, ErrorLine, LinkRow, Links, localDay, Note, Slip } from '../auth/Receipt';
import { ensureAccount, openGroup } from '../auth/session';
import s from './Join.module.css';

type Load =
  | { state: 'loading' }
  | { state: 'ready'; info: ClaimInfoDTO }
  | { state: 'invalid' }
  | { state: 'error'; message: string };

const NAME_MAX = 60;

/** The groupId the server sends with already_member, if any. */
function existingGroup(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== 'already_member') return null;
  const d = err.details as { groupId?: unknown } | undefined;
  return d && typeof d.groupId === 'string' ? d.groupId : null;
}

export function ClaimPage({ token }: { token: string }) {
  const { t, zh, date, time } = useT();
  const signedIn = useStore(st => !!st.token);
  const myName = useStore(st => st.me?.user.name ?? '');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const titleId = useId();
  const formId = useId();

  useEffect(() => {
    let alive = true;
    setLoad({ state: 'loading' });
    actions.claimInfo(token).then(
      info => {
        if (!alive) return;
        setLoad({ state: 'ready', info });
        setName(n => n || info.member.name);
      },
      err => {
        if (!alive) return;
        if (err instanceof ApiError && (err.code === 'code_invalid' || err.code === 'not_found')) setLoad({ state: 'invalid' });
        else setLoad({ state: 'error', message: errorMessage(err) });
      },
    );
    return () => {
      alive = false;
    };
  }, [token, attempt]);

  async function accept(e?: FormEvent) {
    e?.preventDefault();
    if (sending.current || load.state !== 'ready') return;
    const n = name.trim();
    if (!signedIn && !n) {
      setError(t('請輸入你的名字', 'Enter your name'));
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await ensureAccount(n);
      const r = await actions.claim(token);
      openGroup(r.groupId);
      offerInstallOnce();
    } catch (err) {
      sending.current = false;
      setBusy(false);
      const gid = existingGroup(err);
      if (gid) {
        showToast({ message: t('你已經在這個群組裡了', 'You are already in this group') });
        openGroup(gid);
      } else if (err instanceof ApiError && err.code === 'code_invalid') {
        setLoad({ state: 'invalid' });
      } else if (err instanceof ApiError && err.code === 'member_claimed') {
        setError(t('這位成員已經有人認領了。如果那不是你，請向群組裡的朋友要新的連結。', 'Someone already claimed this member. If that was not you, ask a friend in the group for a new link.'));
      } else {
        setError(errorMessage(err));
      }
    }
  }

  const band = (
    <PageHeader large title={<Wordmark />} actions={signedIn ? <IconButton icon="close" label={t('回到總覽', 'Back to Home')} href="/" /> : undefined} />
  );

  if (load.state === 'loading') {
    return (
      <BarePage band={band}>
        <Slip aria-busy="true" aria-label={t('載入中', 'Loading')}>
          <Skeleton height={50} width={48} />
          <div className={s.gap} />
          <Skeleton height={22} width="85%" />
        </Slip>
      </BarePage>
    );
  }

  if (load.state === 'invalid' || load.state === 'error') {
    return (
      <BarePage band={band}>
        <Slip>
          <h1 className={s.slipTitle}>{load.state === 'invalid' ? t('這個連結已經失效', 'This link no longer works') : t('打不開這個連結', 'Could not open this link')}</h1>
          <p className={s.slipText}>
            {load.state === 'invalid'
              ? t('專屬連結 7 天內有效，而且只能用一次。請向群組裡的朋友要一個新的。', 'Personal links work for 7 days, once. Ask a friend in the group for a new one.')
              : load.message}
          </p>
          {load.state === 'error' && (
            <Button variant="secondary" icon="sync" className={s.slipAction} onClick={() => setAttempt(a => a + 1)}>
              {t('再試一次', 'Try again')}
            </Button>
          )}
        </Slip>
        <Links>
          <LinkRow to={signedIn ? '/' : '/welcome'}>{signedIn ? t('回到總覽', 'Back to Home') : t('只用名字開始使用 Evenly', 'Start Evenly with just a name')}</LinkRow>
        </Links>
      </BarePage>
    );
  }

  const { info } = load;

  const footer = (
    <>
      {error && <ErrorLine>{error}</ErrorLine>}
      <Button type="submit" form={formId} variant="primary" size="lg" block loading={busy} data-testid="claim-accept">
        {t('接受，加入群組', 'Accept and join')}
      </Button>
      {!signedIn ? (
        <p className={s.fine}>{t('不用 Email 或密碼，會在這台裝置建立帳號', 'No email or password: this makes an account on this device.')}</p>
      ) : myName ? (
        <p className={s.fine}>{t('會用「{name}」這個帳號加入', 'You join with your account, {name}.', { name: myName })}</p>
      ) : null}
    </>
  );

  return (
    <BarePage band={band} footer={footer}>
      <Slip aria-labelledby={titleId}>
        <div className={s.groupHead}>
          <GroupAvatar emoji={info.group.emoji} color={info.group.color} name={info.group.name} size={48} />
          <h1 id={titleId} className={s.invite}>
            {t('你被邀請以「{member}」的身分加入「{group}」', 'You are invited to join {group} as {member}', { member: info.member.name, group: info.group.name })}
          </h1>
        </div>
        <Dash />
        <div className={s.as}>
          <Avatar name={info.member.name} color={info.member.color} size={40} />
          <div className={s.asText}>
            <p className={s.kicker}>{t('你在群組裡的名字', 'Your name in the group')}</p>
            <p className={s.asName}>{info.member.name}</p>
          </div>
        </div>
        <Note>
          {t('這個連結 {day} {time} 前有效，只能用一次。之前記在「{member}」名下的帳都會是你的。', 'This link works until {day}, {time}, once. Everything logged under {member} becomes yours.', {
            day: date(localDay(info.expiresAt), 'md'),
            time: clockTime(info.expiresAt, zh, time),
            member: info.member.name,
          })}
        </Note>
      </Slip>

      <InAppHint className={s.block} />

      <form id={formId} className={s.claimForm} onSubmit={accept} noValidate>
        {!signedIn && (
          <TextField
            label={t('你的名字', 'Your name')}
            value={name}
            onChange={v => {
              setName(v);
              setError(null);
            }}
            autoComplete="nickname"
            enterKeyHint="go"
            maxLength={NAME_MAX}
            hint={t('這是你帳號的名字，之後可以改', 'The name on your account. You can change it later.')}
            data-testid="claim-name"
          />
        )}
        {!signedIn && (
          <Links>
            <LinkRow to="/login" onClick={() => rememberReturn('/claim/' + encodeURIComponent(token))}>
              {t('已有帳號？先登入', 'Have an account? Sign in first')}
            </LinkRow>
          </Links>
        )}
      </form>
    </BarePage>
  );
}
