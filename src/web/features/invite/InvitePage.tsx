// #/i/<code>, a friend invite link (docs/SPEC.md sections 4 and 8.3), where
// https://<site>/i/<code> lands (index.html). Works signed out: the inviter's face and
// 「Gino 邀請你一起分帳」 on a sky card. Signed out, 加為朋友 opens 用 Email 加入 (auth/EmailSheet.tsx,
// which asks for a name when the address has no account yet), and 使用 Google 帳戶登入 and
// 已有帳號？登入 leave and come back here; either way the sign-in makes the two friends (opening
// the link and signing in is the yes: inviteFlow.ts markAccept). Signed in: one 加為朋友, then the
// 1:1 ledger opens. Already friends: the ledger is one tap away. Your own link says so and points to
// 邀請朋友. A link that does not work (unknown, or reset since) says so kindly. The inviter's
// placeholders in their own groups are never guessed at: the per-member claim link covers those.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { InviteInfoDTO } from '../../../shared/types';
import { peekReturn, rememberReturn, takeReturn } from '../../App';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { PageHeader, Wordmark } from '../../components/PageHeader';
import { Skeleton } from '../../components/Spinner';
import { ApiError } from '../../lib/api';
import { zhJoin, zhThen } from '../../lib/describe';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { actions, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { offerInstallOnce } from '../account/InstallCard';
import { EmailSheet } from '../auth/EmailSheet';
import { SignInButtons } from '../auth/SignInButtons';
import { InAppHint } from '../auth/InAppHint';
import { BarePage, Dash, ErrorLine, LinkRow, Links, Note, Slip } from '../auth/Receipt';
import { openGroup } from '../auth/session';
import { inviteAvatarUrl, markAccept, takeAccept } from './inviteFlow';
import s from '../join/Join.module.css';

type Load =
  | { state: 'loading' }
  | { state: 'ready'; info: InviteInfoDTO }
  | { state: 'invalid' }
  | { state: 'error'; message: string };

export function InvitePage({ code }: { code: string }) {
  const { t } = useT();
  const signedIn = useStore(st => !!st.token);
  const myName = useStore(st => st.me?.user.name ?? '');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Signed out: the account comes first (用 Email 加入). */
  const [askEmail, setAskEmail] = useState(false);
  const sending = useRef(false);
  const titleId = useId();
  const path = '/i/' + encodeURIComponent(code);

  // Who sent it, again after a sign-in: the answer then says whether it is mine, or we are friends.
  useEffect(() => {
    let alive = true;
    setLoad(l => (l.state === 'ready' ? l : { state: 'loading' }));
    actions.inviteInfo(code).then(
      info => {
        if (alive) setLoad({ state: 'ready', info });
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
  }, [code, attempt, signedIn]);

  // Signed out: a sign-in from here (Google, 登入, or the email sheet) comes back here and makes
  // the two friends.
  useEffect(() => {
    if (signedIn) return;
    markAccept(code);
    rememberReturn(path);
  }, [signedIn, code, path]);

  // Back here signed in from a sign-in this page started: accept at once (once per mark; the
  // sending ref keeps the email sheet's own accept from making it twice).
  useEffect(() => {
    if (signedIn && takeAccept(code)) void accept();
  }, [signedIn, code]);

  async function accept() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await actions.acceptInvite(code);
      // The page this tab would come back to after a sign-in was this one: done with it.
      if (peekReturn() === path) takeReturn();
      const name = load.state === 'ready' ? load.info.inviter.name : '';
      showToast({
        message: r.existed
          ? t('你們已經是朋友了', 'You are already friends')
          : name
            ? t(zhThen('你和', zhJoin(name, '現在是朋友了')), 'You and {name} are friends now', { name })
            : t('你們現在是朋友了', "You're friends now"),
        kind: 'success',
      });
      openGroup(r.groupId);
      offerInstallOnce();
    } catch (err) {
      sending.current = false;
      setBusy(false);
      if (err instanceof ApiError && err.code === 'code_invalid') setLoad({ state: 'invalid' });
      else if (err instanceof ApiError && err.code === 'own_invite') setAttempt(a => a + 1);
      else if (err instanceof ApiError && err.code === 'rate_limited' && (err.details as { scope?: unknown } | undefined)?.scope === 'links') {
        setError(t('今天加的朋友太多了，明天再試。', 'You have added too many friends today. Try again tomorrow.'));
      } else setError(errorMessage(err));
    }
  }

  /** Signed in from the sheet: the accept it was opened for goes on. */
  function signedInForAccept() {
    setAskEmail(false);
    takeAccept(code);
    void accept();
  }

  const band = (
    <PageHeader large title={<Wordmark />} actions={signedIn ? <IconButton icon="close" label={t('回到總覽', 'Back to Home')} href="/" /> : undefined} />
  );

  if (load.state === 'loading') {
    return (
      <BarePage band={band}>
        <Slip tint="water" aria-busy="true" aria-label={t('載入中', 'Loading')}>
          <div className={s.groupHead}>
            <Skeleton height={64} width={64} radius={32} />
            <div className={s.groupText}>
              <Skeleton height={22} width="80%" />
            </div>
          </div>
        </Slip>
      </BarePage>
    );
  }

  if (load.state === 'invalid' || load.state === 'error') {
    return (
      <BarePage band={band}>
        <Slip>
          <h1 className={s.slipTitle} data-testid={load.state === 'invalid' ? 'invite-invalid' : 'invite-error'}>
            {load.state === 'invalid' ? t('這個邀請連結已經失效', 'This invite link no longer works') : t('打不開邀請', 'Could not open the invite')}
          </h1>
          <p className={s.slipText}>
            {load.state === 'invalid'
              ? t('邀請你的朋友可能已經重設了連結，請向對方要一個新的。', 'Your friend may have reset their invite link. Ask them for a new one.')
              : load.message}
          </p>
          {load.state === 'error' && (
            <Button variant="secondary" icon="sync" className={s.slipAction} onClick={() => setAttempt(a => a + 1)}>
              {t('再試一次', 'Try again')}
            </Button>
          )}
        </Slip>
        <Links>
          <LinkRow to={signedIn ? '/' : '/welcome'}>{signedIn ? t('回到總覽', 'Back to Home') : t('用 Email 開始使用吉諾分帳所', "Start Gino's Split Lab with your email")}</LinkRow>
        </Links>
      </BarePage>
    );
  }

  const { info } = load;
  const inv = info.inviter;
  const face = <Avatar name={inv.name} color={inv.color} photoUrl={inv.avatar ? inviteAvatarUrl(code, inv.avatar) : null} size={64} />;
  const mine = signedIn && info.self;
  const friends = signedIn && !info.self && info.groupId;

  let title: string;
  let note: string;
  if (mine) {
    title = t('這是你自己的邀請連結', 'This is your own invite link');
    note = t('把它傳給朋友：他們打開、登入後，你們就是朋友了。', 'Send it to friends: once they open it and sign in, you are friends.');
  } else if (friends) {
    title = t(zhThen('你和', zhJoin(inv.name, '已經是朋友了')), 'You and {name} are already friends', { name: inv.name });
    note = t('你們的兩人帳本已經在了，打開就能一起記帳。', 'Your ledger for the two of you is already there.');
  } else {
    title = t(zhJoin(inv.name, '邀請你一起分帳'), '{name} invited you to split costs together', { name: inv.name });
    note = t('加為朋友後，你們會有一本兩個人的帳本：一起記帳，算好誰該付誰。', 'Once you are friends, you get a ledger for the two of you: log costs together and see who owes whom.');
  }

  let footer: ReactNode;
  if (mine) {
    footer = (
      <Button variant="primary" size="lg" block icon="share" onClick={() => navigate('/invite-friends', { replace: true })} data-testid="invite-self-open">
        {t('邀請朋友', 'Invite friends')}
      </Button>
    );
  } else if (friends) {
    footer = (
      <Button variant="primary" size="lg" block onClick={() => openGroup(info.groupId!)} data-testid="invite-open-ledger">
        {t('打開你們的帳本', 'Open your ledger')}
      </Button>
    );
  } else {
    footer = (
      <>
        {error && <ErrorLine>{error}</ErrorLine>}
        {!signedIn && <SignInButtons />}
        <Button
          variant="primary"
          size="lg"
          block
          loading={busy}
          onClick={() => (signedIn ? void accept() : setAskEmail(true))}
          data-testid="invite-accept"
        >
          {t('加為朋友', 'Add as a friend')}
        </Button>
        {!signedIn ? (
          <p className={s.fine}>{t('會先寄驗證碼到你的 Email，換手機也找得回這個帳號', 'We email you a code first, so a new phone finds your account again.')}</p>
        ) : myName ? (
          <p className={s.fine}>{t('會用「{name}」這個帳號加入', 'You join with your account, {name}.', { name: myName })}</p>
        ) : null}
      </>
    );
  }

  return (
    <BarePage band={band} footer={footer}>
      <Slip tint="water" aria-labelledby={titleId} data-testid="invite-card" data-state={mine ? 'self' : friends ? 'friends' : signedIn ? 'ready' : 'signed-out'}>
        <div className={s.groupHead}>
          {face}
          <div className={s.groupText}>
            {!mine && <p className={s.kicker}>{t('朋友邀請', 'Friend invite')}</p>}
            <h1 id={titleId} className={s.groupName} data-testid="invite-title">{title}</h1>
          </div>
        </div>
        <Dash />
        <Note>{note}</Note>
      </Slip>

      {!signedIn && <InAppHint className={s.block} />}

      {!signedIn && (
        <Links>
          <LinkRow to="/login" data-testid="invite-login">{t('已有帳號？登入', 'Have an account? Sign in')}</LinkRow>
        </Links>
      )}

      <EmailSheet open={askEmail} onClose={() => setAskEmail(false)} name="" onSignedIn={signedInForAccept} />
    </BarePage>
  );
}
