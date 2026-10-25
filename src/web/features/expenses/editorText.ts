// Wording for the expense editor and detail page, in both languages, from the pure results of
// editorLogic.ts (reasons, split errors, history lines). One place, so every screen says it the same way.

import { categoryLabel } from '../../../shared/categories';
import type { Repeat } from '../../../shared/dates';
import type { SplitErrorCode, SplitMethod } from '../../../shared/split';
import type { MemberDTO } from '../../../shared/types';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { formatDate, getLocale, money, t } from '../../lib/i18n';
import { repeatLabel, zhJoin } from '../../lib/describe';
import {
  formatRate, multiPayerCount, parseLooseNumber, type EditorDraft, type HistoryLine, type Reason, type ScanApplied, type ScanField, type ScanNote,
} from './editorLogic';
import { ScanError } from './receiptScan';

/** The payer blank in 「由 [你] 付款」: 你 / a name / 2 人. */
export function payerChipText(d: Pick<EditorDraft, 'payerMode' | 'payerId' | 'payerAmounts' | 'currency'>, members: readonly MemberDTO[], meId: string): string {
  if (d.payerMode === 'multi') {
    const n = multiPayerCount(d, members.map(m => m.id));
    return n > 0 ? t('{n} 人', '{n} people', { n }) : t('多人', 'several people');
  }
  if (d.payerId === meId) return t('你', 'you');
  return members.find(m => m.id === d.payerId)?.name ?? t('選擇', 'choose');
}

function peopleEn(n: number): string {
  return n === 1 ? '1 person' : `${n} people`;
}

/**
 * The split blank in 「由 你 付款，[平均分給 6 人]」 / "Paid by you, [split equally, 6 people]"
 * (DESIGN.md 8.13). `people` = who ends up with a share; `single` = that person's display
 * name when there is only one.
 */
export function splitChipText(method: SplitMethod, people: number, single?: string): string {
  const p = { n: people, people: peopleEn(people) };
  if (method === 'equal') {
    if (people === 0) return t('選擇分給誰', 'choose who shares');
    if (people === 1 && single) {
      const zhWho = /^[A-Za-z0-9]/.test(single) ? ` ${single} ` : single;
      return t(`全部算${zhWho}的`, 'all on {who}', { who: single });
    }
    return t('平均分給 {n} 人', 'split equally, {people}', p);
  }
  switch (method) {
    case 'exact': return t('依金額分給 {n} 人', 'split by amounts, {people}', p);
    case 'percent': return t('依比例分給 {n} 人', 'split by percent, {people}', p);
    case 'shares': return t('依份數分給 {n} 人', 'split by shares, {people}', p);
    case 'adjust': return t('平均再加減，{n} 人', 'split with adjustments, {people}', p);
    case 'items': return t('依品項分給 {n} 人', 'split by item, {people}', p);
  }
}

const LATIN = /[A-Za-z0-9]/;
const HAN = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;

/**
 * Join Chinese text parts the Taiwan way (DESIGN.md 13.2): one half-width space where Chinese
 * meets Latin letters or digits, none between Chinese and Chinese or next to full-width
 * punctuation. zhSpace('由', 'Gino', '新增於', '3 小時前') gives 「由 Gino 新增於 3 小時前」,
 * zhSpace('由', '佳穎', '新增於', '剛剛') gives 「由佳穎新增於剛剛」.
 */
export function zhSpace(...parts: string[]): string {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    if (out) {
      const a = out[out.length - 1];
      const b = p[0];
      if ((LATIN.test(a) && HAN.test(b)) || (HAN.test(a) && LATIN.test(b))) out += ' ';
    }
    out += p;
  }
  return out;
}

/** 「由 Gino 新增於 3 小時前」 / "Added by Gino 3 h ago". `who` is 你 / you for me. */
export function addedByText(who: string, when: string): string {
  return t(zhSpace('由', who, '新增於', when), 'Added by {who} {when}', { who, when });
}

/** 「Abbie 修改於 1 小時前」 / "Edited by Abbie 1 h ago". */
export function editedByText(who: string, when: string): string {
  return t(zhSpace(who, '修改於', when), 'Edited by {who} {when}', { who, when });
}

