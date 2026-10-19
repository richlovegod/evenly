// 建立群組, full screen: the top card holds the cover and the name you are writing; below it the type,
// who is in it (one-tap suggestions from people I already split with, or "copy members from" an
// earlier group), the currency, the cover (emoji and color) and 簡化債務. Creating opens the
// group and offers the invite link right away.
//
// Also exports the type and cover pickers the group settings tab reuses.

import { useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react';
import { GROUP_COLORS, colorFor, nextColor } from '../../../shared/colors';
import { currencyName } from '../../../shared/currencies';
import type { GroupListItemDTO, GroupType } from '../../../shared/types';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { CurrencyPicker } from '../../components/CurrencyPicker';
import { GroupAvatar } from '../../components/GroupAvatar';
import { Icon, type IconName } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { Section } from '../../components/Section';
import { Switch } from '../../components/Switch';
import { TextField } from '../../components/TextField';
import { errorMessage } from '../../lib/errors';
import { useT, type I18n, type Params } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { actions, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { cx } from './cx';
import { Slip } from './Slip';
import s from './NewGroupPage.module.css';

// ---------- shared with the settings tab ----------

/** Group types people pick (pair groups are made from Friends only). */
export type PickableGroupType = Exclude<GroupType, 'pair'>;

export const GROUP_TYPE_OPTIONS: readonly { value: PickableGroupType; zh: string; en: string; icon: IconName }[] = [
  { value: 'trip', zh: '旅行', en: 'Trip', icon: 'luggage' },
  { value: 'home', zh: '居家', en: 'Home', icon: 'home' },
  { value: 'couple', zh: '情侶', en: 'Couple', icon: 'heart' },
  { value: 'other', zh: '其他', en: 'Other', icon: 'sparkle' },
];

/** The cover a new group gets until the name suggests one or someone picks one. */
export const DEFAULT_EMOJI: Readonly<Record<PickableGroupType, string>> = {
  trip: '✈️',
  home: '🏠',
  couple: '❤️',
  other: '✨',
};

/** 24 covers for trips and homes; the cover draws most of them as line art. Anything else can be typed. */
export const GROUP_EMOJIS: readonly string[] = [
  '✈️', '⛷️', '🏔️', '🏝️', '🏖️', '⛺', '🌲', '🏙️',
  '🗼', '🏯', '🗺️', '🧳', '🚗', '🚆', '🍜', '🍻',
  '☕', '🎉', '🏠', '🛋️', '🛒', '🐱', '❤️', '✨',
];

/** A cover guessed from the group name (DESIGN.md 6.3), so a ski trip and a beach trip differ. */
export function guessEmoji(name: string): string | null {
  const n = name.toLowerCase();
  if (/滑雪|雪|ski|snow|niseko|whistler|hakuba|二世谷|白馬/.test(n)) return '⛷️';
  if (/露營|camp/.test(n)) return '⛺';
  if (/海|島|beach|沖繩|okinawa|bali|峇里|墾丁|island/.test(n)) return '🏝️';
  if (/爬山|登山|hike|hiking|trek/.test(n)) return '🏔️';
  if (/家|home|房|室友|roommate|apartment|公寓/.test(n)) return '🏠';
  return null;
}

/** Emoji field limit, in characters as the server counts them (code points). */
export const EMOJI_MAX = 16;

export function clipEmoji(raw: string): string {
  return Array.from(raw.trim()).slice(0, EMOJI_MAX).join('');
}

/** Names typed or pasted as a list ("Abbie, Kevin、Leo" or one per line), trimmed, 60 characters at most. */
export function splitNames(raw: string): string[] {
  return raw
    .split(/[,，、;；\n\r\t]+/)
    .map(n => Array.from(n.replace(/\s+/g, ' ').trim()).slice(0, 60).join('').trim())
    .filter(Boolean);
}

function normName(n: string): string {
  return n.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Kana, CJK ideographs, Hangul, and CJK and full-width punctuation. */
const CJK_RE = new RegExp('[\\u3000-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af\\uff00-\\uffef]');
const isCJK = (ch: string | undefined): boolean => !!ch && CJK_RE.test(ch);

/**
 * The spaces a Chinese template puts around a placeholder ('已加入 {name}', '{name} 現在是管理員')
 * stay next to Latin letters and digits and go between two Chinese characters (DESIGN.md 13.2):
 * 「已加入 Abbie」, 「已加入佳穎」. Only template spaces change; the values are left as typed.
 */
export function zhSpaced(zh: string, params?: Params): string {
  if (!params) return zh;
  const re = /\{(\w+)\}/g;
  let out = '';
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(zh))) {
    if (!(m[1] in params)) continue;
    const value = String(params[m[1]]);
    let before = zh.slice(at, m.index);
    const prev = before.length > 1 ? before[before.length - 2] : out[out.length - 1];
    if (before.endsWith(' ') && isCJK(prev) && isCJK(value[0])) before = before.slice(0, -1);
    out += before + m[0];
    at = m.index + m[0].length;
    if (zh[at] === ' ' && isCJK(value[value.length - 1]) && isCJK(zh[at + 1])) at++;
  }
  return out + zh.slice(at);
}

/** useT() whose t() applies zhSpaced, for strings that hold people's or groups' names. */
export function useNamedT(): I18n {
  const i18n = useT();
  return useMemo(() => ({ ...i18n, t: (zh: string, en: string, params?: Params) => i18n.t(zhSpaced(zh, params), en, params) }), [i18n]);
}

/** Arrow keys move through a radio group and select as they go (the ARIA radio pattern). */
export function radioKeys<T>(e: KeyboardEvent<HTMLElement>, values: readonly T[], current: T, pick: (v: T) => void): void {
  const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  let i = values.indexOf(current);
  if (e.key in keys) i = (Math.max(i, 0) + keys[e.key] + values.length) % values.length;
  else if (e.key === 'Home') i = 0;
  else if (e.key === 'End') i = values.length - 1;
  else return;
  e.preventDefault();
  pick(values[i]);
  const group = e.currentTarget;
  requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
}

/** 旅行 / 居家 / 情侶 / 其他, one radio group with icons. */
export function GroupTypePicker({
  value,
  onChange,
  testIdPrefix,
  disabled = false,
  labelId,
}: {
  value: PickableGroupType;
  onChange: (v: PickableGroupType) => void;
  testIdPrefix?: string;
  disabled?: boolean;
  labelId?: string;
}) {
  const { t } = useT();
  const values = GROUP_TYPE_OPTIONS.map(o => o.value);
  return (
    <div
      className={s.types}
      role="radiogroup"
      aria-labelledby={labelId}
      aria-label={labelId ? undefined : t('群組類型', 'Group type')}
      onKeyDown={e => {
        if (!disabled) radioKeys(e, values, value, onChange);
      }}
    >
      {GROUP_TYPE_OPTIONS.map(o => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            className={cx(s.type, on && s.typeOn)}
            onClick={() => onChange(o.value)}
            data-testid={testIdPrefix ? `${testIdPrefix}-${o.value}` : undefined}
          >
            <Icon name={o.icon} size={24} strokeWidth={2.2} />
            <span className={s.typeLabel}>{t(o.zh, o.en)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The cover: 24 emoji, a field for any other emoji, and the group color. */
export function CoverPicker({
  emoji,
  color,
  onEmoji,
  onColor,
  disabled = false,
}: {
  emoji: string;
  color: string;
  onEmoji: (v: string) => void;
  onColor: (v: string) => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  const [custom, setCustom] = useState(() => (emoji && !GROUP_EMOJIS.includes(emoji) ? emoji : ''));
  const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
  // A color set some other way stays selectable.
  const colors = !color || GROUP_COLORS.some(c => same(c, color)) ? GROUP_COLORS : [...GROUP_COLORS, color];
  const currentColor = colors.find(c => same(c, color)) ?? colors[0];
  const inList = GROUP_EMOJIS.includes(emoji);
  return (
    <div className={s.cover}>
      <p className={s.coverLabel} id="cover-emoji-label">{t('圖示', 'Emoji')}</p>
      <div
        className={s.emojiGrid}
        role="radiogroup"
        aria-labelledby="cover-emoji-label"
        onKeyDown={e => {
          if (!disabled) radioKeys(e, GROUP_EMOJIS, inList ? emoji : GROUP_EMOJIS[0], v => {
            setCustom('');
            onEmoji(v);
          });
        }}
      >
        {GROUP_EMOJIS.map((em, i) => {
          const on = em === emoji;
          return (
            <button
              key={em}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={em}
              tabIndex={on || (!inList && i === 0) ? 0 : -1}
              disabled={disabled}
              className={cx(s.emoji, on && s.emojiOn)}
              onClick={() => {
                setCustom('');
                onEmoji(em);
              }}
            >
              <span aria-hidden="true">{em}</span>
            </button>
          );
        })}
      </div>
      <TextField
        label={t('或輸入任何 emoji', 'Or type any emoji')}
        value={custom}
        onChange={v => {
          const next = clipEmoji(v);
          setCustom(next);
          if (next) onEmoji(next);
        }}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        disabled={disabled}
        bare
        className={s.customEmoji}
      />
      <p className={s.coverLabel} id="cover-color-label">{t('顏色', 'Color')}</p>
      <div
        className={s.colors}
        role="radiogroup"
        aria-labelledby="cover-color-label"
        onKeyDown={e => {
          if (!disabled) radioKeys(e, colors, currentColor, onColor);
        }}
      >
        {colors.map((c, i) => {
          const on = same(c, currentColor);
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={t('顏色 {n}', 'Color {n}', { n: i + 1 })}
              tabIndex={on ? 0 : -1}
              disabled={disabled}
              className={cx(s.swatch, on && s.swatchOn)}
              style={{ '--swatch': c } as CSSProperties}
              onClick={() => onColor(c)}
            >
              <span className={s.swatchChip} aria-hidden="true">
                {on ? <Icon name="check" size={16} strokeWidth={2.4} /> : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- the page ----------

const MAX_OTHERS = 49;
const NAME_ID = 'newgroup-name-input';

/** English singular or plural template (Chinese needs none). */
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export function NewGroupPage() {
  const { t, locale } = useNamedT();
  const me = useStore(st => st.me);
  const [clientId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [type, setType] = useState<PickableGroupType>('trip');
  const [picked, setPicked] = useState<string | null>(null);
  const [color, setColor] = useState(() => colorFor(clientId));
  const [currency, setCurrency] = useState<string | null>(null);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [memberError, setMemberError] = useState<string | null>(null);
  const [showAllFriends, setShowAllFriends] = useState(false);
  const [simplify, setSimplify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const memberInput = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLDivElement>(null);

  const myName = me?.user.name ?? '';
  const cur = currency ?? me?.user.currency ?? 'TWD';
  const emoji = picked ?? guessEmoji(name) ?? DEFAULT_EMOJI[type];
  const taken = useMemo(() => new Set([normName(myName), ...members.map(normName)]), [myName, members]);

  // People I already split with, without me and without anyone already added.
  const friendSuggestions = useMemo(() => {
    const out: { key: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const f of me?.friends ?? []) {
      const k = normName(f.name);
      if (!k || seen.has(k) || taken.has(k)) continue;
      seen.add(k);
      out.push({ key: f.key, name: f.name });
    }
    return out;
  }, [me, taken]);

  // Earlier groups to copy the crew from (most recent first, 1:1 ledgers left out).
  const pastGroups = useMemo(() => {
    const list = (me?.groups ?? []).filter(g => g.type !== 'pair' && othersOf(g, me?.user.id).length > 0);
    return list.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)).slice(0, 8);
  }, [me]);

  const previewColors = useMemo(() => {
    const used: string[] = [me?.user.color ?? ''];
    return members.map(n => {
      const c = nextColor(used, n);
      used.push(c);
      return c;
    });
  }, [members, me]);

  function addNames(names: string[]): number {
    const next = [...members];
    const seen = new Set(taken);
    let added = 0;
    let skippedMe = false;
    for (const n of names) {
      const k = normName(n);
      if (k === normName(myName)) {
        skippedMe = true;
        continue;
      }
      if (seen.has(k)) continue;
      if (next.length >= MAX_OTHERS) {
        setMemberError(t('一個群組最多 50 人', 'A group can have at most 50 people'));
        break;
      }
      seen.add(k);
      next.push(n);
      added++;
    }
    if (skippedMe && added === 0) setMemberError(t('你已經在群組裡了', 'You are already in the group'));
    else if (added > 0) setMemberError(null);
    setMembers(next);
    return added;
  }

  function addDraft() {
    const names = splitNames(draft);
    if (names.length > 0) {
      addNames(names);
      setDraft('');
    }
    memberInput.current?.focus();
  }

  function onMemberKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    addDraft();
  }

  function removeMember(n: string) {
    setMembers(list => list.filter(x => x !== n));
    setMemberError(null);
  }

  function openCover() {
    setCoverOpen(true);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => coverRef.current?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' }));
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    const trimmed = name.replace(/\s+/g, ' ').trim();
    if (!trimmed) {
      setNameError(t('請輸入群組名稱', 'Enter a group name'));
      document.getElementById(NAME_ID)?.focus();
      return;
    }
    if (Array.from(trimmed).length > 80) {
      setNameError(t('群組名稱最多 80 個字', 'Use at most 80 characters'));
      document.getElementById(NAME_ID)?.focus();
      return;
    }
    // A name still in the box counts too (once, and never me).
    const seen = new Set(taken);
    const pending = splitNames(draft).filter(n => {
      const k = normName(n);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const all = [...members, ...pending].slice(0, MAX_OTHERS);
    setBusy(true);
    setError(null);
    try {
      const gid = await actions.createGroup({
        id: clientId,
        name: trimmed,
        type,
        currency: cur,
        emoji: clipEmoji(emoji),
        color,
        simplify,
        members: all.map(n => ({ name: n })),
      });
      navigate('/g/' + encodeURIComponent(gid), { replace: true });
      showToast({
        message: t('已建立「{name}」，傳邀請連結給大家', 'Created {name}. Send everyone the invite link', { name: trimmed }),
        kind: 'success',
        action: { label: t('邀請', 'Invite'), run: () => navigate('/g/' + encodeURIComponent(gid) + '/settings') },
        duration: 8000,
      });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const visibleFriends = showAllFriends ? friendSuggestions : friendSuggestions.slice(0, 10);
  const peopleCount = members.length + 1;

  return (
    <div className={s.page}>
      <PageHeader title={t('建立群組', 'New group')} back="/groups" />
      <form
        className={s.form}
        onSubmit={submit}
        noValidate
        onKeyDown={e => {
          // Return in a text box moves on instead of creating the group half filled in.
          const el = e.target as HTMLElement;
          if (e.key === 'Enter' && el.tagName === 'INPUT') e.preventDefault();
        }}
      >
        <Slip label={t('新的群組', 'The new group')}>
          <div className={s.slipRow}>
            <button type="button" className={s.ticketButton} onClick={openCover} aria-label={t('更換封面', 'Change the cover')}>
              <GroupAvatar emoji={emoji} color={color} name={name || t('群組', 'Group')} currency={cur} size={44} />
              <span className={s.ticketEdit} aria-hidden="true">
                <Icon name="edit" size={12} strokeWidth={2.4} />
              </span>
            </button>
            <TextField
              label={t('群組名稱', 'Group name')}
              value={name}
              onChange={v => {
                setName(v);
                if (nameError) setNameError(undefined);
              }}
              placeholder={t('例如：Niseko 滑雪 2026', 'e.g. Niseko ski trip 2026')}
              maxLength={80}
              autoFocus
              error={nameError}
              autoComplete="off"
              enterKeyHint="next"
              onEnter={() => memberInput.current?.focus()}
              id={NAME_ID}
              bare
              className={s.nameField}
              data-testid="newgroup-name"
            />
          </div>
          <p className={s.slipFoot}>
            {t('※ {cur}，{n} 人', plural(peopleCount, 'Note: {cur}, {n} person', 'Note: {cur}, {n} people'), { cur, n: peopleCount })}
          </p>
        </Slip>

        <Section title={<span id="newgroup-type-label">{t('類型', 'Type')}</span>}>
          <GroupTypePicker value={type} onChange={setType} testIdPrefix="newgroup-type" labelId="newgroup-type-label" />
        </Section>

        <Section title={t('成員', 'Members')} action={<span className={s.count}>{t('{n} 人', plural(peopleCount, '{n} person', '{n} people'), { n: peopleCount })}</span>}>
          <ul className={s.people} role="list">
            <li className={s.person}>
              <Avatar name={myName || t('你', 'You')} color={me?.user.color ?? GROUP_COLORS[0]} userId={me?.user.id} avatar={me?.user.avatar} size={36} ring />
              <span className={s.personName}>{t('你', 'You')}</span>
              <span className={s.personTag}>{t('管理員', 'Admin')}</span>
            </li>
            {members.map((n, i) => (
              <li key={n} className={s.person}>
                <Avatar name={n} color={previewColors[i] ?? colorFor(n)} size={36} />
                <span className={s.personName}>{n}</span>
                <button type="button" className={s.remove} onClick={() => removeMember(n)} aria-label={t('移除 {name}', 'Remove {name}', { name: n })}>
                  <Icon name="close" size={18} strokeWidth={2.2} />
                </button>
              </li>
            ))}
          </ul>
          <div className={s.addRow}>
            <input
              ref={memberInput}
              className={s.addInput}
              value={draft}
              onChange={e => {
                setDraft(e.target.value);
                if (memberError) setMemberError(null);
              }}
              onKeyDown={onMemberKey}
              placeholder={t('輸入名字，例如 Abbie', 'Name, e.g. Abbie')}
              aria-label={t('新增成員的名字', 'Name of a member to add')}
              aria-describedby="newgroup-members-hint"
              autoComplete="off"
              autoCapitalize="words"
              enterKeyHint="done"
              data-testid="newgroup-member-input"
            />
            <Button type="button" variant="secondary" icon="plus" onClick={addDraft} data-testid="newgroup-member-add">
              {t('加入', 'Add')}
            </Button>
          </div>
          {memberError ? (
            <p className={s.error} role="alert">
              <Icon name="warning" size={16} />
              {memberError}
            </p>
          ) : null}
          <p className={s.hint} id="newgroup-members-hint">
            {t(
              '先用名字加人就好。之後傳邀請連結，他們選自己的名字就能加入。',
              'Add people by name for now. Later, send the invite link and they pick their own name to join.',
            )}
          </p>

          {friendSuggestions.length > 0 ? (
            <div className={s.suggest}>
              <h3 className={s.suggestLabel}>{t('常一起分帳的人', 'People you split with')}</h3>
              <div className={s.chips}>
                {visibleFriends.map(f => (
                  <Chip key={f.key} icon="plus" label={<span className={s.chipText}>{f.name}</span>} onClick={() => addNames([f.name])} />
                ))}
                {friendSuggestions.length > visibleFriends.length ? (
                  <button type="button" className={s.more} onClick={() => setShowAllFriends(true)}>
                    {t('還有 {n} 人', '{n} more', { n: friendSuggestions.length - visibleFriends.length })}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {pastGroups.length > 0 ? (
            <div className={s.suggest}>
              <h3 className={s.suggestLabel}>{t('從之前的群組複製成員', 'Copy members from')}</h3>
              <div className={s.chips}>
                {pastGroups.map(g => {
                  const names = othersOf(g, me?.user.id);
                  const done = names.every(n => taken.has(normName(n)));
                  return (
                    <Chip
                      key={g.id}
                      selected={done}
                      icon={done ? 'check' : 'users'}
                      label={
                        <>
                          <span className={s.chipText}>{g.name}</span>
                          <span className={s.chipCount}>{t('（{n} 人）', ' ({n})', { n: names.length })}</span>
                        </>
                      }
                      onClick={() => {
                        const n = addNames(names);
                        if (n > 0) showToast({ message: t('已加入 {n} 人', plural(n, 'Added {n} person', 'Added {n} people'), { n }), kind: 'success', duration: 2500 });
                      }}
                    />
                  );
                })}
              </div>
            </div>
          ) : null}
        </Section>

        <Section title={t('幣別', 'Currency')}>
          <div className={cx(s.panel, s.panelSky)}>
            <button type="button" className={s.prow} onClick={() => setCurrencyOpen(true)} aria-haspopup="dialog" data-testid="newgroup-currency">
              <span className={s.prowK}>{t('群組幣別', 'Group currency')}</span>
              <span className={s.prowV}>
                <span className={s.code}>{cur}</span>
                <span className={s.prowName}>{currencyName(cur, locale)}</span>
              </span>
              <Icon name="chevronRight" size={18} className={s.chev} />
            </button>
          </div>
          <p className={s.hint}>
            {t(
              '每個人的結餘都用這個幣別計算。用其他幣別付的費用會自動換算，之後也能在設定裡改。',
              'Balances are kept in this currency. Expenses paid in other currencies are converted, and you can change it later in settings.',
            )}
          </p>
        </Section>

        <Section title={t('封面', 'Cover')}>
          <div ref={coverRef} className={s.coverCard}>
            <button
              type="button"
              className={s.disclose}
              onClick={() => setCoverOpen(v => !v)}
              aria-expanded={coverOpen}
              aria-controls="newgroup-cover"
            >
              <GroupAvatar emoji={emoji} color={color} name={name || t('群組', 'Group')} size={34} />
              <span className={s.discloseText}>
                {picked
                  ? t('你選的封面', 'Your cover')
                  : guessEmoji(name)
                    ? t('依名稱自動選的封面，可以換', 'Picked from the name; you can change it')
                    : t('依類型自動選的封面，可以換', 'Picked from the type; you can change it')}
              </span>
              <Icon name={coverOpen ? 'chevronUp' : 'chevronDown'} size={18} className={s.chev} />
            </button>
            <div id="newgroup-cover" hidden={!coverOpen} className={s.coverBody}>
              <CoverPicker emoji={emoji} color={color} onEmoji={setPicked} onColor={setColor} />
            </div>
          </div>
        </Section>

        <Section>
          <div className={s.panel}>
            <Switch
              checked={simplify}
              onChange={setSimplify}
              label={t('簡化債務', 'Simplify debts')}
              description={t('讓大家轉帳的次數最少，每個人該付的總額不變', 'Fewer transfers to settle up; nobody pays more in total')}
            />
          </div>
        </Section>

        <div className={s.bar}>
          {error ? (
            <p className={s.error} role="alert">
              <Icon name="warning" size={16} />
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" block loading={busy} data-testid="newgroup-submit">
            {t('建立群組', 'Create group')}
          </Button>
        </div>
      </form>

      <CurrencyPicker
        open={currencyOpen}
        onClose={() => setCurrencyOpen(false)}
        value={cur}
        onSelect={(code: string) => {
          setCurrency(code);
          setCurrencyOpen(false);
        }}
        highlight={recentCurrencies(me?.user.currency, me?.groups)}
      />
    </div>
  );
}

/** Active members of an earlier group other than me, by name. */
function othersOf(g: GroupListItemDTO, myUserId: string | undefined): string[] {
  return g.members.filter(m => m.active && m.id !== g.myMemberId && (!myUserId || m.userId !== myUserId)).map(m => m.name);
}

/** My home currency first, then the currencies of my groups, most recent first. */
function recentCurrencies(home: string | undefined, groups: readonly GroupListItemDTO[] | undefined): string[] {
  const out: string[] = [];
  if (home) out.push(home);
  const sorted = (groups ?? []).slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  for (const g of sorted) if (!out.includes(g.currency)) out.push(g.currency);
  return out.slice(0, 6);
}
