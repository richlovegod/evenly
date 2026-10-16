// In-app links: a real href (so long-press and "open in new tab" work) that moves with navigate(),
// so the router counts the step and back() returns to this page instead of replacing it.

import type { MouseEvent } from 'react';
import { href, navigate } from '../../lib/router';

export function linkTo(path: string): { href: string; onClick: (e: MouseEvent<HTMLElement>) => void } {
  return {
    href: href(path),
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(path);
    },
  };
}

/** The settle-up page for a transfer, amounts in group-currency minor units. */
export function settlePath(gid: string, from?: string, to?: string, amount?: number): string {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (amount && amount > 0) q.set('amount', String(amount));
  const s = q.toString();
  return '/g/' + encodeURIComponent(gid) + '/settle' + (s ? '?' + s : '');
}

export function groupPath(gid: string, tab?: 'balances' | 'stats' | 'settings'): string {
  return '/g/' + encodeURIComponent(gid) + (tab ? '/' + tab : '');
}

export function expensePath(gid: string, eid: string): string {
  return '/g/' + encodeURIComponent(gid) + '/e/' + encodeURIComponent(eid);
}