/** Labels of the six methods, as on the segmented control (SPEC section 9). */
export function methodName(m: SplitMethod): string {
  switch (m) {
    case 'equal': return t('平均', 'Equally');
    case 'exact': return t('金額', 'Exact');
    case 'percent': return t('比例', 'Percent');
    case 'shares': return t('份數', 'Shares');
    case 'adjust': return t('加減', 'Adjust');
    case 'items': return t('品項', 'By item');
  }
}

/** One line under the method tabs explaining what the method does. */
export function methodHint(m: SplitMethod): string {
  switch (m) {
    case 'equal': return t('勾選有參與的人，金額平均分。', 'Tick who took part; the amount is split evenly.');
    case 'exact': return t('輸入每個人要付的金額，加起來要等於總額。', 'Type what each person owes; it must add up to the total.');
    case 'percent': return t('輸入每個人的百分比，加起來要是 100%。', 'Type a percentage for each person; it must add up to 100%.');
    case 'shares': return t('依份數分，例如住兩晚的人 2 份、住一晚的人 1 份。', 'Split by shares, for example 2 for two nights and 1 for one night.');
    case 'adjust': return t('先平均分，再替個別的人加或減金額。', 'Split evenly, then add or take off an amount for some people.');
    case 'items': return t('一行一個品項，選誰有份；稅和小費依比例分攤。', 'One line per item and who had it; tax and tip are shared in proportion.');
  }
}

export function repeatName(r: Repeat): string {
  return repeatLabel(r);
}

/** Money for a signed difference, always shown positive (the words say which way). */
function absMoney(minor: number, currency: string): string {
  return money(Math.abs(minor), currency);
}

/** "還差 ¥5,000" / "多了 ¥400" / "剛好" for what is left to assign (minor units). */
export function remainingText(diff: number, currency: string): string {
  if (diff > 0) return t('還差 {amt}', '{amt} left', { amt: absMoney(diff, currency) });
  if (diff < 0) return t('多了 {amt}', '{amt} over', { amt: absMoney(diff, currency) });
  return t('剛好', 'All assigned');
}

function pct(n: number): string {
  return String(Math.round(Math.abs(n) * 1000) / 1000);
}

/** The full sentence for a split problem, for the split sheet and the editor. */
export function splitErrorText(code: SplitErrorCode, diff: number | undefined, currency: string): string {
  switch (code) {
    case 'invalid_total': return t('先輸入金額。', 'Enter the amount first.');
    case 'no_participants': return t('至少選一個人分攤。', 'Choose at least one person to share it.');
    case 'duplicate_member': return t('有人被列了兩次。', 'Someone is in the split twice.');
    case 'invalid_value': return t('有一個數字看不懂，請檢查。', 'One of the numbers is not valid.');
    case 'exact_mismatch':
      return (diff ?? 0) >= 0
        ? t('還有 {amt} 沒有分到人。', '{amt} is not assigned to anyone yet.', { amt: absMoney(diff ?? 0, currency) })
        : t('分配的金額比總額多了 {amt}。', 'The amounts are {amt} over the total.', { amt: absMoney(diff ?? 0, currency) });
    case 'percent_mismatch':
      return (diff ?? 0) >= 0
        ? t('百分比還差 {p}%，加起來要是 100%。', '{p}% left: the percentages must add up to 100%.', { p: pct(diff ?? 0) })
        : t('百分比多了 {p}%，加起來要是 100%。', '{p}% over: the percentages must add up to 100%.', { p: pct(diff ?? 0) });
    case 'zero_weights': return t('至少要有一個人有份數。', 'Give at least one person a share.');
    case 'negative_share': return t('加減之後有人的金額變成負的，請調小一點。', 'The adjustments leave someone below zero. Make them smaller.');
    case 'no_items': return t('至少輸入一個品項的金額。', 'Add at least one item with an amount.');
    case 'item_no_members': return t('每個品項都要選誰有份。', 'Choose who had each item.');
    case 'items_exceed_total': return t('品項加起來超過總額太多。', 'The items add up to more than the total allows.');
  }
}

