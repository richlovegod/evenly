// Activity feed sentences: who did what, in which group, and what it meant for me.

import { categoryLabel } from '../../../shared/categories';
import { refundSubject } from '../../../shared/refunds';
import type { ActivityDTO, ExpenseKind, MeDTO } from '../../../shared/types';
import { repeatLabel, zhJoin } from '../../lib/describe';
import { formatDate, getLocale, money, t } from '../../lib/i18n';
import { defaultSplitSummary } from '../expenses/defaultSplitText';
import { expensePath, groupPath } from '../groups/links';

export interface ActivityContext {
  meUserId: string;
  /** groupId -> memberId -> name (from the dashboard). */
  names: Record<string, Record<string, string>>;
  /** groupId -> my member id there. */
  myMember: Record<string, string>;
}

export function activityContext(me: MeDTO): ActivityContext {
  const names: ActivityContext['names'] = {};
  const myMember: ActivityContext['myMember'] = {};
  for (const g of me.groups) {
    myMember[g.id] = g.myMemberId;
    const map: Record<string, string> = {};
    for (const m of g.members) map[m.id] = m.name;
    names[g.id] = map;
  }
  return { meUserId: me.user.id, names, myMember };
}

export interface ActivityEffect {
  kind: 'expense' | 'payment' | 'refund';
  /** Expenses and refunds: my net in the group currency (positive = I get money back). Payments: the amount sent. */
  amount: number;
  currency: string;
  involved: boolean;
  /** Payments: did I send it (true) or receive it (false). */
  sent?: boolean;
  /** The entry was deleted: the effect no longer counts. */
  void?: boolean;
}

export interface ActivityView {
  text: string;
  /** A second line: the comment, or what changed. */
  detail: string | null;
  effect: ActivityEffect | null;
  /** Where a tap goes (null for a deleted group). */
  path: string | null;
}

const EXPENSE_TYPES = new Set(['expense.create', 'expense.update', 'expense.delete', 'expense.restore', 'recurring.create']);

/** Chinese needs a space between a Latin name and the next Chinese word ("Abbie 新增了"), not after "你". */
function zh(actor: string, rest: string): string {
  return zhJoin(actor, rest);
}

