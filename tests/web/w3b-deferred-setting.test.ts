// Group settings picked in a radio group (review-1106, B6a-06, B6a-12, B6a-13, B6b-12;
// features/groups/deferredSetting.ts): arrow keys select as they go, so the pick shows at once and
// is written only once picking stops. Passing options on the way writes nothing, a pick dropped in
// time (集中還給…) writes nothing, writes go one at a time, a failed last pick shows the group's own
// value again, and a pick still waiting when the page goes is written right away.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeferredSetting, SETTLE_MS, type SettingWrite } from '../../src/web/features/groups/deferredSetting';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(start: string) {
  let server = start;
  const writes: string[] = [];
  const pending: { value: string; resolve: (ok: boolean) => void }[] = [];
  const failed = vi.fn();
  const changed = vi.fn();
  const setting = new DeferredSetting<string>({ delay: SETTLE_MS, current: () => server, same: (a, b) => a === b, changed, failed });
  /** A write that lands when the test says so. */
  const write: SettingWrite<string> = value =>
    new Promise<boolean>(resolve => {
      writes.push(value);
      pending.push({
        value,
        resolve: ok => {
          if (ok) server = value;
          resolve(ok);
        },
      });
    });
  const shown = () => setting.draft ?? server;
  return { setting, write, writes, pending, failed, changed, shown };
}

/** Let the promise callbacks run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('a deferred setting', () => {
  it('shows each pick at once and writes only the last, once picking stops', async () => {
    const t = setup('simplified');
    t.setting.pick('pairwise', t.write);
    expect(t.shown()).toBe('pairwise');
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 100);
    t.setting.pick('red', t.write);
    t.setting.pick('blue', t.write);
    expect(t.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(t.writes).toEqual(['blue']);
    t.pending[0].resolve(true);
    await settle();
    expect(t.setting.draft).toBeUndefined();
    expect(t.shown()).toBe('blue');
  });

  it('writes nothing for a pick dropped in time, or one back at the group\'s value', async () => {
    const t = setup('simplified');
    t.setting.pick('pairwise', t.write);
    t.setting.cancel();
    expect(t.shown()).toBe('simplified');
    t.setting.pick('pairwise', t.write);
    t.setting.pick('simplified', t.write);
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 2);
    expect(t.writes).toEqual([]);
    expect(t.setting.draft).toBeUndefined();
  });

  it('shows the group\'s value again when the last pick fails', async () => {
    const t = setup('#2F6FB5');
    t.setting.pick('#E0533D', t.write);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(t.shown()).toBe('#E0533D');
    t.pending[0].resolve(false);
    await settle();
    expect(t.failed).toHaveBeenCalledTimes(1);
    expect(t.shown()).toBe('#2F6FB5');
  });

  it('writes one at a time: a pick made meanwhile goes after the one in flight', async () => {
    const t = setup('trip');
    t.setting.pick('home', t.write);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(t.writes).toEqual(['home']);
    t.setting.pick('couple', t.write);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    // Still one write: the second waits for the first to land, so their answers keep their order.
    expect(t.writes).toEqual(['home']);
    expect(t.shown()).toBe('couple');
    t.pending[0].resolve(true);
    await settle();
    expect(t.writes).toEqual(['home', 'couple']);
    // A newer pick is on its way: the first one's failure would not revert it either.
    expect(t.failed).not.toHaveBeenCalled();
    t.pending[1].resolve(true);
    await settle();
    expect(t.shown()).toBe('couple');
    expect(t.setting.draft).toBeUndefined();
  });

  it('does not revert to the group\'s value for a failure a newer pick replaces', async () => {
    const t = setup('trip');
    t.setting.pick('home', t.write);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    t.setting.pick('other', t.write);
    t.pending[0].resolve(false);
    await settle();
    expect(t.failed).not.toHaveBeenCalled();
    expect(t.shown()).toBe('other');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(t.writes).toEqual(['home', 'other']);
  });

  it('writes a waiting pick right away when the page goes, and tells nothing after', async () => {
    const t = setup('🏠');
    t.setting.pick('🏖️', t.write);
    t.changed.mockClear();
    t.setting.dispose();
    expect(t.writes).toEqual(['🏖️']);
    t.pending[0].resolve(false);
    await settle();
    expect(t.changed).not.toHaveBeenCalled();
    expect(t.failed).not.toHaveBeenCalled();
  });

  it('keeps working after React runs an effect cleanup and the effect again', async () => {
    const t = setup('trip');
    t.setting.dispose();
    t.setting.revive();
    t.setting.pick('home', t.write);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(t.writes).toEqual(['home']);
  });
});
