// The bodies the web editor sends for an edit (editorLogic.withEditBase) and for its 復原
// (undoOfEdit), built with the editor's own logic as ExpenseEditorPage.save builds them, merged by
// the real PUT route on the real schema (tests/worker/d1-sqlite.ts). Review-1106 unit W1: B5-04
// (復原 keeps what someone else changed), B5-03 (a form brought back merges against the copy it was
// typed over) and the editor side of A4-01 (that copy says the group currency of its rate).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fx = vi.hoisted(() => ({ rates: {} as Record<string, number> }));

vi.mock('../../src/worker/services/fx', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/worker/services/fx')>();
  return { ...actual, getUsdRates: vi.fn(async (_db: unknown, date: string) => ({ date, rates: { ...fx.rates }, source: 'test' })) };
});

import { todayUTC } from '../../src/shared/dates';
import type { ExpenseDTO, GroupSnapshotDTO, UpsertExpenseReq } from '../../src/shared/types';
import { bodyOfExpense, draftFromExpense, evaluate, undoOfEdit, withEditBase, type EditorDraft } from '../../src/web/features/expenses/editorLogic';
import { createSession } from '../../src/worker/auth';
import worker from '../../src/worker/index';
import { TestD1 } from './d1-sqlite';

const START_RATES = { USD: 1, TWD: 32.3, JPY: 150.2, EUR: 0.92 };

let db: TestD1;
const tokens: Record<string, string> = {};
let entries = 0;

interface Res<T = any> {
  status: number;
  data: T;
}

async function api<T = any>(user: string, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const h: Record<string, string> = { Authorization: 'Bearer ' + tokens[user] };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request('http://api.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const env = { DB: db.d1, ALLOWED_ORIGINS: '', APP_URL: 'http://app.test/', ENVIRONMENT: 'test' };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env as never, ctx);
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : undefined };
}

