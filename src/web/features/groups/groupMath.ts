// Group numbers for the group page, computed on the device from the merged view (server data plus
// unsynced local changes), so an entry saved offline counts at once. Settle-up plans, the "why" of
// each balance and the plain-text summary people paste into LINE.

import { toBase, type LedgerEntry } from '../../../shared/balances';
import { hubPlan, pairwiseDebts, simplifyDebts, type Transfer } from '../../../shared/settle';
import { computeGroupSummary, type GroupSummary } from '../../../shared/summary';
import type { ExpenseDTO, GroupSnapshotDTO, MemberDTO } from '../../../shared/types';
import { zhJoin } from '../../lib/describe';
import { money, t } from '../../lib/i18n';

/** Member ids in the order the server uses for plans (sort, then join time, then id). */
export function memberOrder(members: readonly MemberDTO[]): string[] {
  return [...members]
    .sort((a, b) => a.sort - b.sort || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id))
    .map(m => m.id);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function addsUp(list: readonly { amount: number }[] | undefined, total: number): boolean {
  if (!Array.isArray(list) || list.length === 0) return false;
  let sum = 0;
  for (const p of list) {
    if (!p || !Number.isSafeInteger(p.amount)) return false;
    sum += p.amount;
  }
  return sum === total;
}

/**
 * Live entries the balance math can use. An unsynced entry whose split does not add up (the
 * server would reject it) is left out instead of throwing off every number on the page.
 */
export function usableEntries(expenses: readonly ExpenseDTO[], base: string): ExpenseDTO[] {
  return expenses.filter(e => {
    if (e.deletedAt) return false;
    if (!Number.isSafeInteger(e.amount) || e.amount <= 0) return false;
    if (!addsUp(e.payers, e.amount) || !addsUp(e.shares, e.amount)) return false;
    try {
      toBase(e, base);
      return true;
    } catch {
      return false;
    }
  });
}

/** The group's numbers, exactly as the server computes them, from the merged view. */
export function summarize(snap: GroupSnapshotDTO): GroupSummary {
  const base = snap.group.currency;
  return computeGroupSummary({
    currency: base,
    simplify: snap.group.simplify,
    memberOrder: memberOrder(snap.members),
    entries: usableEntries(snap.expenses, base),
    forVersion: snap.group.version,
  });
}

export interface PaymentFlows {
  /** Payments each member sent, group-currency minor units. */
  sent: Record<string, number>;
  /** Payments each member received. */
  received: Record<string, number>;
}

/** Settle-up payments per member in the group currency (expenses are in GroupSummary.paid/share). */
export function paymentFlows(entries: readonly LedgerEntry[], base: string): PaymentFlows {
  const out: PaymentFlows = { sent: {}, received: {} };
  for (const e of entries) {
    if (e.deletedAt || e.kind !== 'payment') continue;
    const b = toBase(e, base);
    for (const p of b.paid) out.sent[p.memberId] = (out.sent[p.memberId] ?? 0) + p.amount;
    for (const o of b.owed) out.received[o.memberId] = (out.received[o.memberId] ?? 0) + o.amount;
  }
  return out;
}

export type PlanMode = 'simplified' | 'pairwise' | 'hub';

/** The transfers for a plan mode. 'hub' needs a hub member; without one it falls back to the group setting. */
export function settlePlan(snap: GroupSnapshotDTO, summary: GroupSummary, mode: PlanMode, hub: string | null): Transfer[] {
  const order = memberOrder(snap.members);
  if (mode === 'hub' && hub) return hubPlan(summary.net, hub, order);
  const simplify = mode === 'hub' ? snap.group.simplify : mode === 'simplified';
  if (simplify) return simplifyDebts(summary.net, order);
  const base = snap.group.currency;
  return pairwiseDebts(usableEntries(snap.expenses, base), base, order);
}

/** Default person to settle through: me when I paid the most, else whoever paid the most. */
export function defaultHub(snap: GroupSnapshotDTO, summary: GroupSummary): string {
  const meId = snap.me.memberId;
  let best = meId;
  let bestPaid = summary.paid[meId] ?? 0;
  const active = new Set(snap.members.filter(m => m.active).map(m => m.id));
  for (const id of memberOrder(snap.members)) {
    if (!active.has(id)) continue;
    const paid = summary.paid[id] ?? 0;
    if (paid > bestPaid) {
      best = id;
      bestPaid = paid;
    }
  }
  return best;
}

// ---------- the 集中還給 choice, remembered per group on this device ----------

const PLAN_KEY = 'evenly.plan.';

export interface HubChoice {
  /** Settle through one person instead of the group's setting. */
  on: boolean;
  /** The person chosen last time (kept while the mode is off, so turning it back on remembers). */
  hub: string | null;
}

