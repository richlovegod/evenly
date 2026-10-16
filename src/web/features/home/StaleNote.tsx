// 「※ 無法更新，顯示的是上次同步的資料 再試一次 · 上次同步 10/16 05:57」: said when a refresh keeps
// failing while the device is online (server trouble), so cached numbers never pass for current
// ones. On a slip it is a Foot line; on a list page without a slip, a line on the counter.

import { useT } from '../../lib/i18n';
import { Foot } from '../groups/Slip';
import { syncText } from '../groups/sync';
import s from './StaleNote.module.css';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * When the numbers on screen were synced, always as a time (「上次同步 10/16 07:06」): next to
 * 「無法更新」, 「剛剛同步」 would read as a contradiction.
 */
export function staleTime(at: number, now = Date.now()): string {
  return at ? syncText(at, Math.max(now, at + 60_000)) : '';
}

/** The note's words (no full stop in Chinese: one line). */
export function useStaleWords(): string {
  const { t } = useT();
  return t('※ 無法更新，顯示的是上次同步的資料', 'Note: could not refresh, showing the last synced data.');
}

/** A small underlined text button with a 44 px hit area, for inside a footnote. */
export function RetryButton({ onClick, className }: { onClick: () => void; className?: string }) {
  const { t } = useT();
  return (
    <button type="button" className={cx(s.retry, className)} onClick={onClick} data-testid="stale-retry">
      {t('再試一次', 'Try again')}
    </button>
  );
}

/** The note as a slip footnote: words, 再試一次, and the sync time pushed right. */
export function StaleFoot({ at, onRetry }: { at: number; onRetry: () => void }) {
  const words = useStaleWords();
  return (
    <Foot right={staleTime(at) || undefined}>
      {words} <RetryButton onClick={onRetry} />
    </Foot>
  );
}

/** The note on a list page (no slip): the same words on the counter, under the band. */
export function StaleLine({ at, onRetry, className }: { at: number; onRetry: () => void; className?: string }) {
  const words = useStaleWords();
  const when = staleTime(at);
  return (
    <p className={cx(s.line, className)} role="status" data-testid="stale-note">
      <span className={s.main}>
        {words} <RetryButton onClick={onRetry} />
      </span>
      {when ? <span className={s.when}>{when}</span> : null}
    </p>
  );
}
