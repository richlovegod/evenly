// The words of a push notification, written on the server in the recipient's language. Sentences
// and spacing follow the activity feed (src/web/features/activity/activityText.ts) and the effect
// words of src/web/components/Money.tsx (rowEffect); tests/worker/push-sender.test.ts compares
// the sentences the two share with the feed's own code. Wording: docs/PLAN-push-scan-cookies.md
// section 2.4.

import { formatMoney } from '../../shared/money';
import type { Locale, PushPayload } from '../../shared/types';

/** Someone as a notification names them. `id` is their member id, so the recipient reads 你 / you. */
export interface PushPerson {
  id: string | null;
  name: string;
}

/** One thing that happened in a group, the same for every recipient (services/push.ts builds them). */
export type PushItem =
  /** A new expense, with its last values when it was edited before the push went out. */
  | {
      kind: 'expense';
      actor: PushPerson;
      expenseId: string;
      description: string;
      /** As entered (minor units of `currency`). */
      amount: number | null;
      currency: string;
      /** Each involved member's effect in the group currency (positive = gets money back). */
      nets: Record<string, number>;
      groupCurrency: string;
    }
  /** A new payment from `from` to `to` (amount as entered). */
  | { kind: 'payment'; actor: PushPerson; expenseId: string; from: PushPerson; to: PushPerson; amount: number | null; currency: string }
  /** Someone joined, or took over a member already on the list. */
  | { kind: 'join'; name: string }
  /** The recipient was added to the group. */
  | { kind: 'add'; actor: PushPerson }
  /** The group (or the 1:1 ledger) was created with the recipient in it. */
  | { kind: 'create'; actor: PushPerson }
  /** A Splitwise import. */
  | { kind: 'import'; actor: PushPerson; count: number };

export interface PushGroup {
  id: string;
  name: string;
  emoji: string;
  /** 'pair' is a 1:1 friend ledger. */
  type: string;
}

export interface PushNotice {
  payload: PushPayload;
  urgency: 'normal' | 'low';
}

/** src/web/lib/brand.ts */
const APP_NAME = { zh: '吉諾分帳所', en: "Gino's Split Lab" };
const TITLE_MAX = 100;
const LINE_MAX = 240;

interface Lang {
  zh: boolean;
  locale: Locale;
}

const tr = (l: Lang, zh: string, en: string): string => (l.zh ? zh : en);

/** Chinese needs a space between a Latin name and the next Chinese word ("Abbie 新增了"), not after "你". */
function zhJoin(name: string, rest: string): string {
  return /[A-Za-z0-9)]$/.test(name) ? name + ' ' + rest : name + rest;
}

/** Chinese text followed by a name: a space only before a Latin name ("付給 Leo", "付給佳穎"). */
function zhThen(text: string, name: string): string {
  return text + (/^[A-Za-z0-9(]/.test(name) ? ' ' : '') + name;
}

/** 「燒肉晚餐」 / "Korean BBQ dinner", or 一筆費用 / an expense without a description. */
function quoted(l: Lang, desc: string): string {
  const d = desc.trim();
  if (!d) return tr(l, '一筆費用', 'an expense');
  return l.zh ? '「' + d + '」' : '"' + d + '"';
}

function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s;
}

function money(l: Lang, minor: number | null, currency: string, abs = false): string {
  if (typeof minor !== 'number' || !Number.isFinite(minor) || !currency) return '';
  return formatMoney(minor, currency, l.locale, abs ? { sign: 'never' } : {});
}

const someone = (l: Lang, name: string): string => name.trim() || tr(l, '有人', 'Someone');

function personName(l: Lang, p: PushPerson, myMemberId: string): string {
  if (p.id && p.id === myMemberId) return tr(l, '你', 'you');
  return p.name.trim() || tr(l, '（已移除）', '(removed)');
}