export function loadHubChoice(gid: string): HubChoice {
  try {
    const raw = localStorage.getItem(PLAN_KEY + gid);
    if (!raw) return { on: false, hub: null };
    const v = JSON.parse(raw) as { on?: unknown; hub?: unknown };
    return { on: v.on === true, hub: typeof v.hub === 'string' ? v.hub : null };
  } catch {
    return { on: false, hub: null };
  }
}

export function saveHubChoice(gid: string, choice: HubChoice): void {
  try {
    if (!choice.on && !choice.hub) localStorage.removeItem(PLAN_KEY + gid);
    else localStorage.setItem(PLAN_KEY + gid, JSON.stringify(choice));
  } catch {
    /* storage unavailable: the choice lasts for this visit only */
  }
}

/** The plan this device shows for a group: the group's setting, or 集中還給 when chosen here. */
export function currentPlan(snap: GroupSnapshotDTO, summary: GroupSummary): Transfer[] {
  const choice = loadHubChoice(snap.group.id);
  if (!choice.on) return settlePlan(snap, summary, snap.group.simplify ? 'simplified' : 'pairwise', null);
  const ok = choice.hub && snap.members.some(m => m.id === choice.hub && m.active);
  return settlePlan(snap, summary, 'hub', ok ? choice.hub : defaultHub(snap, summary));
}

// ---------- text ----------

/** "A 付給 B" with the spacing Chinese needs around Latin names; "A pays B" in English. */
export function paysLine(a: string, b: string, amount: string): string {
  const zh = zhJoin(a, '付給') + (/^[A-Za-z0-9(]/.test(b) ? ' ' : '') + b + ' ' + amount;
  return t(zh, a + ' pays ' + b + ' ' + amount);
}

export interface PayLine {
  label: string;
  value: string;
  /** What 複製 copies. */
  copy: string;
  /** Print the value in the money font (handles). */
  mono: boolean;
}

/** A member's payment details as labeled lines (Venmo, PayPal, free text such as a bank or LINE Pay note). */
export function payLines(m: Pick<MemberDTO, 'venmo' | 'paypal' | 'payInfo'>): PayLine[] {
  const out: PayLine[] = [];
  if (m.venmo) out.push({ label: 'Venmo', value: '@' + m.venmo, copy: m.venmo, mono: true });
  if (m.paypal) out.push({ label: 'PayPal', value: 'paypal.me/' + m.paypal, copy: 'https://paypal.me/' + m.paypal, mono: true });
  const info = m.payInfo.trim();
  if (info) out.push({ label: t('其他', 'Other'), value: info, copy: info, mono: false });
  return out;
}

/** One line of someone's payment details for plain text: "Venmo @gino、PayPal.me/gino、台新 812..." */
export function payDetailsText(m: Pick<MemberDTO, 'venmo' | 'paypal' | 'payInfo'>): string {
  const parts: string[] = [];
  if (m.venmo) parts.push('Venmo @' + m.venmo);
  if (m.paypal) parts.push('PayPal paypal.me/' + m.paypal);
  const info = m.payInfo.trim().replace(/\s*\n+\s*/g, t('，', ', '));
  if (info) parts.push(info);
  return parts.join(t('、', ', '));
}

/**
 * The settle-up summary sent to the group chat, e.g.
 * "Niseko 滑雪 2026 結算\nAbbie 付給 Gino ¥12,000\n...", with each receiver's payment details.
 * Uses real names (never "你"): the text is read by everyone in the group.
 */
export function settleShareText(snap: GroupSnapshotDTO, plan: readonly Transfer[]): string {
  const cur = snap.group.currency;
  const byId = new Map(snap.members.map(m => [m.id, m]));
  const name = (id: string) => byId.get(id)?.name ?? t('（已移除）', '(removed)');
  const lines: string[] = [t(snap.group.name + ' 結算', snap.group.name + ': settle up')];
  if (plan.length === 0) {
    lines.push(t('大家都結清了。', 'Everyone is settled up.'));
    return lines.join('\n');
  }
  for (const tr of plan) lines.push(paysLine(name(tr.from), name(tr.to), money(tr.amount, cur)));
  const receivers: string[] = [];
  for (const tr of plan) if (!receivers.includes(tr.to)) receivers.push(tr.to);
  const details = receivers
    .map(id => {
      const m = byId.get(id);
      const text = m ? payDetailsText(m) : '';
      return text ? t(name(id) + '：' + text, name(id) + ': ' + text) : '';
    })
    .filter(Boolean);
  if (details.length) {
    lines.push('');
    lines.push(t('收款方式', 'How to pay'));
    lines.push(...details);
  }
  return lines.join('\n');
}
