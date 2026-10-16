// Words for the owner page: how an account signs in, short dates, and the activity sentences
// (the 動態 feed's own wording, told from the owner's side).

import type { ActivityDTO, AdminUserRow, MeDTO } from '../../../../shared/types';
import { formatDate } from '../../../lib/i18n';
import { activityContext, describeActivity, type ActivityContext } from '../../activity/activityText';
import { localDay } from '../../auth/Receipt';

/** Rows the list asks for at a time. */
export const ADMIN_PAGE = 50;

/** An account with an email and a password can sign in anywhere; the rest live only on their devices. */
export function signsInAnywhere(u: Pick<AdminUserRow, 'email' | 'hasPassword'>): boolean {
  return !!u.email && u.hasPassword;
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
