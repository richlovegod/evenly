// What the friend invite pages keep in the browser between steps (docs/SPEC.md section 8.3,
// 邀請朋友 and the invite page), the address of the inviter's photo, and where an invite pasted
// into 用邀請連結加入 (群組) goes:
// - the message the inviter picked last on 邀請朋友 (localStorage). Edits to its text are not kept:
//   the page opens on the chosen message as written.
// - that this tab opened an invite while signed out (sessionStorage, for that code, 30 minutes):
//   opening the link and signing in makes the two friends, so when the tab comes back to the
//   invite signed in (from 使用 Google 帳戶登入, or from 登入), it accepts at once instead of asking
//   again. The email sheet on the page needs none of this: it accepts as soon as it has signed in.

import { inviteCodeInLink } from '../../../shared/invites';
import type { InviteTemplateKey } from '../../../shared/types';
import { API_BASE } from '../../config';

const TEMPLATE_KEY = 'evenly.inviteTemplate';
const ACCEPT_KEY = 'evenly.inviteAccept';
/** How long a signed-out visit to an invite still counts when the tab comes back signed in. */
export const ACCEPT_MS = 30 * 60_000;

const KEYS: readonly InviteTemplateKey[] = ['everyday', 'trip', 'roommates'];

/** The message picked last on this device, or null. */
export function lastTemplate(): InviteTemplateKey | null {
  try {
    const v = localStorage.getItem(TEMPLATE_KEY);
    return KEYS.includes(v as InviteTemplateKey) ? (v as InviteTemplateKey) : null;
  } catch {
    return null;
  }
}

export function rememberTemplate(key: InviteTemplateKey): void {
  try {
    localStorage.setItem(TEMPLATE_KEY, key);
  } catch {
    /* the page still shows it; the next visit starts on the first */
  }
}

/** This tab opened the invite `code` signed out (a sign-in that comes back to it accepts it). */
export function markAccept(code: string, now = Date.now()): void {
  try {
    sessionStorage.setItem(ACCEPT_KEY, JSON.stringify({ code, at: now }));
  } catch {
    /* the page then asks with 加為朋友 */
  }
}

/**
 * Whether this tab opened the invite `code` signed out in the last 30 minutes. The mark goes
 * either way (one accept per mark): a later visit asks with 加為朋友.
 */
export function takeAccept(code: string, now = Date.now()): boolean {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(ACCEPT_KEY);
    sessionStorage.removeItem(ACCEPT_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  try {
    const m = JSON.parse(raw) as { code?: unknown; at?: unknown };
    return m.code === code && typeof m.at === 'number' && now - m.at >= 0 && now - m.at < ACCEPT_MS;
  } catch {
    return false;
  }
}

/** The inviter's photo at this version, for anyone holding the code (GET /api/invite/:code/avatar). */
export function inviteAvatarUrl(code: string, version: string): string {
  return `${API_BASE}/api/invite/${encodeURIComponent(code)}/avatar?v=${encodeURIComponent(version)}`;
}

/** A group invite code from what someone pasted: a whole link (…#/join/CODE) or just the code. */
export function inviteCodeFrom(text: string): string | null {
  const v = text.trim();
  const m = /join\/([A-Za-z0-9_-]{6,64})/.exec(v);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{6,64}$/.test(v) ? v : null;
}

/**
 * Where a pasted invite goes: a friend invite link of either form (…/i/CODE or …#/i/CODE, the
 * message around it included) to the friend invite, a group link or a bare code (inviteCodeFrom)
 * to the group invite, else null.
 */
export function pastedInvitePath(text: string): string | null {
  const friend = inviteCodeInLink(text);
  if (friend) return '/i/' + encodeURIComponent(friend);
  const code = inviteCodeFrom(text);
  return code ? '/join/' + encodeURIComponent(code) : null;
}
