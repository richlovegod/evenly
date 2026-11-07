// Review-1106, third pass, the pure rules of the web app: the words for a 409 the group currency
// caused, for limit_reached by its details and for a leave the settle-up plan blocks (lib/errors.ts;
// W2-correct-02, W7-contract-05, W7-contract-03); a queued save that met that 409 waits and goes
// again instead of failing for good (lib/outbox.ts retryDelay, W2-correct-02); how the signed-out
// dialog says to get back in, by what 登入 can show in this browser (signInNotices.ts
// signedOutWayBack, W2-text-03); what a wrong code does to a code typed meanwhile (emailCode.ts
// afterWrongCode, I7-contract-03); what an untouched 記錄還款 amount holds in another currency
// (settleRate.ts followAmount, I4-correct-01); the import's done screen counted by the Worker's own
// reasons (splitwiseImport.ts importOutcome, B6b-02); and the feed's words for a row nobody made
// by hand (activityText.ts, W7-contract-04).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityDTO } from '../../src/shared/types';

class MemoryStorage {
  readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

/** The app's modules loaded again in `locale` (config.ts and api.ts read location and storage when they load). */
async function load(locale: 'en' | 'zh-TW') {
  const ls = new MemoryStorage();
  ls.setItem('evenly.api', 'https://api.test');
  ls.setItem('evenly.locale', locale);
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  vi.stubGlobal('location', { origin: 'https://split.test', href: 'https://split.test/#/', pathname: '/', search: '', hash: '#/' });
  vi.resetModules();
  const i18n = await import('../../src/web/lib/i18n');
  i18n.setLocale(locale);
  return {
    ...(await import('../../src/web/lib/api')),
    ...(await import('../../src/web/lib/errors')),
    ...(await import('../../src/web/lib/outbox')),
    ...(await import('../../src/web/features/auth/signInNotices')),
    ...(await import('../../src/web/features/auth/emailCode')),
    ...(await import('../../src/web/features/settle/settleRate')),
    ...(await import('../../src/web/features/activity/activityText')),
    ...(await import('../../src/web/features/groups/splitwiseImport')),
    ...(await import('../../src/shared/money')),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('errorMessage by the details the Worker sends', () => {
  it('a 409 because the group currency just changed says to try again (review W2-correct-02); an edit clash keeps its words', async () => {
    const zh = await load('zh-TW');
    const moved = new zh.ApiError(409, 'conflict', 'The group currency changed while this was being saved. Try again.', { code: 'currency_changed' });
    expect(zh.errorMessage(moved)).toBe('群組的幣別剛被改過，請再試一次。');
    expect(zh.errorMessage(new zh.ApiError(409, 'conflict', 'x', { code: 'edited_elsewhere', fields: ['money'] }))).toBe('別人剛改過這筆，請先放棄這次的修改，再重新打開來改。');
    const en = await load('en');
    expect(en.errorMessage(new en.ApiError(409, 'conflict', 'x', { code: 'currency_changed' }))).toBe('The group currency just changed. Try again.');
  });

  it('limit_reached says which limit (review W7-contract-05), and an older Worker\'s answer without details keeps the old words', async () => {
    const zh = await load('zh-TW');
    const limit = (details?: unknown) => zh.errorMessage(new zh.ApiError(409, 'limit_reached', 'x', details));
    expect(limit({ limit: 'groups', self: true, max: 200 })).toBe('你已經在 200 個群組裡了，沒辦法再加入。');
    expect(limit({ limit: 'groups', name: '佳穎', max: 200 })).toBe('佳穎已經在 200 個群組裡了，沒辦法再加入。');
    expect(limit({ limit: 'groups', name: 'Kevin', max: 200 })).toBe('Kevin 已經在 200 個群組裡了，沒辦法再加入。');
    expect(limit({ limit: 'pair_members', max: 2 })).toBe('兩人帳本只能有兩個人。要加更多人，請建立群組。');
    expect(limit({ limit: 'members', max: 50 })).toBe('一個群組最多 50 位成員。');
    expect(limit({ limit: 'entries', max: 5000 })).toBe('一個群組最多記 5,000 筆。');
    expect(limit({ limit: 'entry_rows', max: 20000 })).toBe('這個群組已經存了 20,000 筆（包括刪除的），沒辦法再新增。');
    expect(limit()).toBe('已達上限。');
    const en = await load('en');
    expect(en.errorMessage(new en.ApiError(409, 'limit_reached', 'x', { limit: 'groups', name: 'Kevin' }))).toBe('Kevin is already in 200 groups, the most there can be.');
  });

  it('balance_not_zero at a balance of 0 names the settle-up plan and 簡化債務 (review W7-contract-03)', async () => {
    const zh = await load('zh-TW');
    const plan = new zh.ApiError(409, 'balance_not_zero', 'x', { net: 0, currency: 'TWD', transfers: 2 });
    expect(zh.errorMessage(plan)).toBe('結算建議裡還有要付或要收的錢。先記錄這些還款，或開啟「簡化債務」。');
    expect(zh.errorMessage(new zh.ApiError(409, 'balance_not_zero', 'x', { net: -500, currency: 'TWD', transfers: 1 }))).toBe('要先結清才能離開或移除這位成員。');
    expect(zh.errorMessage(new zh.ApiError(409, 'balance_not_zero', 'x'))).toBe('要先結清才能離開或移除這位成員。');
    const en = await load('en');
    expect(en.errorMessage(new en.ApiError(409, 'balance_not_zero', 'x', { net: 0, transfers: 1 }))).toBe('The settle-up plan still has payments for this member. Record them, or turn on Simplify debts.');
  });
});

describe('retryDelay for a queued save', () => {
  it('a 409 because the group currency changed waits out the backoff and goes again; an edit clash fails for good (review W2-correct-02)', async () => {
    const m = await load('en');
    expect(m.retryDelay(new m.ApiError(409, 'conflict', 'x', { code: 'currency_changed' }), 4000)).toBe(4000);
    expect(m.retryDelay(new m.ApiError(409, 'conflict', 'x', { code: 'edited_elsewhere' }), 4000)).toBeNull();
    expect(m.retryDelay(new m.ApiError(409, 'conflict', 'x'), 4000)).toBeNull();
    // As before: no connection waits; a full photo store fails for good.
    expect(m.retryDelay(new m.ApiError(0, 'offline', 'x'), 2000)).toBe(2000);
    expect(m.retryDelay(new m.ApiError(507, 'receipts_full', 'x'), 2000)).toBeNull();
  });
});

describe('wordDetails: what a failed outbox item keeps of the details (review W7-contract-05)', () => {
  it('the plain values the words read, never a whole entry', async () => {
    const m = await load('en');
    expect(m.wordDetails({ limit: 'entries', max: 5000 })).toEqual({ limit: 'entries', max: 5000 });
    expect(m.wordDetails({ code: 'edited_elsewhere', fields: ['money'], expense: { id: 'e1', amount: 100 } })).toEqual({ code: 'edited_elsewhere' });
    expect(m.wordDetails({ net: 0, currency: 'TWD', transfers: 2 })).toEqual({ net: 0, currency: 'TWD', transfers: 2 });
    expect(m.wordDetails(null)).toBeUndefined();
    expect(m.wordDetails([1, 2])).toBeUndefined();
    expect(m.wordDetails({ fields: ['money'] })).toBeUndefined();
  });
});

describe('the signed-out dialog: how to get back in (review W2-text-03)', () => {
  const here = (apple: boolean, google: boolean) => ({ apple, google });

  it('with an email: 登入, nothing more to say', async () => {
    const m = await load('zh-TW');
    expect(m.signedOutWayBack({ hasEmail: true, apple: true, google: false }, here(false, false))).toEqual({ line: null, to: '/login' });
  });

  it('Apple or Google linked and shown here: that button on 登入', async () => {
    const m = await load('zh-TW');
    expect(m.signedOutWayBack({ hasEmail: false, apple: true, google: false }, here(true, true))).toEqual({
      line: '這個帳號沒有 Email，用「使用 Apple 登入」就能登回來。', to: '/login',
    });
    expect(m.signedOutWayBack({ hasEmail: false, apple: true, google: true }, here(true, true)).line).toBe('這個帳號沒有 Email，用「使用 Apple 登入」或「使用 Google 帳戶登入」就能登回來。');
    // Only Google can show here (the site does not offer Apple): Google alone.
    expect(m.signedOutWayBack({ hasEmail: false, apple: true, google: true }, here(false, true))).toEqual({
      line: '這個帳號沒有 Email，用「使用 Google 帳戶登入」就能登回來。', to: '/login',
    });
  });

  it('in LINE\'s browser or a browser that keeps no cookies (no button here): a code from another device, in place', async () => {
    const zh = await load('zh-TW');
    expect(zh.signedOutWayBack({ hasEmail: false, apple: true, google: true }, here(false, false))).toEqual({
      line: '這個帳號沒有 Email，要在另一台已登入的裝置上產生登入碼，才能登回來。', to: '/link',
    });
    const en = await load('en');
    expect(en.signedOutWayBack({ hasEmail: false, apple: true, google: false }, here(false, false))).toEqual({
      line: 'This account has no email: make a sign-in code on another signed-in device to get back in.', to: '/link',
    });
  });
});

describe('a wrong code and the code typed meanwhile (review I7-contract-03, as the iPhone app does)', () => {
  it('a full corrected code is checked again, a correction still being typed stays, an untouched code is wiped', async () => {
    const m = await load('zh-TW');
    expect(m.afterWrongCode('111111', '123456')).toBe('recheck');
    expect(m.afterWrongCode('111111', '1234')).toBe('keep');
    expect(m.afterWrongCode('111111', '')).toBe('keep');
    expect(m.afterWrongCode('111111', '111111')).toBe('wipe');
  });
});

describe('an untouched 記錄還款 amount in another currency (review I4-correct-01, as the iPhone app does)', () => {
  it('the plan\'s amount at the rate, and nothing while there is no rate', async () => {
    const m = await load('en');
    // NT$1,500 paid in USD at 1 USD = 32.05 TWD.
    expect(m.followAmount(1500, 'TWD', 'USD', 32.05)).toBe(4679);
    expect(m.minorToInput(4679, 'USD')).toBe('46.79');
    // ¥48,544 paid in USD at 1 USD = 147.3 JPY.
    expect(m.minorToInput(m.followAmount(48544, 'JPY', 'USD', 147.3)!, 'USD')).toBe('329.56');
    // Loading, no answer, or a typed rate that cannot be read: empty, not NT$1,500 read as US$1,500.
    expect(m.followAmount(1500, 'TWD', 'USD', null)).toBeNull();
    expect(m.followAmount(1500, 'TWD', 'USD', 0)).toBeNull();
    // The group currency, and no plan payment.
    expect(m.followAmount(1500, 'TWD', 'TWD', null)).toBe(1500);
    expect(m.followAmount(0, 'TWD', 'USD', 32.05)).toBeNull();
  });
});

describe('the import\'s done screen by the Worker\'s own reasons (review B6b-02)', () => {
  it('counts exists, limit_reached and the rest as the Worker says, and falls back to the counts without them', async () => {
    const m = await load('zh-TW');
    // 10 in the file, 2 had already, 8 sent with room for 6: 5 went in; one came back exists (another
    // device imported it meanwhile), two limit_reached.
    expect(m.importOutcome(10, 8, 5, 6, ['exists', 'limit_reached', 'limit_reached'])).toEqual({ imported: 5, already: 3, limited: 2, refused: 0 });
    // A refusal is told from the room even when the room was short too.
    expect(m.importOutcome(10, 8, 5, 6, ['category', 'limit_reached', 'limit_reached'])).toEqual({ imported: 5, already: 2, limited: 2, refused: 1 });
    // An older Worker's answer without reasons (or reasons that do not cover every entry left out): inferred from the counts.
    expect(m.importOutcome(10, 8, 5, 6, [])).toEqual({ imported: 5, already: 2, limited: 2, refused: 1 });
    expect(m.importOutcome(10, 8, 5, 6)).toEqual({ imported: 5, already: 2, limited: 2, refused: 1 });
  });
});

describe('a Splitwise export imported into a full 1:1 ledger (review W3-contract-02)', () => {
  it('the one column nobody matched is the one of us nobody matched; anything less clear stays as it is', async () => {
    const m = await load('zh-TW');
    // 'Gino Chang' matched me, 'Jiaying Lin' matched nobody: it is 佳穎.
    expect(m.fillPairMapping(['m-gino', ''], ['m-gino', 'm-kai'])).toEqual(['m-gino', 'm-kai']);
    // A group's export with two unmatched columns: nothing is guessed (the sheet asks to map each).
    expect(m.fillPairMapping(['m-gino', '', ''], ['m-gino', 'm-kai'])).toEqual(['m-gino', '', '']);
    // Both matched already, or nobody left to match to.
    expect(m.fillPairMapping(['m-gino', 'm-kai'], ['m-gino', 'm-kai'])).toEqual(['m-gino', 'm-kai']);
    expect(m.fillPairMapping(['m-kai', ''], ['m-gino', 'm-kai'])).toEqual(['m-kai', 'm-gino']);
  });
});

describe('a feed row nobody made by hand (review W7-contract-04)', () => {
  function row(over: Partial<ActivityDTO>): ActivityDTO {
    return {
      id: 'a1', groupId: 'g1', groupName: '東京五天', groupEmoji: '', groupType: 'trip', userId: null, memberId: null, actorName: '',
      type: 'member.update', expenseId: null, data: {}, createdAt: '2026-11-07T10:00:00.000Z', ...over,
    };
  }
  const ctx = { meUserId: 'u-kevin', names: { g1: { 'm-abbie': 'Abbie', 'm-kevin': 'Kevin' } }, myMember: { g1: 'm-kevin' } };
  const handOn = { memberId: 'm-abbie', memberName: 'Abbie', changes: [{ field: 'role', from: 'member', to: 'admin' }] };

  it('the admin role handed on when an account is deleted reads as becoming an admin, not as someone editing', async () => {
    const zh = await load('zh-TW');
    expect(zh.describeActivity(row({ data: handOn }), ctx).text).toBe('Abbie 成為管理員');
    expect(zh.describeActivity(row({ data: { ...handOn, memberId: 'm-kevin', memberName: 'Kevin' } }), ctx).text).toBe('你成為管理員');
    const en = await load('en');
    expect(en.describeActivity(row({ data: handOn }), ctx).text).toBe('Abbie is now an admin');
  });

  it('any other system row names 系統 / The app, never 有人', async () => {
    const zh = await load('zh-TW');
    const other = row({ data: { memberId: 'm-abbie', memberName: 'Abbie', changes: [{ field: 'name', from: 'A', to: 'Abbie' }] } });
    expect(zh.describeActivity(other, ctx).text).toMatch(/^系統修改了/);
    const en = await load('en');
    expect(en.describeActivity(other, ctx).text).toMatch(/^The app updated Abbie/);
  });
});
