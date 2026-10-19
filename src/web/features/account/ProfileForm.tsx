// 個人資料 and 收款方式 (two cards): name, profile photo, avatar color, home currency, and how
// friends can pay you. One save for all of it but the photo, which is saved as soon as it is
// picked (PhotoField.tsx); the save bar (an outlined pill) sticks above the tab bar while
// something is unsaved.

import { useEffect, useId, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AVATAR_COLORS } from '../../../shared/colors';
import { currencyName } from '../../../shared/currencies';
import type { UpdateMeReq, UserDTO } from '../../../shared/types';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { CurrencyPicker } from '../../components/CurrencyPicker';
import { Icon } from '../../components/Icon';
import { TextField } from '../../components/TextField';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { actions, useStore } from '../../lib/store';
import { showToast } from '../../lib/toast';
import { Card, cx, ErrorLine } from '../auth/Receipt';
import { PhotoField } from './PhotoField';
import s from './Account.module.css';

interface Draft {
  name: string;
  color: string;
  currency: string;
  venmo: string;
  paypal: string;
  payInfo: string;
}

function fromUser(u: UserDTO): Draft {
  return { name: u.name, color: u.color, currency: u.currency, venmo: u.venmo, paypal: u.paypal, payInfo: u.payInfo };
}

const NAME_MAX = 60;
const PAYINFO_MAX = 300;
const HANDLE_RE = /^[A-Za-z0-9_.-]{0,50}$/;
const VENMO_LINK = /^(https?:\/\/)?(www\.|account\.)?venmo\.com\/(u\/)?/i;
const PAYPAL_LINK = /^(https?:\/\/)?(www\.)?paypal\.me\//i;