/** The sentence for whatever stops saving (shown in the editor). */
export function reasonText(r: Reason, currency: string): string {
  switch (r.code) {
    case 'amount_empty': return t('先輸入金額。', 'Enter an amount.');
    case 'amount_invalid': return t('金額看不懂，請檢查算式。', 'The amount is not a number. Check what you typed.');
    case 'amount_zero': return t('金額要大於 0。', 'The amount must be more than 0.');
    case 'payer_missing': return t('選擇誰付的錢。', 'Choose who paid.');
    case 'payers':
      switch (r.error) {
        case 'no_payers': return t('選擇誰付的錢。', 'Choose who paid.');
        case 'duplicate_member': return t('同一個人被列了兩次。', 'Someone is listed twice.');
        case 'invalid_value': return t('有一個付款金額看不懂。', 'One of the paid amounts is not valid.');
        case 'payers_mismatch':
          return (r.diff ?? 0) > 0
            ? t('付款金額加起來還差 {amt}。', 'The paid amounts are {amt} short of the total.', { amt: absMoney(r.diff ?? 0, currency) })
            : t('付款金額加起來多了 {amt}。', 'The paid amounts are {amt} over the total.', { amt: absMoney(r.diff ?? 0, currency) });
      }
      return t('付款人有問題。', 'Check who paid.');
    case 'split': return splitErrorText(r.error, r.diff, currency);
    case 'recipient_missing': return t('選擇收款的人。', 'Choose who received the money.');
    case 'payment_self': return t('付款的人和收款的人不能是同一個。', 'The payer and the recipient must be different people.');
    case 'fx_missing': return t('拿不到匯率，請手動輸入匯率才能儲存。', 'No exchange rate yet. Type one to save.');
    case 'fx_invalid': return t('匯率要是大於 0 的數字。', 'The exchange rate must be a number above 0.');
    case 'converted_too_large': return t('換算後的金額太大了。', 'The converted amount is too large.');
  }
}

/** A few words for the 儲存 key while it is disabled. */
export function reasonShort(r: Reason): string {
  switch (r.code) {
    case 'amount_empty': return t('先輸入金額', 'Enter an amount');
    case 'amount_invalid':
    case 'amount_zero': return t('檢查金額', 'Check the amount');
    case 'payer_missing':
    case 'payers': return t('檢查付款人', 'Check who paid');
    case 'split': return t('檢查分法', 'Check the split');
    case 'recipient_missing':
    case 'payment_self': return t('檢查收款人', 'Check the recipient');
    case 'fx_missing':
    case 'fx_invalid': return t('需要匯率', 'Needs a rate');
    case 'converted_too_large': return t('金額太大', 'Amount too large');
  }
}

function fieldValue(field: string, v: string): string {
  switch (field) {
    case 'category': return categoryLabel(v, getLocale());
    case 'repeat': return repeatLabel(v as Repeat);
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDate(v, 'md') : v;
    case 'fxRate': {
      const n = parseLooseNumber(v);
      return n !== null ? formatRate(n) : v;
    }
    case 'kind': return v === 'payment' ? t('付款', 'payment') : t('費用', 'expense');
    default: return v;
  }
}

/** A history line as a sentence: "Gino 新增了這筆", "Abbie 把金額從 ¥4,000 改成 ¥4,550". `who` is already "你" for me. */
export function historyText(l: HistoryLine, who: string): string {
  const w = { who };
  switch (l.kind) {
    case 'created': return t(zhJoin(who, '新增了這筆'), '{who} added this', w);
    case 'recurring': return t('依重複設定自動新增', 'Added automatically (repeating)');
    case 'deleted': return t(zhJoin(who, '刪除了這筆'), '{who} deleted this', w);
    case 'restored': return t(zhJoin(who, '復原了這筆'), '{who} restored this', w);
    case 'edited': return t(zhJoin(who, '修改了這筆'), '{who} edited this', w);
    case 'commented': return t(zhJoin(who, '留言：「{c}」'), '{who} commented: "{c}"', { who, c: l.comment ?? '' });
    case 'changed': break;
  }
  const field = l.field ?? '';
  const from = fieldValue(field, l.from ?? '');
  const to = fieldValue(field, l.to ?? '');
  const p = { who, from, to };
  switch (field) {
    case 'amount': return t(zhJoin(who, '把金額從 {from} 改成 {to}'), '{who} changed the amount from {from} to {to}', p);
    case 'description': return t(zhJoin(who, '把說明從「{from}」改成「{to}」'), '{who} changed the description from "{from}" to "{to}"', p);
    case 'currency': return t(zhJoin(who, '把幣別從 {from} 改成 {to}'), '{who} changed the currency from {from} to {to}', p);
    case 'fxRate': return t(zhJoin(who, '把匯率從 {from} 改成 {to}'), '{who} changed the exchange rate from {from} to {to}', p);
    case 'date': return t(zhJoin(who, '把日期從 {from} 改成 {to}'), '{who} changed the date from {from} to {to}', p);
    case 'category': return t(zhJoin(who, '把分類從「{from}」改成「{to}」'), '{who} changed the category from {from} to {to}', p);
    case 'payers': return t(zhJoin(who, '把付款人從 {from} 改成 {to}'), '{who} changed who paid from {from} to {to}', p);
    case 'split': return t(zhJoin(who, '修改了分法：{to}'), '{who} changed the split: {to}', p);
    case 'notes':
      if (!to) return t(zhJoin(who, '刪除了備註'), '{who} removed the notes', p);
      if (!from) return t(zhJoin(who, '加上備註「{to}」'), '{who} added notes: "{to}"', p);
      return t(zhJoin(who, '把備註改成「{to}」'), '{who} changed the notes to "{to}"', p);
    case 'repeat': return t(zhJoin(who, '把重複從「{from}」改成「{to}」'), '{who} changed repeat from {from} to {to}', p);
    case 'kind': return t(zhJoin(who, '把類型從{from}改成{to}'), '{who} changed it from a {from} to a {to}', p);
    default: return t(zhJoin(who, '修改了這筆'), '{who} edited this', p);
  }
}

