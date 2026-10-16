// Keep an open group fresh: load it now, poll every 20 s while the page is visible (the server
// answers 304 when nothing changed), and reload when the app comes back to the front or online.

import { useEffect } from 'react';
import { actions } from '../../lib/store';

const POLL_MS = 20000;

export function useGroupSync(gid: string | null | undefined): void {
  useEffect(() => {
    if (!gid) return;
    const visible = () => document.visibilityState === 'visible';
    const refresh = () => {
      if (visible()) void actions.loadGroup(gid);
    };
    void actions.loadGroup(gid);
    const timer = window.setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [gid]);
}
