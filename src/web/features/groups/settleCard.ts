// 旅行結算圖卡 (the contract shared with the iPhone app, 2026-10-25, section 4): one picture of where
// a group stands, to send to LINE or Instagram. The device makes it from the group it already has,
// with no server call, so it shows only what every member can already see. This file works out what
// the card says and where its parts go, without the DOM (tests/web/settle-card.test.ts);
// settleCardDraw.ts draws it on a 1080 x 1350 canvas and SettleCardSheet.tsx shares it from 結算.
// The rules and the sizes follow the iPhone app's (Views/Settle/SettleCard.swift and
// SettleCardView.swift), so the two apps make the same card.

import { spendTotals } from '../../../shared/balances';
import type { Transfer } from '../../../shared/settle';
import type { GroupSnapshotDTO } from '../../../shared/types';
import { memberOrder, usableEntries } from './groupMath';

/** Someone on the card: a line of 誰付了多少, or either end of a payment in the plan. */
export interface CardPerson {
  id: string;
  /** The member's own name, for everyone (never 你 / you): the card is for the whole group. */
  name: string;
  /** The member's color (#RRGGBB), the fill of their initial's circle. */
  color: string;
  /** Group-currency minor units: what they paid and their share, expenses less refunds. */
  paid: number;
  share: number;
}

export interface CardPayment {
  from: CardPerson;
  to: CardPerson;
  amount: number;
}

export interface SettleCardData {
  emoji: string;
  name: string;
  color: string;
  /** A trip says 這趟總花費, other groups 總花費 (as 統計 does). */
  trip: boolean;
  currency: string;
  /** The first and the last day with an expense or a refund (payments do not count, as on 統計). */
  firstDate: string | null;
  lastDate: string | null;
  /** Expenses less refunds. */
  spent: number;
  people: CardPerson[];
  /** The people folded into 還有 N 人, with what they paid and their share added up. */
  morePeople: { count: number; paid: number; share: number } | null;
  /** The largest first (ties by key), at most TOP_CATEGORIES, each above zero. */
  categories: { key: string; amount: number }[];
  /** Empty when there is nothing to settle (大家都結清了！). */
  payments: CardPayment[];
  /** The payments folded into 還有 N 筆. */
  morePayments: number;
}

/** The most lines each list takes; past them the last line says how many more there are. */
export const PEOPLE_LINES = 8;
export const PAYMENT_LINES = 6;
export const TOP_CATEGORIES = 3;

/**
 * What the card says about a group as this device has it now (unsynced entries count). `plan` is
 * the settle-up plan 結算 shows next to the button. People come in the group's order; members who
 * left stay on it while something they paid or shared counts.
 */
export function settleCardData(snap: GroupSnapshotDTO, plan: readonly Transfer[]): SettleCardData {
  const currency = snap.group.currency;
  const entries = usableEntries(snap.expenses, currency);
  const totals = spendTotals(entries, currency);
  let firstDate: string | null = null;
  let lastDate: string | null = null;
  for (const e of entries) {
    if (e.kind === 'payment' || !e.date) continue;
    if (!firstDate || e.date < firstDate) firstDate = e.date;
    if (!lastDate || e.date > lastDate) lastDate = e.date;
  }

  const byId = new Map(snap.members.map(m => [m.id, m]));
  const person = (id: string): CardPerson => {
    const m = byId.get(id);
    return { id, name: m?.name ?? '?', color: m?.color ?? '', paid: totals.paid[id] ?? 0, share: totals.share[id] ?? 0 };
  };
  const everyone = memberOrder(snap.members)
    .filter(id => byId.get(id)?.active || (totals.paid[id] ?? 0) !== 0 || (totals.share[id] ?? 0) !== 0)
    .map(person);
  let people = everyone;
  let morePeople: SettleCardData['morePeople'] = null;
  if (everyone.length > PEOPLE_LINES) {
    people = everyone.slice(0, PEOPLE_LINES - 1);
    const rest = everyone.slice(PEOPLE_LINES - 1);
    morePeople = { count: rest.length, paid: rest.reduce((a, p) => a + p.paid, 0), share: rest.reduce((a, p) => a + p.share, 0) };
  }

  const categories = Object.entries(totals.byCategory)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, TOP_CATEGORIES)
    .map(([key, amount]) => ({ key, amount }));

  const all = plan.map(t => ({ from: person(t.from), to: person(t.to), amount: t.amount }));
  const payments = all.length > PAYMENT_LINES ? all.slice(0, PAYMENT_LINES - 1) : all;

  return {
    emoji: snap.group.emoji,
    name: snap.group.name,
    color: snap.group.color,
    trip: snap.group.type === 'trip',
    currency,
    firstDate,
    lastDate,
    spent: totals.spent,
    people,
    morePeople,
    categories,
    payments,
    morePayments: all.length - payments.length,
  };
}

/** How many lines of people the card draws (the folded line counts as one). */
export function peopleLineCount(c: SettleCardData): number {
  return c.people.length + (c.morePeople ? 1 : 0);
}

/** How many lines of payments the card draws (the folded line counts as one), 0 when settled up. */
export function paymentLineCount(c: SettleCardData): number {
  return c.payments.length + (c.morePayments > 0 ? 1 : 0);
}

// ---------- where the parts go (px on the 1080 x 1350 picture) ----------

