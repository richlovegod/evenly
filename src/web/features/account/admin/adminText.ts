// Words for the owner page: how an account signs in, short dates, and the activity sentences
// (the 動態 feed's own wording, told from the owner's side).

import type { ActivityDTO, AdminUserRow, MeDTO } from '../../../../shared/types';
import { formatDate, getLocale, t } from '../../../lib/i18n';
import { activityContext, describeActivity, type ActivityContext } from '../../activity/activityText';
import { localDay } from '../../auth/Receipt';
import { oneOf } from '../signInWays';

/** Rows the list asks for at a time. */
export const ADMIN_PAGE = 50;

/**
 * A row as these words read it: the email, and Apple and Google (UserDTO's appleLinked and
 * googleLinked). A Worker that sends neither: not linked.
 */
export type SignInRow = Pick<AdminUserRow, 'email'> & { appleLinked?: boolean; googleLinked?: boolean };

function linkedNames(u: SignInRow): string[] {
  return [u.appleLinked === true && 'Apple', u.googleLinked === true && 'Google'].filter((x): x is string => !!x);
}

/** 'Apple', 'Google' or 「Apple 或 Google」 / "Apple or Google": what is linked, or null for neither. */
export function linkedWays(u: SignInRow): string | null {
  const names = linkedNames(u);
  return names.length ? oneOf(names, getLocale() === 'zh-TW') : null;
}

/**
 * An account with an email (an email code, or a password) or with Apple or Google linked signs in
 * anywhere: that sign-in finds it on any device (docs/SPEC.md section 3, as 我的's deviceOnly). The
 * rest live only on their devices.
 */
export function signsInAnywhere(u: SignInRow): boolean {
  return !!u.email || linkedNames(u).length > 0;
}

/** Where the row's email goes, for an account without one: how it signs in instead. */
export function noEmailText(u: SignInRow): string {
  const ways = linkedWays(u);
  return ways ? t('沒有 Email（用 {ways} 登入）', 'No email (signs in with {ways})', { ways }) : t('沒有 Email（只在這台裝置）', 'No email (on their device only)');
}

/** How the account signs in, as the owner page's 登入方式 says it. */
export function signInText(u: SignInRow & Pick<AdminUserRow, 'emailVerified' | 'hasPassword'>): string {
  const zh = getLocale() === 'zh-TW';
  const linked = linkedNames(u);
  if (!u.email) return linked.length ? t('{ways}（沒有 Email）', '{ways} (no email)', { ways: oneOf(linked, zh) }) : t('只在裝置上（沒有 Email）', 'Device only (no email)');
  // An older client's field may be missing: not confirmed.
  if (!u.emailVerified) {
    const first = u.hasPassword ? t('Email 和密碼', 'Email and password') : t('Email 驗證碼', 'Email code');
    return t('{ways}（Email 還沒確認）', '{ways} (email not confirmed)', { ways: oneOf([first, ...linked], zh) });
  }
  const ways = [t('Email 驗證碼', 'Email code'), ...linked];
  if (u.hasPassword) ways.push(t('密碼', 'password'));
  return oneOf(ways, zh);
}

/** 「10/16」 or "Oct 16" this year, the full date for another year. */
export function shortDay(ts: string, now = Date.now()): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return formatDate(localDay(ts), d.getFullYear() === new Date(now).getFullYear() ? 'md' : 'long');
}

/** The whole list once every page is in. */
export function allLoaded(shown: number, total: number): boolean {
  return shown >= total;
}

/** Merge a later page into the list: new signups push rows down, so a row can come twice. */
export function appendPage<T extends { id: string }>(have: readonly T[], next: readonly T[]): T[] {
  const ids = new Set(have.map(u => u.id));
  return [...have, ...next.filter(u => !ids.has(u.id))];
}

const NO_NAMES: ActivityContext = { meUserId: '', names: {}, myMember: {} };

/**
 * The 動態 sentence for one of an account's activity rows, as the owner reads it: "你" is the
 * owner. Payment sentences name both sides from the reader's own groups; in a group the owner is
 * not in, those names are unknown, so the sentence says only that a payment was recorded.
 */
export function adminActivityText(a: ActivityDTO, me: MeDTO | null): { text: string; detail: string | null } {
  const ctx = me ? activityContext(me) : NO_NAMES;
  const known = !!ctx.names[a.groupId];
  const row = a.data?.kind === 'payment' && !known ? { ...a, data: { ...a.data, nets: undefined } } : a;
  const v = describeActivity(row, ctx);
  return { text: v.text, detail: v.detail };
}