/** Chinese text followed by a name: a space only before a Latin name ("移除了 Abbie", "移除了佳穎"). */
function zhThen(text: string, name: string): string {
  return text + (/^[A-Za-z0-9(]/.test(name) ? ' ' : '') + name;
}

/**
 * 「燒肉晚餐」 / "Korean BBQ dinner"; payments have no description. A refund says so, with its
 * description less the 「退款：」 prefix (shared/refunds.ts): 退款「押金」 / the refund "Deposit"
 * (the push says the same, services/pushText.ts).
 */
function quoted(desc: string | undefined, kind: ExpenseKind | undefined): { zh: string; en: string } {
  if (kind === 'refund') {
    const r = refundSubject(desc ?? '');
    return r ? { zh: '退款「' + r + '」', en: 'the refund "' + r + '"' } : { zh: '一筆退款', en: 'a refund' };
  }
  const d = (desc ?? '').trim();
  if (!d) return kind === 'payment' ? { zh: '一筆付款', en: 'a payment' } : { zh: '一筆費用', en: 'an expense' };
  return { zh: '「' + d + '」', en: '"' + d + '"' };
}

function fieldLabel(field: string): string {
  switch (field) {
    case 'amount': return t('金額', 'Amount');
    case 'description': return t('說明', 'Description');
    case 'currency': return t('幣別', 'Currency');
    case 'fxRate': return t('匯率', 'Exchange rate');
    case 'date': return t('日期', 'Date');
    case 'category': return t('分類', 'Category');
    case 'payers': return t('付款人', 'Paid by');
    case 'split': return t('分法', 'Split');
    case 'notes': return t('備註', 'Notes');
    case 'repeat': return t('重複', 'Repeat');
    case 'kind': return t('類型', 'Type');
    case 'name': return t('名稱', 'Name');
    case 'type': return t('類型', 'Type');
    case 'emoji': return t('圖示', 'Icon');
    case 'color': return t('顏色', 'Color');
    case 'simplify': return t('簡化債務', 'Simplify debts');
    case 'role': return t('角色', 'Role');
    case 'defaultSplit': return t('預設分法', 'Default split');
    default: return field;
  }
}

function groupTypeLabel(v: string): string {
  switch (v) {
    case 'trip': return t('旅行', 'Trip');
    case 'home': return t('住家', 'Home');
    case 'couple': return t('情侶', 'Couple');
    case 'pair': return t('兩人帳本', 'Friend ledger');
    default: return t('其他', 'Other');
  }
}

function fieldValue(field: string, v: string): string {
  if (v === '') return t('（空白）', '(empty)');
  switch (field) {
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDate(v, 'md') : v;
    case 'category': return categoryLabel(v, getLocale());
    case 'repeat': return repeatLabel(v as Parameters<typeof repeatLabel>[0]);
    case 'kind': return v === 'payment' ? t('付款', 'Payment') : v === 'refund' ? t('退款', 'Refund') : t('費用', 'Expense');
    case 'simplify': return v === 'true' ? t('開啟', 'on') : t('關閉', 'off');
    case 'role': return v === 'admin' ? t('管理員', 'admin') : t('成員', 'member');
    case 'type': return groupTypeLabel(v);
    default: return v;
  }
}

/** "金額：¥1,000 → ¥1,200；日期：12/18 → 12/19" (at most two changes, then "等 N 項"). */
function changesText(changes: { field: string; from: string; to: string }[] | undefined): string | null {
  const list = (changes ?? []).filter(c => c.field !== 'import');
  if (!list.length) return null;
  const shown = list.slice(0, 2).map(c => {
    if (c.field === 'notes' || c.field === 'split' || c.field === 'payers') {
      return t(fieldLabel(c.field) + '：' + fieldValue(c.field, c.to), fieldLabel(c.field) + ': ' + fieldValue(c.field, c.to));
    }
    const pair = fieldValue(c.field, c.from) + ' → ' + fieldValue(c.field, c.to);
    return t(fieldLabel(c.field) + '：' + pair, fieldLabel(c.field) + ': ' + pair);
  });
  const more = list.length - shown.length;
  const joined = shown.join(t('；', '; '));
  return more > 0 ? joined + t('，還有 {n} 項', ', and {n} more', { n: more }) : joined;
}

export function describeActivity(a: ActivityDTO, ctx: ActivityContext): ActivityView {
  const isMe = !!a.userId && a.userId === ctx.meUserId;
  const actor = isMe ? t('你', 'You') : a.actorName || t('有人', 'Someone');
  const d = a.data ?? {};
  const isPayment = d.kind === 'payment';
  const isRefund = d.kind === 'refund';
  const q = quoted(d.description, d.kind);
  const amt = typeof d.amount === 'number' && d.currency ? money(d.amount, d.currency) : '';
  const amtZh = amt ? ' ' + amt : '';
  const amtEn = amt ? ' (' + amt + ')' : '';
  const member = d.memberName || t('一位成員', 'a member');
  const names = ctx.names[a.groupId] ?? {};
  const myMemberId = ctx.myMember[a.groupId];
  const nameOf = (id: string) => (id === myMemberId ? t('你', 'you') : names[id] ?? t('（已移除）', '(removed)'));

  let text: string;
  let detail: string | null = null;

  switch (a.type) {
    case 'expense.create':
      if (isPayment) {
        const nets = Object.entries(d.nets ?? {});
        const from = nets.find(([, v]) => v > 0)?.[0];
        const to = nets.find(([, v]) => v < 0)?.[0];
        if (from && to) {
          // When I am in it, the amount prints on the right (你收到 / 你付出), not twice.
          const mine = from === myMemberId || to === myMemberId;
          const z = mine ? '' : amtZh;
          const e = mine ? '' : amt ? ' ' + amt : '';
          const actorMember = a.memberId ?? '';
          if (actorMember && actorMember === from) {
            // 「Leo 記錄了付給你的還款」 / "Leo recorded a payment to you"
            text = t(zhThen(zh(actor, '記錄了付給'), zhJoin(nameOf(to), '的還款')) + z, actor + ' recorded a payment to ' + nameOf(to) + e);
          } else if (actorMember && actorMember === to) {
            // 「你記錄了 Leo 的還款」 / "You recorded a payment from Leo"
            text = t(zhThen(zh(actor, '記錄了'), zhJoin(nameOf(from), '的還款')) + z, actor + ' recorded a payment from ' + nameOf(from) + e);
          } else {
            const fa = nameOf(from);
            const tb = nameOf(to);
            const enFrom = fa === 'you' ? 'You' : fa;
            text = t(zh(actor, '記錄了還款：') + zhThen(zhJoin(fa, '付給'), tb) + z, actor + ' recorded a payment: ' + enFrom + ' paid ' + tb + e);
          }
        } else {
          text = t(zh(actor, '記錄了一筆還款') + amtZh, actor + ' recorded a payment' + amtEn);
        }
      } else {
        text = t(zh(actor, '新增了') + q.zh + amtZh, actor + ' added ' + q.en + amtEn);
      }
      break;
    case 'expense.update':
      text = t(zh(actor, '修改了') + q.zh, actor + ' edited ' + q.en);
      detail = changesText(d.changes);
      break;
    case 'expense.delete':
      text = t(zh(actor, '刪除了') + q.zh + amtZh, actor + ' deleted ' + q.en + amtEn);
      break;
    case 'expense.restore':
      text = t(zh(actor, '復原了') + q.zh + amtZh, actor + ' restored ' + q.en + amtEn);
      break;
    case 'recurring.create':
      text = t('重複的' + q.zh + '自動新增了一筆' + amtZh, 'Repeating ' + q.en + ' was added automatically' + amtEn);
      break;
    case 'comment.add':
      text = t(zh(actor, '在') + q.zh + '留言', actor + ' commented on ' + q.en);
      detail = d.comment ? d.comment : null;
      break;
    case 'group.create':
      text = a.groupType === 'pair' ? t(zh(actor, '開始了這個兩人帳本'), actor + ' started this ledger') : t(zh(actor, '建立了群組'), actor + ' created the group');
      break;
    case 'group.update': {
      const imp = (d.changes ?? []).find(c => c.field === 'import');
      const def = (d.changes ?? []).find(c => c.field === 'defaultSplit');
      if (imp) {
        text = t(zh(actor, '匯入了 {n} 筆費用'), actor + ' imported {n} entries', { n: imp.to });
      } else if (def && (d.changes ?? []).length === 1) {
        // 「Gino 把預設分法改成「比例：你 60%、Abbie 40%」」 / 「Gino 清除了預設分法」, from the new
        // default the row carries (data.defaultSplit), else the change line's plain text.
        const shown = d.defaultSplit ? defaultSplitSummary(d.defaultSplit, nameOf) : def.to;
        text = shown
          ? t(zh(actor, '把預設分法改成「{s}」'), actor + ' changed the default split to "{s}"', { s: shown })
          : t(zh(actor, '清除了預設分法'), actor + ' cleared the default split');
      } else {
        text = t(zh(actor, '修改了群組設定'), actor + ' changed the group settings');
        detail = changesText(d.changes);
      }
      break;
    }
    case 'group.delete':
      text = t(zh(actor, '刪除了群組'), actor + ' deleted the group');
      break;
    case 'member.add':
      text = t(zhThen(zh(actor, '新增了成員'), member), actor + ' added ' + member);
      break;
    case 'member.join':
      text = t(zh(d.memberName || actor, '加入了群組'), (d.memberName || actor) + ' joined the group');
      break;
    case 'member.claim':
      // Someone joined as a member already on the list (picked their name on the invite page or
      // opened a claim link). The actor is always that member, so 「Abbie 認領了成員 Abbie」 read
      // like a system log; it is a join.
      text = t(zh(d.memberName || actor, '加入了群組'), (d.memberName || actor) + ' joined the group');
      break;
    case 'member.update':
      text = t(zhThen(zh(actor, '修改了'), zhJoin(member, '的資料')), actor + ' updated ' + member);
      detail = changesText(d.changes);
      break;
    case 'member.remove':
      text = t(zhThen(zh(actor, '移除了'), member), actor + ' removed ' + member);
      break;
    case 'member.leave':
      text = t(zh(actor, '離開了群組'), actor + ' left the group');
      break;
    case 'member.unlink':
      text = t(zhThen(zh(actor, '解除了'), zhJoin(member, '的帳號連結')), actor + ' unlinked the account of ' + member);
      break;
    case 'friend.join': {
      // A friend invite link accepted: data.memberId is the link's owner. 「Abbie 透過你的邀請連結加入」
      // for the owner (the push says the same), 「你透過 Gino 的邀請連結加入」 for the one who joined.
      if (d.memberId && d.memberId === myMemberId) {
        text = t(zh(actor, '透過你的邀請連結加入'), actor + ' joined through your invite link');
      } else {
        const owner = d.memberId ? names[d.memberId] ?? member : member;
        text = t(zhThen(zh(actor, '透過'), zhJoin(owner, '的邀請連結加入')), actor + ' joined through ' + owner + "'s invite link");
      }
      break;
    }
    default:
      text = t(zh(actor, '更新了群組'), actor + ' made a change');
  }

  let effect: ActivityEffect | null = null;
  if (EXPENSE_TYPES.has(a.type) && myMemberId && d.nets) {
    const net = d.nets[myMemberId];
    const involved = typeof net === 'number';
    if (isPayment) {
      effect = {
        kind: 'payment',
        amount: typeof d.amount === 'number' ? d.amount : Math.abs(net ?? 0),
        currency: d.currency ?? d.groupCurrency ?? '',
        involved,
        sent: involved ? net > 0 : undefined,
        void: a.type === 'expense.delete',
      };
    } else {
      effect = {
        kind: isRefund ? 'refund' : 'expense',
        amount: involved ? net : 0,
        currency: d.groupCurrency ?? d.currency ?? '',
        involved,
        void: a.type === 'expense.delete',
      };
    }
    if (!effect.currency) effect = null;
  }

  const path = a.type === 'group.delete' ? null : a.expenseId && (EXPENSE_TYPES.has(a.type) || a.type === 'comment.add') ? expensePath(a.groupId, a.expenseId) : groupPath(a.groupId);
  return { text, detail, effect, path };
}