export const CARD_W = 1080;
export const CARD_H = 1350;

export const LAYOUT = {
  margin: 52,
  /** The cards' outline, and the thin one of tiles, circles and stamps. */
  line: 6,
  thin: 4,
  radius: 44,
  header: 112,
  summary: 220,
  /** A card's title line, and the room above and below its lines. */
  title: 50,
  pad: 18,
  /** 大家都結清了！'s place in 怎麼結清. */
  settled: 121,
  /** The hill, and the part of the picture under the last card that is left to it. */
  hill: 180,
  ground: 104,
  /** The header keeps clear of the mascot, which stands at the summary card's right. */
  mascotRoom: 174,
  mascotTallest: 176,
} as const;

export interface CardLayout {
  /** One line of people or payments. */
  row: number;
  /** The heights of 誰付了多少 and 怎麼結清. */
  people: number;
  plan: number;
  /** The room above the header, and between the cards. */
  top: number;
  gap: number;
  /** Where the summary card starts (the mascot stands on it). */
  summaryTop: number;
  /** The initials' circles. */
  avatar: number;
  /** The mascot's height. */
  mascot: number;
}

/**
 * Rows get shorter as the lists get longer, so 8 lines of people and 6 of payments still fit above
 * the hill with the text at its size; the room left over goes evenly above the header, between the
 * cards and above the hill.
 */
export function cardLayout(c: SettleCardData): CardLayout {
  const L = LAYOUT;
  const peopleLines = peopleLineCount(c);
  const paymentLines = paymentLineCount(c);
  const lines = peopleLines + paymentLines;
  const row = lines <= 4 ? 72 : lines <= 7 ? 62 : lines <= 10 ? 54 : 45;
  const people = 2 * L.pad + L.title + peopleLines * row;
  const plan = 2 * L.pad + L.title + (c.payments.length === 0 ? L.settled : paymentLines * row);
  const spare = CARD_H - L.ground - L.header - L.summary - people - plan;
  // At least 28 above the header and 16 between the cards; the rest shared out in fifths (above
  // the header, the three gaps, and above the hill).
  const extra = Math.max(0, spare - 28 - 3 * 16);
  const top = 28 + extra / 5;
  const gap = 16 + extra / 5;
  const summaryTop = top + L.header + gap;
  return { row, people, plan, top, gap, summaryTop, avatar: Math.min(48, row - 6), mascot: Math.min(L.mascotTallest, summaryTop - 12) };
}

// ---------- words ----------

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The days a group's entries span: 「2026/10/9～10/11」, 「2026/10/9」 for one day, the year again
 * when it changes; "Oct 9 to Oct 11, 2026", "Oct 9, 2026", "Dec 30, 2026 to Jan 2, 2027".
 */
export function cardDateRange(first: string, last: string, zh: boolean): string {
  const parse = (d: string) => ({ y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)), d: Number(d.slice(8, 10)) });
  const a = parse(first);
  const b = parse(last);
  const sameYear = a.y === b.y;
  if (zh) {
    const full = (x: typeof a) => `${x.y}/${x.m}/${x.d}`;
    if (first === last) return full(a);
    return full(a) + '～' + (sameYear ? `${b.m}/${b.d}` : full(b));
  }
  const md = (x: typeof a) => `${MONTHS_EN[x.m - 1] ?? x.m} ${x.d}`;
  const full = (x: typeof a) => `${md(x)}, ${x.y}`;
  if (first === last) return full(a);
  return (sameYear ? md(a) : full(a)) + ' to ' + full(b);
}

/** 「北海道滑雪 結算圖卡.png」 / "Hokkaido ski summary card.png", without what a file name cannot hold. */
export function cardFileName(name: string, zh: boolean, appName: string): string {
  const clean = name.replace(/[\\/:?*"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  const base = Array.from(clean || appName).slice(0, 60).join('').trim();
  return zh ? `${base} 結算圖卡.png` : `${base} summary card.png`;
}

/** A person's initial on the card: the first character of their name, upper case ("?" without one). */
export function cardInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '?';
}

// ---------- colors (design/tokens.css, as hex: a canvas reads no CSS variables) ----------

export const CARD_COLORS = {
  paper: '#FFFCF6',
  ink: '#3E3A39',
  ink2: '#6B6461',
  sky: '#A8D3E6',
  skyTint: '#E6F2F8',
  yolkTint: '#FCF1D3',
  grass: '#B9DAA5',
  pencil: '#CFC8C3',
} as const;

/** A member or group color mixed into paper, as the app's avatars do (color-mix 30%). */
export function cardTint(hex: string, share = 0.3): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return CARD_COLORS.yolkTint;
  const v = parseInt(m[1], 16);
  const paper = [255, 252, 246];
  const rgb = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c, i) => Math.round(paper[i] + (c - paper[i]) * share));
  return '#' + rgb.map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** A category circle's fill: yolk for food, fun, home and life, sky for getting around and bills, else paper. */
export function cardCategoryFill(parent: string): string {
  switch (parent) {
    case 'food':
    case 'entertainment':
    case 'home':
    case 'life':
      return CARD_COLORS.yolkTint;
    case 'transport':
    case 'travel':
    case 'utilities':
      return CARD_COLORS.skyTint;
    default:
      return CARD_COLORS.paper;
  }
}
