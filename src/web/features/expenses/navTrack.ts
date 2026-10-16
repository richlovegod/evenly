// Where the editor was opened from, so saving can go "back" to the group (or the detail page)
// instead of stacking a second copy of it in the history. Only hash changes are seen; the
// router's replace navigations do not fire one, which is fine for this purpose.

import { back, navigate, parseHash } from '../../lib/router';

function currentPath(): string {
  return typeof location !== 'undefined' ? parseHash(location.hash).path : '/';
}

let prev: string | null = null;
let cur: string = currentPath();

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    prev = cur;
    cur = currentPath();
  });
}

/** The path shown before the current one (null when the app was opened here). */
export function previousPath(): string | null {
  return prev;
}

/**
 * Go to `dest`: back through the history when the previous page is `dest` (or, with
 * `sameGroup`, any tab of that group page), else replace the current entry.
 */
export function leaveTo(dest: string, opts: { groupId?: string } = {}): void {
  const from = prev;
  const g = opts.groupId;
  const groupTab = !!g && !!from && new RegExp(`^/g/${escapeRe(encodeURIComponent(g))}(/(balances|stats|settings))?$`).test(from);
  if (from === dest || groupTab) back(dest);
  else navigate(dest, { replace: true });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
