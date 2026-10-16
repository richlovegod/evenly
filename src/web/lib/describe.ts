// Sentences about expenses and people, shared by every page so the wording stays consistent.

import { splitParticipants, type SplitInput } from '../../shared/split';
import type { ExpenseDTO, MemberDTO } from '../../shared/types';
import { money, t } from './i18n';

/** "你" / "You" for me, else the member's name (or a fallback when unknown). */
export function nameOf(memberId: string, members: Record<string, MemberDTO>, meId?: string, opts: { lower?: boolean } = {}): string {
  if (meId && memberId === meId) return opts.lower ? t('你', 'you') : t('你', 'You');
  return members[memberId]?.name ?? t('（已移除）', '(removed)');
}

/** Chinese text needs a space between a Latin name and the next Chinese word ("Tiffany 付了"), not after "你". */
export function zhJoin(name: string, rest: string): string {
  return /[A-Za-z0-9)]$/.test(name) ? name + ' ' + rest : name + rest;
}

/** "你付了 ¥12,600" / "Tiffany 付了 ¥5,793" / "2 人付了 ¥38,028". */
export function paidLine(e: ExpenseDTO, members: Record<string, MemberDTO>, meId?: string): string {
  const amt = money(e.amount, e.currency);
  if (e.payers.length === 1) {
    const who = nameOf(e.payers[0].memberId, members, meId);
    return t(zhJoin(who, '付了 {amt}'), '{who} paid {amt}', { who, amt });
  }
  return t('{n} 人付了 {amt}', '{n} people paid {amt}', { n: e.payers.length, amt });
}

/** For payments: "Leo 付給你 ¥236,222" / "You paid Abbie US$50.00". */
export function paymentLine(e: ExpenseDTO, members: Record<string, MemberDTO>, meId?: string): string {
  const from = e.payers[0]?.memberId ?? '';
  const to = e.shares[0]?.memberId ?? e.split.entries[0]?.memberId ?? '';
  const amt = money(e.amount, e.currency);
  const a = nameOf(from, members, meId);
  const b = nameOf(to, members, meId, { lower: true });
  const zh = zhJoin(a, '付給') + (/^[A-Za-z0-9(]/.test(b) ? ' ' : '') + b + ' ' + amt;
  return t(zh, '{a} paid {b} {amt}', { a, b, amt });
}

const METHOD_ZH: Record<SplitInput['method'], string> = {
  equal: '平均分',
  exact: '依金額分',
  percent: '依比例分',
  shares: '依份數分',
  adjust: '加減調整',
  items: '依品項分',
};
const METHOD_EN: Record<SplitInput['method'], string> = {
  equal: 'Split equally',
  exact: 'Split by exact amounts',
  percent: 'Split by percentages',
  shares: 'Split by shares',
  adjust: 'Split by adjustment',
  items: 'Split by item',
};

export function methodLabel(method: SplitInput['method']): string {
  return t(METHOD_ZH[method], METHOD_EN[method]);
}

/** "平均分給 6 人" / "Split equally among 6", "依份數分給 4 人" / "Split by shares among 4". */
export function splitLine(split: SplitInput, totalMembers?: number): string {
  const n = splitParticipants(split).length;
  if (split.method === 'equal' && totalMembers && n === totalMembers) {
    return t('平均分給全部 {n} 人', 'Split equally among all {n}', { n });
  }
  return t(METHOD_ZH[split.method] + '給 {n} 人', METHOD_EN[split.method] + ' among {n}', { n });
}

export function repeatLabel(r: ExpenseDTO['repeat']): string {
  switch (r) {
    case 'weekly': return t('每週', 'Weekly');
    case 'biweekly': return t('每兩週', 'Every 2 weeks');
    case 'monthly': return t('每月', 'Monthly');
    case 'yearly': return t('每年', 'Yearly');
    default: return t('不重複', 'Never');
  }
}

/** Members sorted the way pickers show them: me first, then active by sort order. */
export function orderedMembers(members: readonly MemberDTO[], meId?: string, includeInactive = false): MemberDTO[] {
  return members
    .filter(m => includeInactive || m.active)
    .slice()
    .sort((a, b) => (a.id === meId ? -1 : b.id === meId ? 1 : a.sort - b.sort || (a.createdAt < b.createdAt ? -1 : 1)));
}

/** Initials for an avatar: first character for CJK names, else first letters of up to two words. */
export function initials(name: string): string {
  const s = name.trim();
  if (!s) return '?';
  const first = [...s][0];
  if (/[㐀-鿿豈-﫿぀-ヿ가-힯]/.test(first)) return first;
  const words = s.split(/\s+/).filter(Boolean);
  const a = [...words[0]][0] ?? '';
  const b = words.length > 1 ? [...words[words.length - 1]][0] ?? '' : '';
  return (a + b).toUpperCase();
}
