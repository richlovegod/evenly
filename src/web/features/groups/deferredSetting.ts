// A setting picked in a radio group whose choice is a write everyone sees: 結清方式 on 結算, and 類型,
// the cover and a member's color in 設定. Arrow keys select as they go (the ARIA radio pattern,
// NewGroupPage.tsx radioKeys and components/Segmented.tsx), so writing on every step would change
// the group for everyone, and add a row to 動態, once per option passed on the way. Here the pick
// shows at once (it drives aria-checked, so focus follows it), and is written only once picking
// stops for a moment. One write is in flight at a time, so answers cannot land out of order; a
// pick made meanwhile goes after it. A pick still waiting when the page goes is written right
// away. When the last pick fails (the write says why), the group's own value shows again.
//
// Nothing here disables the options while a write is on its way: a disabled option under the
// focus drops the focus to the page. They are disabled only offline.

import { useEffect, useRef, useState } from 'react';

/** Writes the value; false when it failed (the write has said why, in a toast). */
export type SettingWrite<T> = (value: T) => Promise<boolean>;

/** How long picking pauses before the pick is written. */
export const SETTLE_MS = 600;

export interface DeferredSettingOptions<T> {
  delay: number;
  /** The value the group has now. */
  current: () => T;
  same: (a: T, b: T) => boolean;
  /** What to show changed. */
  changed: () => void;
  /** The last pick could not be written: the group's own value shows again. */
  failed?: () => void;
}

/** The timing and the queue, apart from React (tested in tests/web/w3b-deferred-setting.test.ts). */
export class DeferredSetting<T> {
  private queued: { value: T; write: SettingWrite<T> } | null = null;
  private flying: { value: T } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private gone = false;

  constructor(private readonly opts: DeferredSettingOptions<T>) {}

  /** The pick to show instead of the group's value: the one waiting, else the one being written. */
  get draft(): T | undefined {
    if (this.queued) return this.queued.value;
    return this.flying ? this.flying.value : undefined;
  }

  /** Picked: show it now, write it once picking stops (with `write`, as it was when picked). */
  pick(value: T, write: SettingWrite<T>): void {
    this.queued = { value, write };
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.send();
    }, this.opts.delay);
    this.tell();
  }

  /** Drop the pick that waits (nothing is written for it); one already being written still lands. */
  cancel(): void {
    this.clearTimer();
    if (!this.queued) return;
    this.queued = null;
    this.tell();
  }

  /** Write the waiting pick now. */
  flush(): void {
    if (!this.timer) return;
    this.clearTimer();
    this.send();
  }

  /** The page goes: what waits is written now, and nothing is shown any more. */
  dispose(): void {
    this.flush();
    this.gone = true;
  }

  /** Shown again (React runs an effect's cleanup and the effect once more in development). */
  revive(): void {
    this.gone = false;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private tell(): void {
    if (!this.gone) this.opts.changed();
  }

  private send(): void {
    const q = this.queued;
    // One at a time: the one in flight sends this when it is done.
    if (!q || this.flying) return;
    this.queued = null;
    if (this.opts.same(q.value, this.opts.current())) {
      this.tell();
      return;
    }
    this.flying = { value: q.value };
    void q
      .write(q.value)
      .catch(() => false)
      .then(ok => {
        this.flying = null;
        if (!ok && !this.queued && !this.gone) this.opts.failed?.();
        // A pick made meanwhile whose pause is over goes now; one still in its pause goes after it.
        if (this.queued && !this.timer) this.send();
        this.tell();
      });
  }
}

/**
 * A group setting picked with arrow keys or taps (see the top of this file). `key` is whose setting
 * it is (the group, or the member): when it changes, what waits for the old one is written to it.
 * Returns the value to show, `pick(value, write)`, and `cancel()` for a pick that should not be
 * written after all.
 */
export function useDeferredSetting<T>(
  key: string,
  current: T,
  opts: { same?: (a: T, b: T) => boolean; failed?: () => void; delay?: number } = {},
): { value: T; pick: (value: T, write: SettingWrite<T>) => void; cancel: () => void } {
  const [, setTick] = useState(0);
  const failed = useRef(opts.failed);
  failed.current = opts.failed;
  const holder = useRef<{ key: string; last: T; setting: DeferredSetting<T> } | null>(null);
  if (!holder.current || holder.current.key !== key) {
    const made: { key: string; last: T; setting: DeferredSetting<T> } = {
      key,
      last: current,
      setting: new DeferredSetting<T>({
        delay: opts.delay ?? SETTLE_MS,
        // The value its own owner has, also once the key moved on (another group opened in its place).
        current: () => made.last,
        same: opts.same ?? Object.is,
        changed: () => setTick(n => n + 1),
        failed: () => failed.current?.(),
      }),
    };
    holder.current = made;
  }
  const own = holder.current;
  own.last = current;
  const setting = own.setting;
  useEffect(() => {
    setting.revive();
    return () => setting.dispose();
  }, [setting]);
  const draft = setting.draft;
  return {
    value: draft === undefined ? current : draft,
    pick: (value, write) => setting.pick(value, write),
    cancel: () => setting.cancel(),
  };
}