async function addUser(id: string, name: string, email: string): Promise<void> {
  const now = new Date().toISOString();
  db.exec('INSERT INTO users (id, name, email, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, email, '#2F6FB5', now, now);
  tokens[id] = await createSession(db.d1, id, 'test');
}

/** A TWD group of Gino (uA, member A) and Abbie (uB, member B) with 晚餐 NT$3,000, paid by Gino, split by both. */
interface World {
  gid: string;
  eid: string;
  A: string;
  B: string;
}

async function world(): Promise<World> {
  const g = await api<GroupSnapshotDTO>('uA', 'POST', '/api/groups', { name: 'trip', type: 'trip', currency: 'TWD', members: [{ name: 'Abbie', email: 'b@evenly.test' }] });
  expect(g.status).toBe(200);
  const id = (name: string) => g.data.members.find(m => m.name === name)!.id;
  const w = { gid: g.data.group.id, eid: `entry-w1-${++entries}`, A: id('Gino'), B: id('Abbie') };
  const first = await api('uA', 'PUT', `/api/groups/${w.gid}/expenses/${w.eid}`, {
    kind: 'expense', description: '晚餐', category: 'food.dining', amount: 3000, currency: 'TWD', fxRate: 1, date: todayUTC(), notes: '',
    payers: [{ memberId: w.A, amount: 3000 }], split: { method: 'equal', entries: [{ memberId: w.A }, { memberId: w.B }] }, repeat: 'none',
  });
  expect(first.status).toBe(200);
  return w;
}

const entry = async (w: World): Promise<ExpenseDTO> => (await api<GroupSnapshotDTO>('uA', 'GET', '/api/groups/' + w.gid)).data.expenses.find(e => e.id === w.eid)!;
const put = (user: string, w: World, body: UpsertExpenseReq) => api<{ expense: ExpenseDTO }>(user, 'PUT', `/api/groups/${w.gid}/expenses/${w.eid}`, body);

/**
 * What the editor sends when `opened` is the copy its form opened with: the draft from it (or
 * `draft`, a form brought back), changed by `change`, as evaluate and withEditBase make it.
 */
function editorSave(
  w: World,
  opened: ExpenseDTO,
  change: (d: EditorDraft) => EditorDraft,
  o: { draft?: EditorDraft; groupCurrency?: string; openedBase?: string } = {},
): UpsertExpenseReq {
  const groupCurrency = o.groupCurrency ?? 'TWD';
  const memberIds = [w.A, w.B];
  const d = change(o.draft ?? draftFromExpense(opened, { memberIds }));
  const ev = evaluate(d, { memberIds, meId: w.A, groupCurrency, fetchedRate: null, locale: 'zh-TW' });
  if (!ev.body) throw new Error('the form cannot save: ' + JSON.stringify(ev.reason));
  return withEditBase(ev.body, opened, { groupCurrency, openedBase: o.openedBase ?? groupCurrency });
}

const amount = (raw: string) => (d: EditorDraft): EditorDraft => ({ ...d, amountRaw: raw });
const notes = (text: string) => (d: EditorDraft): EditorDraft => ({ ...d, notes: text });

beforeEach(async () => {
  fx.rates = { ...START_RATES };
  db = new TestD1();
  await addUser('uA', 'Gino', 'a@evenly.test');
  await addUser('uB', 'Abbie', 'b@evenly.test');
});

describe("an edit's 復原 (B5-04)", () => {
  it('puts back only what the save changed: a note added meanwhile stays', async () => {
    const w = await world();
    const opened = await entry(w); // Gino's form opens (an open form is not polled)
    expect((await put('uB', w, editorSave(w, opened, notes('訂位代號 A12')))).status).toBe(200); // Abbie adds a note
    const sent = editorSave(w, opened, amount('3600'));
    const saved = await put('uA', w, sent);
    expect(saved.status).toBe(200);
    expect(saved.data.expense).toMatchObject({ amount: 3600, notes: '訂位代號 A12' });
    const undone = await put('uA', w, undoOfEdit(sent, opened, 'TWD'));
    expect(undone.status).toBe(200);
    expect(undone.data.expense).toMatchObject({ amount: 3000, notes: '訂位代號 A12' });
  });

  it('(as it was) the whole old body wrote over the note', async () => {
    const w = await world();
    const opened = await entry(w);
    await put('uB', w, editorSave(w, opened, notes('訂位代號 A12')));
    await put('uA', w, editorSave(w, opened, amount('3600')));
    expect((await put('uA', w, bodyOfExpense(opened))).data.expense).toMatchObject({ amount: 3000, notes: '' });
  });

  it('tapped before the save went out: in order it ends as before the edit, and on its own it writes nothing', async () => {
    const w = await world();
    const opened = await entry(w);
    const sent = editorSave(w, opened, amount('3600'));
    const undo = undoOfEdit(sent, opened, 'TWD');
    // Abbie's note lands while both wait in Gino's outbox, then they go in order.
    await put('uB', w, editorSave(w, opened, notes('訂位代號 A12')));
    expect((await put('uA', w, sent)).status).toBe(200);
    const inOrder = await put('uA', w, undo);
    expect(inOrder.status).toBe(200);
    expect(inOrder.data.expense).toMatchObject({ amount: 3000, notes: '訂位代號 A12' });

    // The outbox kept only the 復原 (it replaced the save that had not gone out): nothing changes.
    const w2 = await world();
    const opened2 = await entry(w2);
    const alone = await put('uA', w2, undoOfEdit(editorSave(w2, opened2, amount('3600')), opened2, 'TWD'));
    expect(alone.status).toBe(200);
    expect(alone.data.expense).toMatchObject({ amount: 3000, notes: '' });
  });

  it('answers 409 for a part someone changed again after the save', async () => {
    const w = await world();
    const opened = await entry(w);
    const sent = editorSave(w, opened, amount('3600'));
    expect((await put('uA', w, sent)).status).toBe(200);
    const after = await entry(w);
    expect((await put('uB', w, editorSave(w, after, amount('4000')))).status).toBe(200); // Abbie, from the saved entry
    const r = await put('uA', w, undoOfEdit(sent, opened, 'TWD'));
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('conflict');
    expect((await entry(w)).amount).toBe(4000);
  });
});

describe('復原 is built from the copy the save was merged against, not the live one (review W1-correct-01)', () => {
  /**
   * Gino's form opens on NT$3,000. Abbie sets NT$3,600, which this phone sees (a sync while the form
   * is open, or a form brought back from the stash), then `back` again before Gino's save. Gino
   * only adds a note. `live` is the entry as Gino's phone shows it when he saves.
   */
  async function changedTwice(back: string) {
    const w = await world();
    const opened = await entry(w);
    expect((await put('uB', w, editorSave(w, opened, amount('3600')))).status).toBe(200);
    const live = await entry(w);
    expect((await put('uB', w, editorSave(w, live, amount(back)))).status).toBe(200);
    const sent = editorSave(w, opened, notes('訂位代號 A12'));
    const saved = await put('uA', w, sent);
    expect(saved.status).toBe(200);
    expect(saved.data.expense).toMatchObject({ amount: Number(back), notes: '訂位代號 A12' });
    return { w, opened, live, sent };
  }

  it('Abbie put NT$3,000 back: 復原 takes only the note off, and NT$3,000 stays', async () => {
    const { w, opened, sent } = await changedTwice('3000');
    const r = await put('uA', w, undoOfEdit(sent, opened, 'TWD'));
    expect(r.status).toBe(200);
    expect(r.data.expense).toMatchObject({ amount: 3000, notes: '' });
  });

  it('Abbie set a third amount (NT$4,000): 復原 takes only the note off (200), and NT$4,000 stays', async () => {
    const { w, opened, sent } = await changedTwice('4000');
    const r = await put('uA', w, undoOfEdit(sent, opened, 'TWD'));
    expect(r.status).toBe(200);
    expect(r.data.expense).toMatchObject({ amount: 4000, notes: '' });
  });

  it('(as it was) built from the live copy, it wrote Abbie\'s withdrawn NT$3,600 back without a word, or answered a false 409', async () => {
    const back = await changedTwice('3000');
    const silent = await put('uA', back.w, undoOfEdit(back.sent, back.live, 'TWD'));
    expect([silent.status, silent.data.expense.amount]).toEqual([200, 3600]);
    const third = await changedTwice('4000');
    expect((await put('uA', third.w, undoOfEdit(third.sent, third.live, 'TWD'))).status).toBe(409);
  });
});

describe('a form brought back from the stash (B5-03)', () => {
  it('merges against the copy it was typed over: a change made since stays', async () => {
    const w = await world();
    const opened = await entry(w);
    // Gino adds a note and leaves with Back: the stash keeps the draft and the copy it was typed over.
    const left = notes('my note')(draftFromExpense(opened, { memberIds: [w.A, w.B] }));
    expect((await put('uB', w, editorSave(w, opened, amount('3600')))).status).toBe(200); // Abbie, meanwhile
    // 編輯 again within 30 minutes: 已恢復上次沒儲存的內容, then 儲存.
    const r = await put('uA', w, editorSave(w, opened, d => d, { draft: left }));
    expect(r.status).toBe(200);
    expect(r.data.expense).toMatchObject({ amount: 3600, notes: 'my note' });
  });

  it('(as it was) merged against the entry as it is by then, it wrote NT$3,000 back', async () => {
    const w = await world();
    const opened = await entry(w);
    const left = notes('my note')(draftFromExpense(opened, { memberIds: [w.A, w.B] }));
    await put('uB', w, editorSave(w, opened, amount('3600')));
    const now = await entry(w);
    expect((await put('uA', w, editorSave(w, now, d => d, { draft: left }))).data.expense).toMatchObject({ amount: 3000, notes: 'my note' });
  });

  it('answers 409 when both changed the same part', async () => {
    const w = await world();
    const opened = await entry(w);
    const left = amount('3300')(draftFromExpense(opened, { memberIds: [w.A, w.B] }));
    await put('uB', w, editorSave(w, opened, amount('3600')));
    const r = await put('uA', w, editorSave(w, opened, d => d, { draft: left }));
    expect(r.status).toBe(409);
    expect(r.data.error.details).toMatchObject({ fields: ['money'] });
    expect((await entry(w)).amount).toBe(3600);
  });
});

describe('the group currency changed under the open form (editor side of A4-01)', () => {
  /** Abbie switches the group to JPY: NT$3,000 is now booked at the switch's rate. */
  async function switched() {
    const w = await world();
    const opened = await entry(w);
    expect((await api('uB', 'PATCH', '/api/groups/' + w.gid, { currency: 'JPY' })).status).toBe(200);
    const rebased = await entry(w);
    expect(rebased.fxRate).not.toBe(1);
    // The editor puts its rate right (its group currency effect: the stored, converted rate).
    const d = { ...draftFromExpense(opened, { memberIds: [w.A, w.B] }), fxStored: { rate: rebased.fxRate, currency: rebased.currency, date: rebased.date } };
    return { w, opened, rebased, d };
  }

  it('a money edit merges against the copy read in its own currency, and 復原 puts it back', async () => {
    const { w, opened, rebased, d } = await switched();
    const sent = editorSave(w, opened, amount('3600'), { draft: d, groupCurrency: 'JPY', openedBase: 'TWD' });
    expect(sent.base?.rateBase).toBe('TWD');
    const r = await put('uA', w, sent);
    expect(r.status).toBe(200);
    expect(r.data.expense).toMatchObject({ amount: 3600, currency: 'TWD', fxRate: rebased.fxRate });
    // 復原 from the copy the save was merged against, its rate for TWD: the server converts it as it did the entry.
    const u = await put('uA', w, undoOfEdit(sent, opened, 'TWD'));
    expect(u.status).toBe(200);
    expect(u.data.expense).toMatchObject({ amount: 3000, currency: 'TWD', fxRate: rebased.fxRate });
  });

  it('(as it was) its old rate read as a JPY rate made the same edit a 409', async () => {
    const { w, opened, d } = await switched();
    const r = await put('uA', w, editorSave(w, opened, amount('3600'), { draft: d, groupCurrency: 'JPY', openedBase: 'JPY' }));
    expect(r.status).toBe(409);
  });
});
