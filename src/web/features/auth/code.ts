// One-time sign-in codes: 8 characters from an alphabet without 0 O 1 I L, shown as XXXX-XXXX.

/** Characters a code never contains (people misread them), so typing one is a mistake. */
export const NEVER_IN_CODE = /[01OIL]/;

/** Letters and digits only, uppercase, at most 8 (full width and lowercase typing is fine). */
export function normalizeCode(raw: string): string {
  return raw.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

/** "abcdefgh" -> "ABCD-EFGH"; partial input keeps its shape while typing ("ABCD-E"). */
export function formatCode(raw: string): string {
  const c = normalizeCode(raw);
  return c.length > 4 ? c.slice(0, 4) + '-' + c.slice(4) : c;
}

/** A pasted sign-in link ("https://.../#/link/ABCD2345") or a typed code, reduced to the code part. */
export function codeFromInput(text: string): string {
  const m = /\/link\/([A-Za-z0-9-]+)/.exec(text);
  return formatCode(m ? m[1] : text);
}

/** The code is complete and could be real. */
export function codeReady(raw: string): boolean {
  const c = normalizeCode(raw);
  return c.length === 8 && !NEVER_IN_CODE.test(c);
}