/** The first line for one item. */
function sentence(l: Lang, item: PushItem, myMemberId: string, pair: boolean): string {
  switch (item.kind) {
    case 'expense': {
      const actor = someone(l, item.actor.name);
      const amt = money(l, item.amount, item.currency);
      return l.zh
        ? zhJoin(actor, '新增了') + quoted(l, item.description) + (amt ? ' ' + amt : '')
        : actor + ' added ' + quoted(l, item.description) + (amt ? ' (' + amt + ')' : '');
    }
    case 'payment': {
      // The recipient is the sender or the recipient, so the amount is on the second line.
      const actor = someone(l, item.actor.name);
      const from = personName(l, item.from, myMemberId);
      const to = personName(l, item.to, myMemberId);
      if (item.actor.id && item.actor.id === item.from.id) {
        // 「Leo 記錄了付給你的還款」 / "Leo recorded a payment to you"
        return l.zh ? zhThen(zhJoin(actor, '記錄了付給'), zhJoin(to, '的還款')) : actor + ' recorded a payment to ' + to;
      }
      if (item.actor.id && item.actor.id === item.to.id) {
        // 「Leo 記錄了你的還款」 / "Leo recorded a payment from you"
        return l.zh ? zhThen(zhJoin(actor, '記錄了'), zhJoin(from, '的還款')) : actor + ' recorded a payment from ' + from;
      }
      // 「Kevin 記錄了還款：Leo 付給你」 / "Kevin recorded a payment: Leo paid you"
      return l.zh
        ? zhJoin(actor, '記錄了還款：') + zhThen(zhJoin(from, '付給'), to)
        : actor + ' recorded a payment: ' + (from === 'you' ? 'You' : from) + ' paid ' + to;
    }
    case 'join': {
      const who = someone(l, item.name);
      return l.zh ? zhJoin(who, '加入了群組') : who + ' joined the group';
    }
    case 'add': {
      const actor = someone(l, item.actor.name);
      return l.zh ? zhJoin(actor, '把你加進了群組') : actor + ' added you to the group';
    }
    case 'create': {
      const actor = someone(l, item.actor.name);
      if (pair) return l.zh ? zhJoin(actor, '開始了跟你的兩人帳本') : actor + ' started a ledger with you';
      return l.zh ? zhJoin(actor, '建立了群組，也把你加了進去') : actor + ' created the group and added you';
    }
    case 'import': {
      const actor = someone(l, item.actor.name);
      return l.zh ? zhJoin(actor, '匯入了 ' + item.count + ' 筆費用') : actor + ' imported ' + item.count + (item.count === 1 ? ' entry' : ' entries');
    }
  }
}

/** 你借出 ¥X / 你借入 ¥X / 剛好平衡 for my net in the group currency (rowEffect). */
function netLine(l: Lang, net: number, currency: string): string {
  const amt = money(l, net, currency, true);
  if (net > 0) return tr(l, '你借出 ' + amt, 'You lent ' + amt);
  if (net < 0) return tr(l, '你借入 ' + amt, 'You borrowed ' + amt);
  return tr(l, '剛好平衡', 'Even');
}

/** The second line for one item: what it means for the recipient, when it is about money. */
function effect(l: Lang, item: PushItem, myMemberId: string): string | null {
  if (item.kind === 'expense') {
    const net = item.nets[myMemberId];
    return typeof net === 'number' && item.groupCurrency ? netLine(l, net, item.groupCurrency) : null;
  }
  if (item.kind === 'payment') {
    const amt = money(l, item.amount, item.currency, true);
    if (!amt) return null;
    if (item.from.id === myMemberId) return tr(l, '你付出 ' + amt, 'You sent ' + amt);
    if (item.to.id === myMemberId) return tr(l, '你收到 ' + amt, 'You received ' + amt);
  }
  return null;
}

function list(l: Lang, names: string[]): string {
  if (l.zh) return names.join('、');
  return names.length === 2 ? names[0] + ' and ' + names[1] : names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
}