/** A pasted profile link or a leading "@" becomes the bare username (the server does the same). */
function cleanHandle(v: string, link: RegExp): string {
  return v.trim().replace(link, '').replace(/[/?#].*$/, '').replace(/^@+/, '');
}

/** Names for AVATAR_COLORS, in its order (src/shared/colors.ts). */
const COLOR_NAMES: [string, string][] = [
  ['藍', 'Blue'],
  ['橘', 'Orange'],
  ['綠', 'Green'],
  ['紫', 'Violet'],
  ['桃紅', 'Raspberry'],
  ['藍綠', 'Teal'],
  ['土黃', 'Ochre'],
  ['靛藍', 'Indigo'],
  ['紅', 'Red'],
  ['灰藍', 'Slate'],
];

/** The fields that differ from what the server has. */
function changes(d: Draft, base: Draft): UpdateMeReq {
  const req: UpdateMeReq = {};
  const name = d.name.trim();
  if (name !== base.name) req.name = name;
  if (d.color !== base.color) req.color = d.color;
  if (d.currency !== base.currency) req.currency = d.currency;
  if (d.venmo !== base.venmo) req.venmo = d.venmo;
  if (d.paypal !== base.paypal) req.paypal = d.paypal;
  const payInfo = d.payInfo.trim();
  if (payInfo !== base.payInfo) req.payInfo = payInfo;
  return req;
}

export function ProfileForm({ user }: { user: UserDTO }) {
  const { t, locale } = useT();
  const groups = useStore(st => st.me?.groups);
  const initial = useMemo(
    () => fromUser(user),
    // Only the fields this form edits: a language switch must not reset a half-typed name.
    [user.name, user.color, user.currency, user.venmo, user.paypal, user.payInfo],
  );
  const [draft, setDraft] = useState<Draft>(initial);
  const [base, setBase] = useState<Draft>(initial);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const colorLabel = useId();

  const diff = changes(draft, base);
  const dirty = Object.keys(diff).length > 0;

  // Take changes from the server (a save, another device) unless the person is mid-edit.
  useEffect(() => {
    if (!dirty) setDraft(initial);
    setBase(initial);
    // `dirty` is read from this render on purpose.
  }, [initial]);

  const highlight = useMemo(() => {
    const list = [user.currency];
    for (const g of groups ?? []) if (!list.includes(g.currency)) list.push(g.currency);
    return list;
  }, [groups, user.currency]);

  function set(patch: Partial<Draft>) {
    setDraft(d => ({ ...d, ...patch }));
    setError(null);
  }

  const nameError = draft.name.trim() ? undefined : t('請輸入名字', 'Enter a name');
  const handleError = t('只能用英文字母、數字和 _ . -，最多 50 個字', 'Use up to 50 letters, digits, _ . or -');
  const venmoError = HANDLE_RE.test(draft.venmo) ? undefined : handleError;
  const paypalError = HANDLE_RE.test(draft.paypal) ? undefined : handleError;
  const invalid = !!(nameError || venmoError || paypalError);

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (busy || !dirty || invalid) return;
    setBusy(true);
    setError(null);
    try {
      const u = await actions.updateMe(diff);
      const next = fromUser(u);
      setDraft(next);
      setBase(next);
      showToast({ message: t('已儲存', 'Saved'), kind: 'success' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function onSwatchKey(e: KeyboardEvent<HTMLDivElement>) {
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const backward = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    if (!forward && !backward) return;
    e.preventDefault();
    const n = AVATAR_COLORS.length;
    const i = Math.max(0, AVATAR_COLORS.indexOf(draft.color));
    const next = (i + (forward ? 1 : -1) + n) % n;
    set({ color: AVATAR_COLORS[next] });
    e.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  }

  const checkedIndex = AVATAR_COLORS.indexOf(draft.color);
  const shownName = draft.name.trim() || user.name;

  return (
    <>
      <form onSubmit={save} noValidate>
        <Card title={t('個人資料', 'Profile')}>
          <div className={s.fields}>
            <TextField
              label={t('名字', 'Name')}
              value={draft.name}
              onChange={v => set({ name: v })}
              autoComplete="nickname"
              maxLength={NAME_MAX}
              hint={t('朋友在群組裡看到的名字，還用舊名字的群組會一起改', 'The name friends see. Groups where you still use the old name update too.')}
              error={nameError}
              data-testid="account-name"
            />

            <PhotoField user={user} name={shownName} />

            <div className={s.field}>
              <p className={s.label} id={colorLabel}>{t('頭像顏色', 'Avatar color')}</p>
              <div role="radiogroup" aria-labelledby={colorLabel} className={s.swatches} onKeyDown={onSwatchKey}>
                {AVATAR_COLORS.map((c, i) => {
                  const on = draft.color === c;
                  const names = COLOR_NAMES[i];
                  return (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-label={names ? t(names[0], names[1]) : t('顏色 {n}', 'Color {n}', { n: i + 1 })}
                      tabIndex={on || (checkedIndex < 0 && i === 0) ? 0 : -1}
                      className={cx(s.swatch, on && s.swatchOn)}
                      onClick={() => set({ color: c })}
                    >
                      <Avatar name={shownName} color={c} size={36} />
                    </button>
                  );
                })}
              </div>
            </div>

            <div className={s.field}>
              <button type="button" className={s.pickRow} onClick={() => setPicking(true)} data-testid="account-currency">
                <span className={s.pickKey}>{t('主要幣別', 'Home currency')}</span>
                <span className={s.pickVal}>
                  <span className={s.code}>{draft.currency}</span>
                  <span className={s.pickName}>{currencyName(draft.currency, locale)}</span>
                </span>
                <Icon name="chevronRight" size={18} />
              </button>
              <p className={s.hint}>{t('總覽會用這個幣別，估算各幣別加起來大約多少', 'Home uses it to estimate your total across currencies.')}</p>
            </div>
          </div>
        </Card>

        <Card title={t('收款方式', 'How to pay me')}>
          <p className={s.lead}>{t('結清的時候，要付你錢的朋友會看到這些，方便直接轉給你', 'When friends settle up with you, they see these details so they can pay you directly.')}</p>
          <div className={s.fields}>
            {/* No placeholder on the two handle fields: a sample handle reads like a saved one. The hints give the format. */}
            <TextField
              label={t('Venmo 使用者名稱', 'Venmo username')}
              value={draft.venmo}
              onChange={v => set({ venmo: cleanHandle(v, VENMO_LINK) })}
              autoComplete="off"
              maxLength={120}
              hint={t('不用加 @，貼上個人連結也可以', 'No @ needed. Pasting your profile link works too.')}
              error={venmoError}
              data-testid="account-venmo"
            />
            <TextField
              label={t('PayPal.me 使用者名稱', 'PayPal.me username')}
              value={draft.paypal}
              onChange={v => set({ paypal: cleanHandle(v, PAYPAL_LINK) })}
              autoComplete="off"
              maxLength={120}
              hint={t('paypal.me/ 後面那一段', 'The part after paypal.me/')}
              error={paypalError}
              data-testid="account-paypal"
            />
            <TextField
              label={t('其他收款方式', 'Other ways to pay me')}
              value={draft.payInfo}
              onChange={v => set({ payInfo: v })}
              multiline
              rows={3}
              maxLength={PAYINFO_MAX}
              placeholder={t('例如 LINE Pay、街口支付，或銀行代碼和帳號', 'For example Zelle, LINE Pay, or bank details')}
              hint={t('同群組的朋友都看得到', 'Everyone in your groups can see this')}
              data-testid="account-payinfo"
            />
          </div>
        </Card>

        {error && <ErrorLine className={s.pad}>{error}</ErrorLine>}

        <div className={cx(s.saveBar, dirty && s.saveBarLive)}>
          <span className={s.saveNote} aria-live="polite">
            {dirty ? t('有變更還沒儲存', 'Unsaved changes') : ''}
          </span>
          {dirty && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(base)} disabled={busy}>
              {t('還原', 'Undo')}
            </Button>
          )}
          <Button type="submit" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty || invalid} loading={busy} data-testid="account-save-profile">
            {t('儲存', 'Save')}
          </Button>
        </div>
      </form>

      <CurrencyPicker
        open={picking}
        onClose={() => setPicking(false)}
        value={draft.currency}
        onSelect={(code: string) => {
          set({ currency: code });
          setPicking(false);
        }}
        highlight={highlight}
      />
    </>
  );
}
