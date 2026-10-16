// Small things the editor remembers on this device: the last currency used in each group, a
// rate typed by hand (per group, group currency and entry currency), a draft carried over when
// the group is changed in the header, and the form left behind when someone navigates away
// without saving (offered back the next time, for 30 minutes).

import { isKnownCurrency } from '../../../shared/currencies';
import type { EditorDraft } from './editorLogic';

const CUR_KEY = 'evenly.lastCurrency.';
const RATE_KEY = 'evenly.fxRate.';
const LAST_GROUP_KEY = 'evenly.lastGroup';
const HINT_KEY = 'evenly.faceHint';
const RESCUE_KEY = 'evenly.editorRescue';
const RESCUE_MS = 30 * 60 * 1000;

/**
 * The group of the last expense added on this device (DESIGN.md 7.1: the 新增費用 key outside
 * a group opens this group's add sheet). Read by the shell.
 */
export function rememberLastGroup(gid: string): void {
  try {
    localStorage.setItem(LAST_GROUP_KEY, gid);
  } catch {
    /* ignore */
  }
}

/**
 * Where a typed rate is kept. A rate means "1 <currency> = x <base>", so the group currency it
 * was typed against is part of the key: after the group switches currency (here or on another
 * phone) a rate typed against the old one is never offered again.
 */
function rateKey(gid: string, base: string, currency: string): string {
  return RATE_KEY + gid + '.' + base + '.' + currency;
}

/** The key used before the group currency was part of it. Its base is unknown, so it is never read. */
function oldRateKey(gid: string, currency: string): string {
  return RATE_KEY + gid + '.' + currency;
}

/**
 * A rate typed by hand carries forward for this group, group currency and entry currency until
 * reset (DESIGN.md 9.6). '' when there is none.
 */
export function rememberedRate(gid: string, base: string, currency: string): string {
  if (!base || !currency || base === currency) return '';
  try {
    localStorage.removeItem(oldRateKey(gid, currency));
    return localStorage.getItem(rateKey(gid, base, currency)) ?? '';
  } catch {
    return '';
  }
}

export function rememberRate(gid: string, base: string, currency: string, raw: string): void {
  if (!base || !currency || base === currency) return;
  try {
    localStorage.removeItem(oldRateKey(gid, currency));
    if (raw.trim()) localStorage.setItem(rateKey(gid, base, currency), raw.trim());
    else localStorage.removeItem(rateKey(gid, base, currency));
  } catch {
    /* ignore */
  }
}

/** The faces hint (點頭像可排除沒參與的人) shows the first 3 times the editor opens. */
export function takeFaceHint(): boolean {
  try {
    const n = Number(localStorage.getItem(HINT_KEY) ?? '0') || 0;
    if (n >= 3) return false;
    localStorage.setItem(HINT_KEY, String(n + 1));
    return true;
  } catch {
    return false;
  }
}

export function lastCurrency(gid: string): string | null {
  try {
    const v = localStorage.getItem(CUR_KEY + gid);
    return v && /^[A-Z]{3}$/.test(v) && isKnownCurrency(v) ? v : null;
  } catch {
    return null;
  }
}

export function rememberCurrency(gid: string, code: string): void {
  try {
    localStorage.setItem(CUR_KEY + gid, code);
  } catch {
    /* storage unavailable */
  }
}

/** The parts of a new entry that make sense in another group (members differ, so payer and split do not move). */
export type CarriedDraft = Pick<EditorDraft, 'amountRaw' | 'currency' | 'description' | 'category' | 'categoryManual' | 'date' | 'notes' | 'repeat'>;

let carried: { gid: string; draft: CarriedDraft } | null = null;

export function carryDraft(gid: string, d: EditorDraft): void {
  carried = {
    gid,
    draft: {
      amountRaw: d.amountRaw,
      currency: d.currency,
      description: d.description,
      category: d.category,
      categoryManual: d.categoryManual,
      date: d.date,
      notes: d.notes,
      repeat: d.repeat,
    },
  };
}

/** The draft carried over to this group, if any. Reading does not clear it (React may render twice); call clearCarried() after mounting. */
export function peekCarried(gid: string): CarriedDraft | null {
  return carried && carried.gid === gid ? carried.draft : null;
}

export function clearCarried(): void {
  carried = null;
}

interface Rescue {
  key: string;
  at: number;
  draft: EditorDraft;
}

/** Keep an unsaved form for this editor key ("<gid>:new" or "<gid>:<eid>"). */
export function stashDraft(key: string, draft: EditorDraft): void {
  try {
    const r: Rescue = { key, at: Date.now(), draft };
    sessionStorage.setItem(RESCUE_KEY, JSON.stringify(r));
  } catch {
    /* ignore */
  }
}

/** The form left behind for this key, if it is recent. Reading does not remove it; call clearStash() after mounting. */
export function peekStash(key: string): EditorDraft | null {
  try {
    const raw = sessionStorage.getItem(RESCUE_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Rescue;
    if (r.key !== key) return null;
    if (Date.now() - r.at > RESCUE_MS || !r.draft || typeof r.draft.id !== 'string' || !r.draft.split) return null;
    return r.draft;
  } catch {
    return null;
  }
}

export function clearStash(): void {
  try {
    sessionStorage.removeItem(RESCUE_KEY);
  } catch {
    /* ignore */
  }
}