// ---------- receipt scan ----------

const SCAN_FIELD: Record<ScanField, [string, string]> = {
  currency: ['幣別', 'currency'],
  amount: ['金額', 'amount'],
  date: ['日期', 'date'],
  description: ['店名', 'store name'],
  category: ['分類', 'category'],
  items: ['品項', 'items'],
};

/** 「金額、日期和店名」 / "amount, date and store name". */
function scanFields(fields: readonly ScanField[]): string {
  const zh = fields.map(f => SCAN_FIELD[f][0]);
  const en = fields.map(f => SCAN_FIELD[f][1]);
  const join = (words: string[], sep: string, and: string) => (words.length > 1 ? words.slice(0, -1).join(sep) + and + words[words.length - 1] : words[0] ?? '');
  return t(join(zh, '、', '和'), join(en, ', ', ' and '));
}

/** One sentence for something the editor noticed while filling in a receipt. */
export function scanNoteText(n: ScanNote): string {
  switch (n.code) {
    case 'kept': return t('讀取時你改過的{f}沒有換掉', 'Kept the {f} you changed while it was reading', { f: scanFields(n.fields) });
    case 'date_outside':
      return t('收據日期 {d} 不在最近 90 天內，沒有填入', 'The receipt date, {d}, is not in the last 90 days, so it was not filled in', { d: formatDate(n.date, 'long') });
    case 'currency_changed': return t('你剛改了幣別，金額沒有填入', 'You changed the currency while it was reading, so no amounts were filled in');
    case 'total_unreadable': return t('總額看起來讀錯了，沒有填入', 'The total looks misread, so it was not filled in');
    case 'items_kept': return t('保留了你輸入的品項', 'Kept the items you typed');
  }
}

/**
 * The toast after a scan: what was filled in, where the 品項 lines went, what to check (the
 * editor's notes, then the Worker's warnings, already in this language) and, the first time on
 * this device, what happens to the photo: attached to the expense (`kept`; × takes it off), or
 * only read.
 */
export function scanSummaryText(r: ScanApplied, warnings: readonly string[], privacy: boolean, kept = false): string {
  const parts: string[] = [];
  const fields = r.filled.filter(f => f !== 'items');
  if (fields.length) parts.push(t('已從收據填入{f}', 'Filled in the {f} from the receipt', { f: scanFields(fields) }));
  if (r.items) {
    const one = r.items === 1;
    parts.push(
      r.openSplit
        ? t('填入 {n} 個品項，請選每項誰有份', one ? '1 item is in. Choose who had it' : '{n} items are in. Choose who had each', { n: r.items })
        : t('{n} 個品項放在「分法」的「品項」裡', one ? '1 item is ready under Split > By item' : '{n} items are ready under Split > By item', { n: r.items }),
    );
  }
  if (!parts.length) parts.push(t('收據上沒有能填入的內容', 'Nothing from the receipt could be filled in'));
  for (const n of r.notes) parts.push(scanNoteText(n));
  parts.push(...warnings);
  if (privacy) {
    parts.push(
      kept
        ? t('照片會附在這筆費用上，群組的人看得到，不想留的話按 × 移除', 'The photo is kept with this expense for the group to see. Tap × to take it off')
        : t('照片只用來辨識，不會存起來', 'The photo is only read, never stored'),
    );
  }
  return parts.join(t('。', '. '));
}

