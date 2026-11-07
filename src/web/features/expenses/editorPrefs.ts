// Small things the editor remembers on this device: the last currency used in each group, a
// rate typed by hand (per group, group currency and entry currency), a draft carried over when
// the group is changed in the header (with its receipt photos, in memory only), and the form left
// behind when someone navigates away without saving (offered back the next time, for 30 minutes,
// with the copy of the entry an edit's save is merged against).

import { isKnownCurrency } from '../../../shared/currencies';
import type { ExpenseDTO } from '../../../shared/types';
import { withKind, type EditorDraft } from './editorLogic';
import type { FormPhoto } from './editorPhotos';

const CUR_KEY = 'evenly.lastCurrency.';
const RATE_KEY = 'evenly.fxRate.';
const LAST_GROUP_KEY = 'evenly.lastGroup';
const HINT_KEY = 'evenly.faceHint';
// A new key whenever the note changes: since receipt photos are kept with the expense (2026-10-25,
// evenly.scanReceiptNote) and again since a scan reads all of an expense's photos together, up to
// three (2026-10-30), so every device sees the new words once.
const SCAN_PRIVACY_KEY = 'evenly.scanReceiptNote.photos';
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

/**
 * The account agreed in this browser that a scan sends the expense's receipt photos to Cloudflare
 * Workers AI, a third-party AI service (App Review guideline 5.1.2(i): say so clearly and get
 * explicit permission first; the iPhone app asks the same, per account on the phone). Kept per
 * account (key evenly.scanConsent.<userId>, value the version of what was agreed to), until it is
 * reset in 我的. Without an account id or without storage it is never taken as given: asking again
 * is always safe, sending without asking never is.
 */
const SCAN_CONSENT_KEY = 'evenly.scanConsent.';
/** What the dialog asks (editorText.scanConsentText); a new version asks every account again. */
const SCAN_CONSENT_VERSION = '1';

export function hasScanConsent(userId: string | null | undefined): boolean {
  if (!userId) return false;
  try {
    return localStorage.getItem(SCAN_CONSENT_KEY + userId) === SCAN_CONSENT_VERSION;
  } catch {
    return false;
  }
}

export function giveScanConsent(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    localStorage.setItem(SCAN_CONSENT_KEY + userId, SCAN_CONSENT_VERSION);
  } catch {
    /* not kept: the next scan asks again */
  }
}

export function resetScanConsent(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    localStorage.removeItem(SCAN_CONSENT_KEY + userId);
  } catch {
    /* nothing kept to reset */
  }
}

/** The first receipt scan on this device says once what happens to the photos: kept with the
 *  expense for the group to see, and read together. Without storage it says it every time rather
 *  than never. */
export function takeScanPrivacyNote(): boolean {
  try {
    if (localStorage.getItem(SCAN_PRIVACY_KEY)) return false;
    localStorage.setItem(SCAN_PRIVACY_KEY, '1');
    return true;
  } catch {
    return true;
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

/**
 * The parts of a new entry that make sense in another group (members differ, so payer and split do
 * not move). The kind goes too: a refund moved to the group it belongs to is still a refund.
 */
export type CarriedDraft = Pick<EditorDraft, 'amountRaw' | 'currency' | 'description' | 'category' | 'categoryManual' | 'date' | 'notes' | 'repeat'> & {
  kind: 'expense' | 'refund';
};

let carried: { gid: string; draft: CarriedDraft; photos: FormPhoto[] } | null = null;

/**
 * Carry a new entry over to group `gid`: the parts of the draft that make sense there, and the
 * receipt photos picked for it (they belong to the entry, not to a group). The photos stay in
 * memory only, hundreds of KB each, until the next editor takes them.
 */
export function carryDraft(gid: string, d: EditorDraft, photos: readonly FormPhoto[] = []): void {
  carried = {
    gid,
    draft: {
      kind: d.kind === 'refund' ? 'refund' : 'expense',
      amountRaw: d.amountRaw,
      currency: d.currency,
      description: d.description,
      category: d.category,
      categoryManual: d.categoryManual,
      date: d.date,
      notes: d.notes,
      repeat: d.repeat,
    },
    photos: photos.filter(p => p.kind === 'new'),
  };
}

/** The draft carried over to this group, if any. Reading does not clear it (React may render twice); call clearCarried() after mounting. */
export function peekCarried(gid: string): CarriedDraft | null {
  return carried && carried.gid === gid ? carried.draft : null;
}

/**
 * The form a carried draft opens as in its new group: that group's fresh form (its default split
 * and payer) with the carried parts on top, as an expense or a refund like the form it left. A
 * refund refunds nothing in particular there (refundOf named an expense of the other group), and
 * it never repeats (as withKind makes it).
 */
export function withCarried(fresh: EditorDraft, c: CarriedDraft): EditorDraft {
  const d = { ...withKind(fresh, c.kind), ...c };
  return c.kind === 'refund' ? { ...d, repeat: 'none' } : d;
}

/** The receipt photos carried over to this group with the draft (none: an empty list). */
export function peekCarriedPhotos(gid: string): FormPhoto[] {
  return carried && carried.gid === gid ? [...carried.photos] : [];
}

export function clearCarried(): void {
  carried = null;
}

/** An edit's merge base: the entry as its form opened, and the group currency that copy's rate is for. */
export interface StashedEntry {
  entry: ExpenseDTO;
  rateBase: string;
}

interface Rescue {
  key: string;
  at: number;
  draft: EditorDraft;
  /** The group currency the draft's rates are for (missing in a stash kept before 2026-11-07). */
  rateBase?: string;
  /** An edit: the entry as its form opened, which its save is merged against. */
  opened?: StashedEntry;
}

/** A form left behind, as peekStash gives it back. */
export interface Stashed {
  draft: EditorDraft;
  /** The group currency its rates are for (null: not kept, from an older version of the app). */
  rateBase: string | null;
  /** An edit: the entry as its form opened (null: not kept; the save then merges against the entry as it is). */
  opened: StashedEntry | null;
}

/**
 * Keep an unsaved form for this editor key ("<gid>:new" or "<gid>:<eid>"), with the group currency
 * its rates are for, and for an edit the entry as the form opened: a form brought back is merged
 * against the copy it was typed over, so what someone changed since is kept, instead of the stale
 * fields of the draft being written over it (review B5-03).
 */
export function stashDraft(key: string, draft: EditorDraft, more: { rateBase?: string; opened?: StashedEntry | null } = {}): void {
  try {
    const r: Rescue = { key, at: Date.now(), draft };
    if (more.rateBase) r.rateBase = more.rateBase;
    if (more.opened) r.opened = more.opened;
    sessionStorage.setItem(RESCUE_KEY, JSON.stringify(r));
  } catch {
    /* ignore */
  }
}

/** The form left behind for this key, if it is recent. Reading does not remove it; call clearStash() after mounting. */
export function peekStash(key: string): Stashed | null {
  try {
    const raw = sessionStorage.getItem(RESCUE_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Rescue;
    if (r.key !== key) return null;
    if (Date.now() - r.at > RESCUE_MS || !r.draft || typeof r.draft.id !== 'string' || !r.draft.split) return null;
    const o = r.opened;
    const e = o?.entry;
    const opened =
      o && typeof o.rateBase === 'string' && e && typeof e.id === 'string' && typeof e.version === 'number' && Array.isArray(e.payers) && !!e.split ? o : null;
    return { draft: r.draft, rateBase: typeof r.rateBase === 'string' ? r.rateBase : null, opened };
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
