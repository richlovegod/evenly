// 新增朋友, full screen: a name and, optionally, an email. With the email of an existing Evenly
// account the two of you are linked right away; otherwise the friend is a name in a 1:1 ledger,
// and a personal link lets them take it over from their own phone. Then add an expense
// together or open the friend.

import { useState, type FormEvent } from 'react';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { TextField } from '../../components/TextField';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { navigate } from '../../lib/router';
import { actions, useStore } from '../../lib/store';
import { ClaimLinkPanel } from '../groups/MembersEditor';
import { useNamedT } from '../groups/NewGroupPage';
import { Slip } from '../groups/Slip';
import s from './AddFriendPage.module.css';

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const NAME_ID = 'addfriend-name-input';
const EMAIL_ID = 'addfriend-email-input';

export function AddFriendPage() {
  const { t } = useNamedT();
  const me = useStore(st => st.me);
  const online = useStore(st => st.online);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ gid: string; existed: boolean } | null>(null);
  const snap = useStore(st => (done ? st.groups[done.gid]?.snap ?? null : null));

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    const n = Array.from(name.replace(/\s+/g, ' ').trim()).slice(0, 60).join('');
    const mail = email.trim().toLowerCase();
    let bad = false;
    if (!n) {
      setNameError(t('請輸入名字', 'Enter a name'));
      bad = true;
    }
    if (mail && !EMAIL_RE.test(mail)) {
      setEmailError(t('這個 Email 看起來不太對', 'That email does not look right'));
      bad = true;
    } else if (mail && me?.user.email && mail === me.user.email.toLowerCase()) {
      setEmailError(t('這是你自己的 Email', 'That is your own email'));
      bad = true;
    }
    if (bad) {
      document.getElementById(!n ? NAME_ID : EMAIL_ID)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const before = new Set((me?.groups ?? []).map(g => g.id));
    try {
      const gid = await actions.addFriend(mail ? { name: n, email: mail } : { name: n });
      setDone({ gid, existed: before.has(gid) });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_request' && mail) setEmailError(t('這是你自己的 Email', 'That is your own email'));
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const other = snap?.members.find(m => m.id !== snap.me.memberId && m.active) ?? null;
    const friendName = other?.name ?? name.trim();
    const key = other ? (other.userId ? 'u:' + other.userId : 'm:' + other.id) : null;
    return (
      <div className={s.page}>
        <PageHeader title={t('新增朋友', 'Add friend')} back="/friends" />
        <div className={s.body}>
          <Slip label={t('新增的朋友', 'The new friend')}>
            <div className={s.doneHead} aria-live="polite">
              {other ? <Avatar name={other.name} color={other.color} size={48} /> : null}
              <div className={s.doneText}>
                <h2 className={s.doneTitle}>
                  {done.existed ? t('你們已經是朋友了', 'You are already friends') : t('已新增 {name}', '{name} was added', { name: friendName })}
                </h2>
                <p className={s.doneSub}>
                  {other?.userId
                    ? t('{name} 已經有吉諾分帳所的帳號，已經連結好了，你們看到的帳會一樣', "{name} already has a Gino's Split Lab account and is linked, so you both see the same balance", { name: friendName })
                    : t('現在可以記你們兩個人的帳了', 'You can now keep track of what the two of you share')}
                </p>
              </div>
            </div>
          </Slip>

          {other && !other.userId && snap ? (
            <Section title={t('讓 {name} 用自己的手機看帳', 'Let {name} see it on their own phone', { name: friendName })}>
              <div className={s.claim}>
                <p className={s.claimText}>
                  {t(
                    '產生一個專屬連結傳給 {name}，打開就能加入你們的帳，不用找邀請碼。',
                    'Make a personal link and send it to {name}. Opening it joins your shared ledger, no code needed.',
                    { name: friendName },
                  )}
                </p>
                <ClaimLinkPanel gid={done.gid} memberId={other.id} memberName={friendName} groupName={snap.group.name} />
              </div>
            </Section>
          ) : null}

          <div className={s.bar}>
            <Button variant="primary" size="lg" block icon="plus" onClick={() => navigate('/g/' + encodeURIComponent(done.gid) + '/add', { replace: true })}>
              {t('新增費用', 'Add expense')}
            </Button>
            <Button
              variant="secondary"
              block
              onClick={() => navigate(key ? '/f/' + encodeURIComponent(key) : '/g/' + encodeURIComponent(done.gid), { replace: true })}
            >
              {t('查看 {name}', 'Open {name}', { name: friendName })}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.page}>
      <PageHeader title={t('新增朋友', 'Add friend')} back="/friends" />
      <form
        className={s.body}
        onSubmit={submit}
        noValidate
        onKeyDown={e => {
          // Return in the name box moves on to the email box instead of submitting.
          const el = e.target as HTMLElement;
          if (e.key === 'Enter' && el.id === NAME_ID) e.preventDefault();
        }}
      >
        <Slip label={t('新朋友', 'New friend')}>
          <div className={s.fields}>
            <TextField
              label={t('名字', 'Name')}
              value={name}
              onChange={v => {
                setName(v);
                if (nameError) setNameError(undefined);
              }}
              placeholder={t('例如 Abbie', 'e.g. Abbie')}
              maxLength={60}
              autoFocus
              autoComplete="off"
              autoCapitalize="words"
              enterKeyHint="next"
              error={nameError}
              id={NAME_ID}
              onEnter={() => document.getElementById(EMAIL_ID)?.focus()}
              bare
              data-testid="addfriend-name"
            />
            <TextField
              label={t('Email（可以不填）', 'Email (optional)')}
              value={email}
              onChange={v => {
                setEmail(v);
                if (emailError) setEmailError(undefined);
              }}
              type="email"
              inputMode="email"
              autoComplete="off"
              autoCapitalize="none"
              enterKeyHint="done"
              spellCheck={false}
              placeholder="abbie@example.com"
              error={emailError}
              hint={t('如果對方已經用這個 Email 註冊吉諾分帳所，會直接連結到對方的帳號。不會寄任何信。', "If they already have a Gino's Split Lab account with this email, they are linked right away. No email is sent.")}
              id={EMAIL_ID}
              bare
              data-testid="addfriend-email"
            />
          </div>
        </Slip>
        <p className={s.intro}>
          {t(
            '不在同一個群組也能分帳，例如兩個人的午餐、幫對方代墊的東西。',
            'Split with one person without a group: lunch for two, or something you paid for them.',
          )}
        </p>
        <div className={s.bar}>
          {error ? (
            <p className={s.error} role="alert">
              <Icon name="warning" size={16} />
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" block loading={busy} disabled={!online && !busy} data-testid="addfriend-submit">
            {t('新增朋友', 'Add friend')}
          </Button>
        </div>
      </form>
    </div>
  );
}
