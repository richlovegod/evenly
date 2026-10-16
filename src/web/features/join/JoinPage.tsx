// #/join/<code>, the invite link. Works signed out: shows the group (a sky card) and its members
// (an outlined card), and you pick the name that is you (or 我不在名單上 and type one). Signed
// out, the pick creates a device-only account inline; signed in, it joins directly. Already in
// the group: the group opens.

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { currencyName } from '../../../shared/currencies';
import type { JoinInfoDTO } from '../../../shared/types';
import { rememberReturn } from '../../App';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { GroupAvatar } from '../../components/GroupAvatar';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { ListRow } from '../../components/ListRow';
import { PageHeader, Wordmark } from '../../components/PageHeader';
import { Skeleton } from '../../components/Spinner';
import { TextField } from '../../components/TextField';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { href } from '../../lib/router';
import { actions, useStore } from '../../lib/store';
import { offerInstallOnce } from '../account/InstallCard';
import { InAppHint } from '../auth/InAppHint';
import { BarePage, Card, cx, Dash, ErrorLine, Lead, LinkRow, Links, Note, Slip, Tag } from '../auth/Receipt';
import { ensureAccount, openGroup } from '../auth/session';
import s from './Join.module.css';

type Load =
  | { state: 'loading' }
  | { state: 'ready'; info: JoinInfoDTO }
  | { state: 'missing' }
  | { state: 'error'; message: string };

/** The "我不在名單上" choice. */
const NEW = 'new';
const NAME_MAX = 60;

/** Arrow keys move the choice inside the radio group (one tab stop for the whole list). */
function onRadioKeys(e: KeyboardEvent<HTMLDivElement>, ids: string[], current: string | null, choose: (id: string) => void) {
  const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
  const backward = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
  if ((!forward && !backward) || !ids.length) return;
  e.preventDefault();
  const i = current ? ids.indexOf(current) : -1;
  const next = i < 0 ? 0 : (i + (forward ? 1 : -1) + ids.length) % ids.length;
  choose(ids[next]);
  e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
}

function Radio({ on }: { on: boolean }) {
  return (
    <span className={cx(s.radio, on && s.radioOn)} aria-hidden="true">
      {on ? <Icon name="check" size={15} strokeWidth={3} /> : null}
    </span>
  );
}