/** First and second line for several items in one group. */
function summary(l: Lang, items: readonly PushItem[], myMemberId: string, pair: boolean): [string, string | null] {
  const n = items.length;
  const entries = items.filter((i): i is Extract<PushItem, { kind: 'expense' | 'payment' }> => i.kind === 'expense' || i.kind === 'payment');
  if (entries.length === n) {
    const actors = new Set(entries.map(i => i.actor.id ?? i.actor.name));
    if (actors.size === 1) {
      const actor = someone(l, entries[0].actor.name);
      if (entries.every(i => i.kind === 'payment')) {
        return [l.zh ? zhJoin(actor, '記錄了 ' + n + ' 筆還款') : actor + ' recorded ' + n + ' payments', null];
      }
      // 「Abbie 新增了 3 筆費用」 / "Abbie added 3 entries", and the recipient's total for expenses only.
      const line = l.zh ? zhJoin(actor, '新增了 ' + n + ' 筆費用') : actor + ' added ' + n + ' entries';
      let sum = 0;
      let currency = '';
      let any = false;
      for (const i of entries) {
        if (i.kind !== 'expense') return [line, null];
        const v = i.nets[myMemberId];
        if (typeof v !== 'number') continue;
        if (currency && i.groupCurrency !== currency) return [line, null];
        currency = i.groupCurrency;
        sum += v;
        any = true;
      }
      return [line, any && currency ? netLine(l, sum, currency) : null];
    }
  }
  const joins = items.filter((i): i is Extract<PushItem, { kind: 'join' }> => i.kind === 'join');
  if (joins.length === n) {
    const names = [...new Set(joins.map(i => someone(l, i.name)))];
    if (names.length === 1) return [sentence(l, joins[0], myMemberId, pair), null];
    if (names.length <= 3) {
      const who = list(l, names);
      return [l.zh ? zhJoin(who, '加入了群組') : who + ' joined the group', null];
    }
    return [
      l.zh ? zhJoin(names[0], '等 ' + names.length + ' 人加入了群組') : names[0] + ' and ' + (names.length - 1) + ' others joined the group',
      null,
    ];
  }
  // Mixed: the first thing that happened, and how many more there are.
  const more = n - 1;
  return [sentence(l, items[0], myMemberId, pair), l.zh ? '還有 ' + more + ' 筆新動態' : 'and ' + more + (more === 1 ? ' more update' : ' more updates')];
}

function title(l: Lang, group: PushGroup): string {
  if (group.type === 'pair') return tr(l, '兩人帳本', 'Friend ledger');
  const name = group.name.trim();
  if (!name) return tr(l, APP_NAME.zh, APP_NAME.en);
  const emoji = group.emoji.trim();
  return clip(emoji ? emoji + ' ' + name : name, TITLE_MAX);
}

function groupPath(gid: string): string {
  return '/g/' + encodeURIComponent(gid);
}

/**
 * The one notification a recipient gets for these items of one group (oldest first). One item
 * gets its own sentence and, for money, the effect line; several get a summary. Tapping opens the
 * entry for one expense or payment, else the group. null when there is nothing to say.
 */
export function pushNotice(group: PushGroup, items: readonly PushItem[], me: { memberId: string; locale: Locale }): PushNotice | null {
  if (!items.length) return null;
  const l: Lang = { zh: me.locale !== 'en', locale: me.locale === 'en' ? 'en' : 'zh-TW' };
  const pair = group.type === 'pair';
  let first: string;
  let second: string | null;
  let path = groupPath(group.id);
  if (items.length === 1) {
    const item = items[0];
    first = sentence(l, item, me.memberId, pair);
    second = effect(l, item, me.memberId);
    if (item.kind === 'expense' || item.kind === 'payment') path += '/e/' + encodeURIComponent(item.expenseId);
  } else {
    [first, second] = summary(l, items, me.memberId, pair);
  }
  const body = clip(first, LINE_MAX) + (second ? '\n' + clip(second, LINE_MAX) : '');
  return {
    payload: { title: title(l, group), body, path, tag: 'g:' + group.id },
    urgency: items.every(i => i.kind === 'import') ? 'low' : 'normal',
  };
}

/** POST /api/push/test: proof that this account's devices get notifications. */
export function testNotice(locale: Locale): PushNotice {
  const l: Lang = { zh: locale !== 'en', locale };
  return {
    payload: {
      title: tr(l, APP_NAME.zh, APP_NAME.en),
      body: tr(l, '測試通知：看得到這則，就表示這台裝置收得到通知。', 'Test notification: if you can see this, notifications work on this device.'),
      path: '/account',
      tag: 'test',
    },
    urgency: 'normal',
  };
}