/** After 復原 on a scan that changed the currency, when numbers typed since kept it (revertScan). */
export function scanCurrencyKeptText(currency: string): string {
  return t('掃描後輸入的數字是用 {c} 算的，所以幣別沒有改回來', 'What you typed after the scan is in {c}, so the currency was not changed back', { c: currency });
}

// ---------- receipt photos kept with an expense ----------

/** A picked photo could not be opened, or not made small enough to keep. */
export function receiptPhotoErrorText(): string {
  return t('打不開這張照片，請換一張試試', 'This photo cannot be opened. Try another one');
}

/**
 * What the receipt photo waiting in the outbox is doing: going up, waiting for a connection or for
 * tomorrow (the day's uploads are used up), or why it failed for good. `code` is the item's last
 * error (or its failure).
 */
export function receiptStatusText(p: { failed: boolean; code: string | null; message?: string }, online: boolean): string {
  switch (p.code) {
    case 'receipts_quota': return t('今天的收據照片上傳額度用完了，明天會自動上傳', "Today's receipt photo uploads are used up. It uploads by itself tomorrow");
    case 'rate_limited': return t('你今天上傳太多張收據照片了，明天會自動上傳', 'You uploaded many receipt photos today. It uploads by itself tomorrow');
    case 'receipts_full': return t('收據照片的空間滿了，這張存不下', 'The space for receipt photos is full, so this one cannot be kept');
    case 'payload_too_large': return t('照片太大了，請換一張', 'The photo is too large. Choose another one');
    case 'not_found': return t('這筆費用已經不在了，照片沒有存', 'This entry is gone, so the photo was not kept');
    default: break;
  }
  if (p.failed) return p.message || t('收據照片沒有存成功', 'The receipt photo was not kept');
  return online ? t('收據照片等待上傳', 'The receipt photo is waiting to upload') : t('離線中，收據照片會在連線後上傳', 'You are offline. The receipt photo uploads when you reconnect');
}

/** Why a scan did not work, and what to do instead (most of these say the amount can be typed). */
export function scanErrorText(e: unknown): string {
  if (e instanceof ScanError) {
    return e.reason === 'timeout'
      ? t('讀取收據太久了，請再試一次', 'Reading the receipt took too long. Try again')
      : t('打不開這張照片，請換一張試試', 'This photo cannot be opened. Try another one');
  }
  if (e instanceof ApiError) {
    const details = (e.details ?? {}) as { scope?: unknown; reason?: unknown };
    switch (e.code) {
      case 'offline': return t('沒有網路連線，連線後再試', 'No connection. Try again when you are online');
      case 'rate_limited':
        if (details.scope === 'user') return t('你今天的收據掃描次數用完了，明天再試，或直接輸入', 'You have used all of today\'s receipt scans. Try again tomorrow, or type it in');
        if (details.scope === 'app') return t('今天的收據掃描已經額滿，明天再試，或直接輸入', 'Receipt scans are full for today. Try again tomorrow, or type it in');
        if (details.scope === 'ai') return t('今天的收據辨識額度用完了，明天再試，或直接輸入', 'Today\'s receipt reading is used up. Try again tomorrow, or type it in');
        return t('掃描太多次了，請過一會兒再試', 'Too many scans. Wait a little and try again');
      case 'scan_failed':
        if (details.reason === 'unreadable') return t('看不清楚這張收據，請拍清楚一點再試，或直接輸入', 'This receipt cannot be read. Take a sharper photo, or type it in');
        if (details.reason === 'timeout') return t('讀取收據太久了，請再試一次', 'Reading the receipt took too long. Try again');
        return t('現在讀不了收據，請稍後再試，或直接輸入', 'Receipts cannot be read right now. Try again later, or type it in');
      case 'payload_too_large': return t('照片太大了，請換一張試試', 'The photo is too large. Try another one');
      case 'validation':
      case 'bad_request': return t('這個檔案不是照片，請選一張收據的照片', 'That file is not a photo. Choose a photo of the receipt');
      default: break;
    }
  }
  return errorMessage(e);
}
