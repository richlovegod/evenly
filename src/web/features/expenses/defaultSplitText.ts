// Wording for a group's default split (docs/SPEC.md section 4, Default split), in both languages:
// on 設定, in the expense editor and in the activity feed. Only i18n here (no API, no storage), so
// the feed's sentences, which the Worker's push tests compare with, stay importable in Node.

import type { SplitErrorCode, SplitMethod } from '../../../shared/split';
import { zhJoin } from '../../lib/describe';
import { t } from '../../lib/i18n';

/** The method's word, as on the split sheet's tabs (平均 / 比例 / 份數). */
function methodWord(m: SplitMethod): string {
  switch (m) {
    case 'equal': return t('平均', 'Equally');
    case 'percent': return t('比例', 'Percent');
    case 'shares': return t('份數', 'Shares');
    case 'exact': return t('金額', 'Exact');
    case 'adjust': return t('加減', 'Adjust');
    case 'items': return t('品項', 'By item');
  }
}

/** Names in a list: 「你、Abbie」 / "you, Abbie". */
function nameList(names: readonly string[]): string {
  return names.join(t('、', ', '));
}

/**
 * A default split in words: 「平均：你、Abbie」, 「比例：你 60%、Abbie 40%」, 「份數：你 2、Abbie 1」
 * (English "Equally: you, Abbie", "Percent: you 60%, Abbie 40%", "Shares: you 2, Abbie 1").
 * `nameOf` gives 你 / you for me.
 */
export function defaultSplitSummary(d: { method: SplitMethod; entries: { memberId: string; value?: number | null }[] }, nameOf: (memberId: string) => string): string {
  const people = d.entries.map(e => {
    const n = nameOf(e.memberId);
    // One space between a name and its number, in both languages (DESIGN.md 13.2).
    if (d.method === 'percent') return n + ' ' + String(e.value ?? 0) + '%';
    if (d.method === 'shares') return n + ' ' + String(e.value ?? 0);
    return n;
  });
  return t('{m}：{p}', '{m}: {p}', { m: methodWord(d.method), p: nameList(people) });
}

/**
 * Who pays by default: 「新增的人付款」 / "Whoever adds it pays", 「你付款」 / "You pay" when it is
 * me (`meId`), or 「Abbie 付款」 / "Abbie pays".
 */
export function defaultPayerText(payerId: string | null, nameOf: (memberId: string) => string, meId?: string | null): string {
  if (!payerId) return t('新增的人付款', 'Whoever adds it pays');
  if (meId && payerId === meId) return t('你付款', 'You pay');
  const n = nameOf(payerId);
  return t(zhJoin(n, '付款'), '{n} pays', { n });
}

/**
 * Why a default is not used as it is (shared/defaultSplit.ts applyDefaultSplit): members who joined
 * after it was set (「新成員不在預設分法裡：Kevin」), or what remains no longer adds up (a member who
 * was in a 比例 default left). null when there is nothing to say.
 */
export function defaultSplitNote(
  applied: { newMembers: readonly string[]; problem: { code: SplitErrorCode; diff?: number } | null } | null,
  nameOf: (memberId: string) => string,
  where: 'editor' | 'settings',
): string | null {
  if (!applied) return null;
  if (applied.problem) {
    const tail = where === 'editor' ? t('，這筆先平均分', ', so this one is split equally') : t('，新的費用會先平均分', ', so new expenses are split equally');
    if (applied.problem.code === 'percent_mismatch') {
      return t('預設分法的比例加起來不是 100%（有人離開了）', "The default split's percentages no longer add up to 100% (someone left)") + tail;
    }
    return t('預設分法裡的人都不在群組了', 'Nobody in the default split is in the group any more') + tail;
  }
  if (applied.newMembers.length) {
    const names = applied.newMembers.map(nameOf);
    return t('新成員不在預設分法裡：{n}', names.length === 1 ? 'A new member is not in the default split: {n}' : 'New members are not in the default split: {n}', { n: nameList(names) });
  }
  return null;
}
