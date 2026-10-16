// The owner's user list: what is typed in the search box, the rows loaded so far (50 at a time),
// and the site-wide counts that come with every page. A search waits for typing to pause; an
// answer to an older search is dropped.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminStatsDTO, AdminUserRow } from '../../../../shared/types';
import { errorMessage } from '../../../lib/errors';
import { actions } from '../../../lib/store';
import { showToast } from '../../../lib/toast';
import { ADMIN_PAGE, appendPage } from './adminText';

export interface AdminUserList {
  /** The search box. */
  text: string;
  setText: (v: string) => void;
  /** Search now (Enter), without waiting for the pause. */
  searchNow: () => void;
  /** The search the rows below answer. */
  query: string;
  users: AdminUserRow[] | null;
  total: number;
  stats: AdminStatsDTO | null;
  /** A search (or the first load) is on its way. */
  loading: boolean;
  error: string | null;
  retry: () => void;
  loadMore: () => Promise<void>;
  loadingMore: boolean;
}

const PAUSE_MS = 300;

export function useAdminUsers(enabled: boolean): AdminUserList {
  const [text, setTextState] = useState('');
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AdminUserRow[] | null>(null);
  const [answered, setAnswered] = useState('');
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<AdminStatsDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const typed = useRef('');

  const setText = useCallback((v: string) => {
    typed.current = v;
    setTextState(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setQuery(v.trim()), PAUSE_MS);
  }, []);

  const searchNow = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setQuery(typed.current.trim());
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    actions.adminUsers({ q: query, limit: ADMIN_PAGE }).then(
      r => {
        if (mine !== seq.current) return;
        setUsers(r.users);
        setTotal(r.total);
        setStats(r.stats);
        setAnswered(query);
        setLoading(false);
      },
      err => {
        if (mine !== seq.current) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
  }, [enabled, query, attempt]);

  const loadMore = useCallback(async () => {
    if (!users || loadingMore) return;
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const r = await actions.adminUsers({ q: answered, limit: ADMIN_PAGE, offset: users.length });
      if (mine !== seq.current) return;
      setUsers(list => appendPage(list ?? [], r.users));
      setTotal(r.total);
      setStats(r.stats);
    } catch (err) {
      showToast({ message: errorMessage(err), kind: 'error' });
    } finally {
      setLoadingMore(false);
    }
  }, [users, loadingMore, answered]);

  const retry = useCallback(() => setAttempt(a => a + 1), []);

  return { text, setText, searchNow, query: answered, users, total, stats, loading, error, retry, loadMore, loadingMore };
}
