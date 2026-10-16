// 成員 in group settings: everyone in the group with where they stand, then per person (in a
// sheet): rename, color, a personal claim link for someone added by name, 幫他重新登入 for a
// friend whose phone was lost or whose Safari data was cleared (admins), make or remove admin,
// unlink the account, and remove (only at a zero balance). People who left are listed apart.
// Also exports the claim-link panel the add-friend page uses.

import { useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { netBalances } from '../../../shared/balances';
import { AVATAR_COLORS } from '../../../shared/colors';
import type { GroupSnapshotDTO, MemberDTO } from '../../../shared/types';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { confirmDialog, promptDialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { MoneyStatus } from '../../components/Money';
import { Sheet } from '../../components/Sheet';
import { shareLink } from '../../config';
import { ApiError } from '../../lib/api';
import { orderedMembers } from '../../lib/describe';
import { errorMessage } from '../../lib/errors';
import { copyText, shareOrCopy } from '../../lib/share';
import { actions, useStore, type GroupView } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { cx } from './cx';
import { usableEntries } from './groupMath';
import { radioKeys, splitNames, useNamedT } from './NewGroupPage';
import s from './MembersEditor.module.css';

// ---------- claim links ----------

export interface MadeLink {
  url: string;
  expiresAt: string;
}

/** Days left on a link, at least 1. */
function daysLeft(expiresAt: string): number {
  const ms = Date.parse(expiresAt) - Date.now();
  return Number.isFinite(ms) ? Math.max(1, Math.round(ms / 86400000)) : 7;
}

/** A personal link that has been made: the link itself, what it does, copy and share. */
export function LinkResult({ link, memberName, groupName }: { link: MadeLink; memberName: string; groupName: string }) {
  const { t } = useNamedT();
  const text = t(
    '{name}，這是你在「{group}」的 Evenly 專屬連結。點開就能用自己的手機記帳、看自己的帳：',
    '{name}, here is your own Evenly link for {group}. Open it to add expenses and see your balance on your phone:',
    { name: memberName, group: groupName },
  );
  async function copy() {
    const ok = await copyText(link.url);
    showToast(
      ok
        ? { message: t('已複製連結', 'Link copied'), kind: 'success' }
        : { message: t('無法複製，請長按連結選取', 'Could not copy. Press and hold the link to select it'), kind: 'error' },
    );
  }
  async function share() {
    const r = await shareOrCopy({ title: t('Evenly 專屬連結', 'Your Evenly link'), text, url: link.url });
    if (r === 'failed') showToast({ message: t('無法分享，請改用複製', 'Could not share. Use Copy instead'), kind: 'error' });
  }
  return (
    <div className={s.link}>
      <p className={s.linkUrl} data-testid="claim-link-url">{link.url}</p>
      <p className={s.linkNote}>
        {t('打開這個連結的人會成為「{name}」。只能用一次，{days} 天內有效。', 'Whoever opens this link becomes {name} in this group. It works once, within {days} days.', {
          name: memberName,
          days: daysLeft(link.expiresAt),
        })}
      </p>
      <div className={s.linkActions}>
        <Button variant="secondary" icon="copy" onClick={() => void copy()}>
          {t('複製', 'Copy')}
        </Button>
        <Button variant="secondary" icon="share" onClick={() => void share()}>
          {t('分享', 'Share')}
        </Button>
      </div>
    </div>
  );
}

/** 產生專屬連結 for a member added by name (also used right after adding a friend). */
export function ClaimLinkPanel({ gid, memberId, memberName, groupName }: { gid: string; memberId: string; memberName: string; groupName: string }) {
  const { t } = useNamedT();
  const [link, setLink] = useState<MadeLink | null>(null);
  const [busy, setBusy] = useState(false);
  async function make() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await actions.claimLink(gid, memberId);
      setLink({ url: shareLink('/claim/' + r.token), expiresAt: r.expiresAt });
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }
  if (link) return <LinkResult link={link} memberName={memberName} groupName={groupName} />;
  return (
    <Button variant="secondary" icon="link" loading={busy} onClick={() => void make()} data-testid="member-claim-link">
      {t('產生專屬連結', 'Make a personal link')}
    </Button>
  );
}

// ---------- the list ----------

function memberNets(snap: GroupSnapshotDTO): Record<string, number> {
  const base = snap.group.currency;
  try {
    return netBalances(usableEntries(snap.expenses, base), base, snap.members.map(m => m.id));
  } catch {
    return {};
  }
}

function sameName(a: string, b: string): boolean {
  return a.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() === b.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function MembersEditor({ gid, view }: { gid: string; view: GroupView }) {
  const { t } = useNamedT();
  const online = useStore(st => st.online);
  const snap = view.snap;
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const nets = useMemo(() => (snap ? memberNets(snap) : {}), [snap]);

  if (!snap) return null;
  const meId = snap.me.memberId;
  const cur = snap.group.currency;
  const active = orderedMembers(snap.members, meId);
  const left = snap.members.filter(m => !m.active);
  const open = openId ? snap.members.find(m => m.id === openId) ?? null : null;

  async function add() {
    const names = splitNames(draft);
    if (names.length === 0 || adding || !snap) return;
    setAdding(true);
    setAddError(null);
    let added = 0;
    try {
      for (const name of names) {
        if (snap.members.some(m => m.active && sameName(m.name, name))) continue;
        await actions.addMember(gid, { name });
        added++;
      }
      setDraft('');
      if (added > 0) {
        showToast({
          message: added === 1 ? t('已加入 {name}', 'Added {name}', { name: names[0] }) : t('已加入 {n} 人', 'Added {n} people', { n: added }),
          kind: 'success',
        });
      } else {
        setAddError(t('他們已經在群組裡了', 'They are already in the group'));
      }
    } catch (e) {
      setAddError(e instanceof ApiError && e.code === 'already_member' ? t('這個人已經在群組裡了', 'That person is already in the group') : errorMessage(e));
    } finally {
      setAdding(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void add();
  }

  const statusOf = (m: MemberDTO): string => {
    const parts: string[] = [];
    if (m.role === 'admin' && m.userId) parts.push(t('管理員', 'Admin'));
    parts.push(m.userId ? t('已加入', 'Joined') : t('還沒加入', 'Not joined yet'));
    return parts.join(t('，', ', '));
  };

  return (
    <div className={s.editor}>
      <ul className={s.list} role="list">
        {active.map(m => (
          <li key={m.id} className={s.item}>
            <button type="button" className={s.row} onClick={() => setOpenId(m.id)} aria-haspopup="dialog" data-testid="member-row" data-id={m.id}>
              <Avatar name={m.name} color={m.color} size={40} ring={m.id === meId} />
              <span className={s.main}>
                <span className={s.name}>
                  <span className={s.nameText}>{m.name}</span>
                  {m.id === meId ? <span className={s.you}>{t('你', 'you')}</span> : null}
                </span>
                <span className={s.sub}>{statusOf(m)}</span>
              </span>
              <MoneyStatus amount={nets[m.id] ?? 0} currency={cur} kind={m.id === meId ? 'groupMine' : 'member'} size="md" stamp={false} className={s.bal} />
              <Icon name="chevronRight" size={18} className={s.chev} />
            </button>
          </li>
        ))}
      </ul>

      <div className={s.addRow}>
        <input
          className={s.addInput}
          value={draft}
          onChange={e => {
            setDraft(e.target.value);
            if (addError) setAddError(null);
          }}
          onKeyDown={onKey}
          placeholder={t('用名字新增成員', 'Add someone by name')}
          aria-label={t('新增成員的名字', 'Name of a member to add')}
          autoComplete="off"
          autoCapitalize="words"
          enterKeyHint="done"
          disabled={adding}
          data-testid="settings-member-add-input"
        />
        <Button variant="secondary" icon="plus" onClick={() => void add()} loading={adding} disabled={!online} data-testid="settings-member-add">
          {t('加入', 'Add')}
        </Button>
      </div>
      {addError ? (
        <p className={s.error} role="alert">
          <Icon name="warning" size={16} />
          {addError}
        </p>
      ) : null}
      <p className={s.hint}>
        {t(
          '用名字加入的人馬上就能一起分帳。等他們打開邀請連結或專屬連結，就能用自己的手機記帳。',
          'People added by name can be on expenses right away. Once they open the invite link or their personal link, they can add expenses on their own phone.',
        )}
      </p>

      {left.length > 0 ? (
        <details className={s.left}>
          <summary className={s.leftSummary}>
            <Icon name="chevronDown" size={16} className={s.leftChev} />
            {t('已離開的成員（{n}）', 'People who left ({n})', { n: left.length })}
          </summary>
          <ul className={s.list} role="list">
            {left.map(m => (
              <li key={m.id} className={s.item}>
                <div className={cx(s.row, s.rowStatic)} data-testid="member-row" data-id={m.id}>
                  <Avatar name={m.name} color={m.color} size={40} />
                  <span className={s.main}>
                    <span className={s.name}>
                      <span className={s.nameText}>{m.name}</span>
                    </span>
                    <span className={s.sub}>{t('已離開，舊的費用還是會顯示', 'Left; old expenses still show them')}</span>
                  </span>
                  <MoneyStatus amount={nets[m.id] ?? 0} currency={cur} kind="member" size="md" stamp={false} className={s.bal} />
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <MemberSheet gid={gid} snap={snap} member={open} net={open ? nets[open.id] ?? 0 : 0} onClose={() => setOpenId(null)} />
    </div>
  );
}

// ---------- one member ----------

function MemberSheet({ gid, snap, member, net, onClose }: { gid: string; snap: GroupSnapshotDTO; member: MemberDTO | null; net: number; onClose: () => void }) {
  const { t, money } = useNamedT();
  const online = useStore(st => st.online);
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<{ memberId: string; link: MadeLink } | null>(null);

  const meId = snap.me.memberId;
  const iAmAdmin = snap.me.role === 'admin';
  const cur = snap.group.currency;
  const m = member;
  const isMe = !!m && m.id === meId;
  const shownLink = m && link && link.memberId === m.id ? link.link : null;

  async function run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (busy) return undefined;
    setBusy(key);
    try {
      return await fn();
    } catch (e) {
      showToast({ message: errorMessage(e), kind: 'error', duration: 6000 });
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function makeLink(mid: string) {
    const r = await actions.claimLink(gid, mid);
    setLink({ memberId: mid, link: { url: shareLink('/claim/' + r.token), expiresAt: r.expiresAt } });
  }

  async function rename() {
    if (!m) return;
    const v = await promptDialog({
      title: t('改名', 'Rename'),
      label: t('名字', 'Name'),
      initial: m.name,
      confirmLabel: t('儲存', 'Save'),
    });
    const name = v === null ? '' : Array.from(v.replace(/\s+/g, ' ').trim()).slice(0, 60).join('');
    if (!name || name === m.name) return;
    const done = await run('rename', () => actions.updateMember(gid, m.id, { name }));
    if (done) showToast({ message: t('已改名為 {name}', 'Renamed to {name}', { name }), kind: 'success' });
  }

  async function setColor(color: string) {
    if (!m || color.toUpperCase() === m.color.toUpperCase()) return;
    await run('color', () => actions.updateMember(gid, m.id, { color }));
  }

  async function setRole(role: 'admin' | 'member') {
    if (!m) return;
    const ok = await run('role', () => actions.updateMember(gid, m.id, { role }));
    if (ok) {
      showToast({
        message:
          role === 'admin'
            ? t('{name} 現在是管理員', '{name} is now an admin', { name: m.name })
            : t('{name} 不再是管理員', '{name} is no longer an admin', { name: m.name }),
        kind: 'success',
      });
    }
  }

  async function relink() {
    if (!m) return;
    const yes = await confirmDialog({
      title: t('幫 {name} 重新登入？', 'Help {name} sign in again?', { name: m.name }),
      message: t(
        '換了手機或 Safari 清掉資料時用。會先解除 {name} 現在的帳號連結（帳目都會保留），再產生一個新的專屬連結。把連結傳給 {name}，打開就能接回原本的帳。',
        "For a new phone or cleared Safari data. This unlinks {name}'s current account (every entry stays) and makes a new personal link. Send it to {name}; opening it brings everything back.",
        { name: m.name },
      ),
      confirmLabel: t('產生新連結', 'Make a new link'),
    });
    if (!yes) return;
    const mid = m.id;
    await run('relink', async () => {
      await actions.unlinkMember(gid, mid);
      await makeLink(mid);
    });
  }

  async function unlink() {
    if (!m) return;
    const yes = await confirmDialog({
      title: t('解除 {name} 的帳號連結？', "Unlink {name}'s account?", { name: m.name }),
      message: t(
        '{name} 會變回只有名字的成員，帳目都會保留。之後可以用專屬連結或邀請連結重新認領。',
        '{name} goes back to being a name only; every entry stays. They can claim it again with a personal link or the invite link.',
        { name: m.name },
      ),
      confirmLabel: t('解除連結', 'Unlink'),
      danger: true,
    });
    if (!yes) return;
    const done = await run('unlink', () => actions.unlinkMember(gid, m.id).then(() => true));
    if (done) showToast({ message: t('已解除 {name} 的帳號連結', 'Unlinked {name}', { name: m.name }), kind: 'success' });
  }

  async function remove() {
    if (!m) return;
    if (net !== 0) {
      showToast({
        message: t('{name} 還有 {amount} 沒結清，要先結清才能移除', '{name} still has {amount} to settle. Settle up first', {
          name: m.name,
          amount: money(Math.abs(net), cur),
        }),
        kind: 'error',
        duration: 6000,
      });
      return;
    }
    const yes = await confirmDialog({
      title: t('把 {name} 移出群組？', 'Remove {name} from the group?', { name: m.name }),
      message: t('{name} 的舊費用會保留，之後新增費用時不會再出現。', 'Old expenses with {name} stay; {name} no longer shows up for new ones.', { name: m.name }),
      confirmLabel: t('移除', 'Remove'),
      danger: true,
    });
    if (!yes) return;
    const name = m.name;
    const done = await run('remove', () => actions.removeMember(gid, m.id).then(() => true));
    if (done) {
      onClose();
      showToast({ message: t('已移除 {name}', 'Removed {name}', { name }), kind: 'success' });
    }
  }

  const colors = m && !AVATAR_COLORS.some(c => c.toUpperCase() === m.color.toUpperCase()) ? [...AVATAR_COLORS, m.color] : AVATAR_COLORS;
  const currentColor = m ? colors.find(c => c.toUpperCase() === m.color.toUpperCase()) ?? colors[0] : colors[0];

  return (
    <Sheet open={!!m} onClose={onClose} title={m ? m.name : ''}>
      {m ? (
        <div className={s.sheet}>
          <div className={s.head}>
            <Avatar name={m.name} color={m.color} size={48} ring={isMe} />
            <div className={s.headMain}>
              <p className={s.headStatus}>
                {isMe
                  ? t('你', 'You')
                  : m.userId
                    ? t('已用自己的帳號加入', 'Joined with their own account')
                    : t('用名字加入，還沒有人認領', 'Added by name, not claimed yet')}
                {m.role === 'admin' && m.userId ? t('，管理員', ', admin') : ''}
              </p>
              <MoneyStatus amount={net} currency={cur} kind={isMe ? 'groupMine' : 'member'} size="md" align="start" stamp={false} />
            </div>
          </div>

          <div className={s.panel}>
            <button type="button" className={s.prow} onClick={() => void rename()} disabled={!!busy || !online}>
              <span className={s.prowK}>{t('名字', 'Name')}</span>
              <span className={s.prowV}>{m.name}</span>
              <Icon name="edit" size={18} className={s.chev} />
            </button>
            <div className={s.colorRow}>
              <span className={s.prowK} id={'member-color-' + m.id}>{t('顏色', 'Color')}</span>
              <div
                className={s.swatches}
                role="radiogroup"
                aria-labelledby={'member-color-' + m.id}
                onKeyDown={e => {
                  if (!busy) radioKeys(e, colors, currentColor, c => void setColor(c));
                }}
              >
                {colors.map((c, i) => {
                  const on = c === currentColor;
                  return (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={t('顏色 {n}', 'Color {n}', { n: i + 1 })}
                      tabIndex={on ? 0 : -1}
                      className={cx(s.swatch, on && s.swatchOn)}
                      style={{ '--swatch': c } as CSSProperties}
                      disabled={!!busy || !online}
                      onClick={() => void setColor(c)}
                    >
                      <span className={s.swatchChip} aria-hidden="true">
                        {on ? <Icon name="check" size={14} strokeWidth={2.4} /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {!m.userId && m.active ? (
            <div className={cx(s.block, s.blockSky)}>
              <h3 className={s.blockTitle}>{t('專屬連結', 'Personal link')}</h3>
              <p className={s.explain}>
                {t(
                  '傳專屬連結給 {name}，打開就會變成這位成員，可以用自己的手機記帳、看自己的帳。',
                  'Send {name} a personal link. Opening it makes them this member, so they can add expenses and see their balance on their own phone.',
                  { name: m.name },
                )}
              </p>
              {shownLink ? (
                <LinkResult link={shownLink} memberName={m.name} groupName={snap.group.name} />
              ) : (
                <Button
                  variant="secondary"
                  icon="link"
                  loading={busy === 'link'}
                  disabled={!online}
                  onClick={() => void run('link', () => makeLink(m.id))}
                  data-testid="member-claim-link"
                >
                  {t('產生專屬連結', 'Make a personal link')}
                </Button>
              )}
            </div>
          ) : null}

          {m.userId && !isMe && iAmAdmin ? (
            <div className={s.block}>
              <h3 className={s.blockTitle}>{t('換手機或登不進來', 'New phone or signed out')}</h3>
              <p className={s.explain}>
                {t(
                  '{name} 換了手機，或 Safari 清掉了資料而登不進來？產生一個新的專屬連結讓他接回原本的帳，帳目都會保留。',
                  'Did {name} get a new phone, or did Safari clear their data? Make a new personal link to bring their account back. Every entry stays.',
                  { name: m.name },
                )}
              </p>
              <div className={s.actions}>
                <Button variant="secondary" icon="device" loading={busy === 'relink'} disabled={!online} onClick={() => void relink()}>
                  {t('幫他重新登入', 'Help them sign in again')}
                </Button>
                <Button variant="ghost" disabled={!!busy || !online} onClick={() => void unlink()}>
                  {t('只解除帳號連結', 'Only unlink the account')}
                </Button>
              </div>
            </div>
          ) : null}

          {iAmAdmin && m.userId && m.active ? (
            <div className={s.block}>
              <h3 className={s.blockTitle}>{t('管理員', 'Admin')}</h3>
              <p className={s.explain}>
                {t('管理員可以移除成員、解除帳號連結、重設邀請連結和刪除群組。', 'Admins can remove members, unlink accounts, reset the invite link and delete the group.')}
              </p>
              {m.role === 'admin' ? (
                <Button variant="secondary" icon="user" loading={busy === 'role'} disabled={!online} onClick={() => void setRole('member')}>
                  {isMe ? t('不再當管理員', 'Stop being an admin') : t('取消管理員', 'Remove as admin')}
                </Button>
              ) : (
                <Button variant="secondary" icon="star" loading={busy === 'role'} disabled={!online} onClick={() => void setRole('admin')}>
                  {t('設為管理員', 'Make admin')}
                </Button>
              )}
            </div>
          ) : null}

          {iAmAdmin && !isMe && m.active ? (
            <div className={cx(s.block, s.blockDanger)}>
              <Button variant="danger-quiet" icon="trash" loading={busy === 'remove'} disabled={!online} onClick={() => void remove()} block>
                {t('從群組移除', 'Remove from group')}
              </Button>
              {net !== 0 ? (
                <p className={s.explain}>
                  {t('要先結清（{amount}）才能移除', 'Settle up first ({amount}) to remove them', { amount: money(Math.abs(net), cur) })}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