export function JoinPage({ code }: { code: string }) {
  const { t, locale } = useT();
  const signedIn = useStore(st => !!st.token);
  const myName = useStore(st => st.me?.user.name ?? '');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [pick, setPick] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [explain, setExplain] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const titleId = useId();
  const formId = useId();

  useEffect(() => {
    let alive = true;
    setLoad({ state: 'loading' });
    actions.joinInfo(code).then(
      info => {
        if (!alive) return;
        if (info.myMemberId) openGroup(info.group.id);
        else setLoad({ state: 'ready', info });
      },
      err => {
        if (!alive) return;
        if (err instanceof ApiError && (err.code === 'not_found' || err.code === 'code_invalid')) setLoad({ state: 'missing' });
        else setLoad({ state: 'error', message: errorMessage(err) });
      },
    );
    return () => {
      alive = false;
    };
  }, [code, attempt]);

  /** Fetch the member list again without blanking the page (after someone else claimed a name). */
  function refreshQuietly() {
    actions.joinInfo(code).then(
      info => {
        if (info.myMemberId) openGroup(info.group.id);
        else setLoad({ state: 'ready', info });
      },
      () => undefined,
    );
  }

  function choose(id: string) {
    setPick(id);
    setError(null);
    setExplain(null);
    if (id === NEW && !newName) setNewName(myName);
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (sending.current || load.state !== 'ready') return;
    const member = pick && pick !== NEW ? load.info.members.find(m => m.id === pick) : undefined;
    const name = pick === NEW ? newName.trim() : member?.name ?? '';
    if (!pick || (pick !== NEW && !member)) {
      setError(t('先選你是哪一位', 'Pick who you are first'));
      return;
    }
    if (!name) {
      setError(t('請輸入你的名字', 'Enter your name'));
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await ensureAccount(name);
      const r = await actions.join(code, member ? { memberId: member.id } : { name });
      openGroup(r.groupId);
      offerInstallOnce();
    } catch (err) {
      sending.current = false;
      setBusy(false);
      if (err instanceof ApiError && err.code === 'member_claimed') {
        setError(t('「{name}」剛剛被別人認領了，請選另一位，或選「我不在名單上」', '{name} was just claimed by someone else. Pick another name, or choose "I am not on the list".', { name }));
        setPick(null);
        refreshQuietly();
      } else if (err instanceof ApiError && err.code === 'not_found') {
        setLoad({ state: 'missing' });
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
        <Slip tint="water" aria-busy="true" aria-label={t('載入中', 'Loading')}>
          <div className={s.groupHead}>
            <Skeleton height={50} width={48} />
            <div className={s.groupText}>
              <Skeleton height={14} width="40%" />
              <div className={s.gap} />
              <Skeleton height={22} width="75%" />
            </div>
          </div>
        </Slip>
        <div className={s.pad}>
          <Skeleton height={60} />
          <div className={s.gap} />
          <Skeleton height={60} />
        </div>
      </BarePage>
    );
  }

  if (load.state === 'missing' || load.state === 'error') {
    return (
      <BarePage band={band}>
        <Slip>
          <h1 className={s.slipTitle}>{load.state === 'missing' ? t('找不到這個邀請', 'This invite does not work') : t('打不開邀請', 'Could not open the invite')}</h1>
          <p className={s.slipText}>
            {load.state === 'missing'
              ? t('邀請連結可能已經被群組管理員重設了。請向朋友要一個新的連結。', 'A group admin may have reset the invite link. Ask a friend for a new one.')
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
  const g = info.group;
  const open = info.members.filter(m => !m.claimed);
  const taken = info.members.filter(m => m.claimed);
  const radioIds = [...open.map(m => m.id), NEW];
  const picked = pick && pick !== NEW ? open.find(m => m.id === pick) : undefined;
  const tabStop = pick && radioIds.includes(pick) ? pick : radioIds[0];

  const footer = (
    <>
      {error && <ErrorLine>{error}</ErrorLine>}
      {picked && <p className={s.picked}>{t('你是「{name}」', 'You are {name}', { name: picked.name })}</p>}
      <Button type="submit" form={formId} variant="primary" size="lg" block loading={busy} data-testid="join-submit">
        {t('加入群組', 'Join the group')}
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
      <Slip tint="water" aria-labelledby={titleId}>
        <div className={s.groupHead}>
          <GroupAvatar emoji={g.emoji} color={g.color} name={g.name} currency={g.currency} size={48} />
          <div className={s.groupText}>
            <p className={s.kicker}>{t('邀請你加入', 'You are invited to')}</p>
            <h1 id={titleId} className={s.groupName}>{g.name}</h1>
          </div>
        </div>
        <Dash />
        <Lead label={t('幣別', 'Currency')}>
          <span className={s.code}>{g.currency}</span> {currencyName(g.currency, locale)}
        </Lead>
        <Lead label={t('成員', 'Members')}>{t('{n} 人', '{n}', { n: g.memberCount })}</Lead>
        <Note>{t('選出你是誰，之前記在你名下的帳就會接上', 'Pick who you are, and everything already logged under your name is yours.')}</Note>
      </Slip>

      <InAppHint className={s.block} />

      <form id={formId} onSubmit={submit} noValidate>
        <Card
          title={t('你是哪一位？', 'Which one is you?')}
          action={
            signedIn ? undefined : (
              <a href={href('/login')} onClick={() => rememberReturn('/join/' + encodeURIComponent(code))}>
                {t('已有帳號？登入', 'Sign in')}
              </a>
            )
          }
        >
          <div role="radiogroup" aria-label={t('你是哪一位？', 'Which one is you?')} onKeyDown={e => onRadioKeys(e, radioIds, pick, choose)}>
            {open.map(m => (
              <ListRow
                key={m.id}
                role="radio"
                aria-checked={pick === m.id}
                tabIndex={tabStop === m.id ? 0 : -1}
                onClick={() => choose(m.id)}
                className={pick === m.id ? s.choiceOn : undefined}
                leading={<Avatar name={m.name} color={m.color} size={40} />}
                title={m.name}
                trailing={<Radio on={pick === m.id} />}
                data-testid="join-member"
                data-id={m.id}
              />
            ))}
            <ListRow
              role="radio"
              aria-checked={pick === NEW}
              tabIndex={tabStop === NEW ? 0 : -1}
              onClick={() => choose(NEW)}
              className={pick === NEW ? s.choiceOn : undefined}
              leading={<span className={s.plus} aria-hidden="true"><Icon name="userPlus" size={20} /></span>}
              title={t('我不在名單上', 'I am not on the list')}
              trailing={<Radio on={pick === NEW} />}
              data-testid="join-not-listed"
            />
          </div>

          {pick === NEW && (
            <TextField
              className={s.newName}
              label={t('你的名字', 'Your name')}
              value={newName}
              onChange={v => {
                setNewName(v);
                setError(null);
              }}
              placeholder={t('名字或暱稱', 'Name or nickname')}
              autoComplete="nickname"
              enterKeyHint="go"
              maxLength={NAME_MAX}
              autoFocus
              hint={t('群組裡的人會看到這個名字', 'People in the group see this name')}
              data-testid="join-new-name"
            />
          )}
        </Card>

        {taken.length > 0 && (
          <Card title={t('已經加入的人', 'Already joined')}>
            <ul>
              {taken.map(m => {
                const noteId = `${titleId}-${m.id}`;
                const shown = explain === m.id;
                return (
                  <li key={m.id}>
                    <ListRow
                      onClick={() => setExplain(x => (x === m.id ? null : m.id))}
                      aria-expanded={shown}
                      aria-controls={noteId}
                      leading={<Avatar name={m.name} color={m.color} size={40} />}
                      title={m.name}
                      trailing={
                        <Tag tint="water">
                          <Icon name="check" size={13} strokeWidth={3} />
                          {t('已加入', 'Joined')}
                        </Tag>
                      }
                      data-testid="join-member"
                      data-id={m.id}
                      data-claimed="true"
                    />
                    {shown && (
                      <p id={noteId} className={s.explain}>
                        {t(
                          '這位已經有人認領了。如果這就是你，但你換了手機或清除了瀏覽器資料，請群組管理員在設定裡幫你產生專屬登入連結。',
                          'Someone already claimed this name. If it is you and you changed phones or cleared your browser data, ask a group admin to make you a personal sign-in link in the group settings.',
                        )}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </form>
    </BarePage>
  );
}
