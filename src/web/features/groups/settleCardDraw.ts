// Draws the 結算圖卡 (settleCard.ts says what is on it and where) on a 1080 x 1350 canvas, in the
// picture-book look of the iPhone app's card (Views/Settle/SettleCardView.swift): the sky with two
// paper clouds, paper cards with ink outlines, the mascot standing on the summary card, and the
// grass hill with the app's name and address. The app's own fonts (Huninn for words, M PLUS
// Rounded 1c 800 for amounts) are loaded for exactly the text on the card before anything is drawn,
// so the Chinese never falls back to another font. Amounts may shrink to fit their line; words do
// not (long names end in …), and long lists fold instead (settleCard.ts).

import { getCategory, categoryLabel } from '../../../shared/categories';
import { formatMoney } from '../../../shared/money';
import {
  CARD_COLORS as C, CARD_H, CARD_W, LAYOUT as L, cardCategoryFill, cardDateRange, cardInitial, cardLayout, cardTint,
  type CardLayout, type CardPerson, type SettleCardData,
} from './settleCard';

/** The words the card needs in the app's current language. */
export interface CardWords {
  zh: boolean;
  locale: 'zh-TW' | 'en';
  /** 吉諾分帳所 / Gino's Split Lab */
  appName: string;
}

const FONT_TEXT = 'Huninn, "jf-openhuninn", "PingFang TC", "Heiti TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif';
const FONT_NUM = '"M PLUS Rounded 1c", Huninn, "PingFang TC", "Microsoft JhengHei", sans-serif';
const FONT_EMOJI = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

const words = (px: number) => `${px}px ${FONT_TEXT}`;
const digits = (px: number) => `800 ${px}px ${FONT_NUM}`;

/** How long the fonts may take before the card is drawn anyway (offline, nothing cached). */
const FONT_WAIT_MS = 10_000;

/** Everything the card prints, in its two fonts (the faces load by the characters they cover). */
export function cardTexts(card: SettleCardData, w: CardWords): { words: string; digits: string } {
  const t = (zh: string, en: string) => (w.zh ? zh : en);
  const money = (m: number) => formatMoney(m, card.currency, w.locale);
  const wordList = [
    card.name, card.firstDate && card.lastDate ? cardDateRange(card.firstDate, card.lastDate, w.zh) : '',
    t('這趟總花費', 'Trip total'), t('總花費', 'Total spent'), t('花在哪裡', 'By category'), t('誰付了多少', 'Who paid what'),
    t('付了', 'Paid'), t('分到', 'Share'), t('怎麼結清', 'How to settle up'), t('大家都結清了！', 'Everyone is settled up!'),
    t('還有 0123456789 人筆', 'and 0123456789 more people payments person payment'), w.appName, 'split.ginochang.com', '…',
    ...card.categories.map(c => categoryLabel(c.key, w.locale)),
    ...card.people.flatMap(p => [p.name, cardInitial(p.name)]),
    ...card.payments.flatMap(p => [p.from.name, p.to.name, cardInitial(p.from.name), cardInitial(p.to.name)]),
  ];
  const amounts = [
    money(card.spent),
    ...card.categories.map(c => money(c.amount)),
    ...card.people.flatMap(p => [money(p.paid), money(p.share)]),
    ...(card.morePeople ? [money(card.morePeople.paid), money(card.morePeople.share)] : []),
    ...card.payments.map(p => money(p.amount)),
  ];
  return { words: wordList.join(''), digits: amounts.join('') };
}

/** Wait for the app's fonts for exactly this text (or give up after FONT_WAIT_MS and draw anyway). */
export async function loadCardFonts(text: { words: string; digits: string }): Promise<boolean> {
  if (typeof document === 'undefined' || !document.fonts) return false;
  const wait = Promise.all([
    document.fonts.load(words(32), text.words),
    document.fonts.load(digits(32), text.digits),
  ]).then(() => document.fonts.ready).then(() => true, () => false);
  const late = new Promise<boolean>(r => setTimeout(() => r(false), FONT_WAIT_MS));
  const ok = await Promise.race([wait, late]);
  return ok && document.fonts.check(words(32), text.words) && document.fonts.check(digits(32), text.digits);
}

/** An image from SVG markup (the mascot), or null when it cannot load. */
export function svgImage(markup: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const svg = /xmlns=/.test(markup) ? markup : markup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

/** The card as a PNG: the fonts first, then the drawing. */
export async function makeSettleCardPng(card: SettleCardData, w: CardWords, mascot: HTMLImageElement | null): Promise<Blob> {
  await loadCardFonts(cardTexts(card, w));
  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas');
  drawSettleCard(ctx, card, w, mascot);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob gave nothing'))), 'image/png');
  });
}

// ---------- drawing ----------

type Ctx = CanvasRenderingContext2D;

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** A filled shape with its ink outline inside its edge (SwiftUI's strokeBorder). */
function card(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string, line: number = L.line): void {
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  roundRect(ctx, x + line / 2, y + line / 2, w - line, h - line, r - line / 2);
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = line;
  ctx.stroke();
}

function circle(ctx: Ctx, cx: number, cy: number, d: number, fill: string, line: number = L.thin): void {
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, d / 2 - line / 2, 0, Math.PI * 2);
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = line;
  ctx.stroke();
}

/** The dashed pencil rule of the app's rows, at the card's scale. */
function dash(ctx: Ctx, x1: number, y1: number, x2: number, y2: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.setLineDash([10, 12]);
  ctx.lineCap = 'round';
  ctx.lineWidth = 4;
  ctx.strokeStyle = C.pencil;
  ctx.stroke();
  ctx.restore();
}

/** The size `text` fits `maxWidth` at, from `size` down to `size * minScale`. */
function fitSize(ctx: Ctx, text: string, font: (px: number) => string, size: number, maxWidth: number, minScale: number): number {
  ctx.font = font(size);
  const width = ctx.measureText(text).width;
  if (width <= maxWidth || width === 0) return size;
  return Math.max(size * minScale, Math.floor((size * maxWidth) / width));
}

/** `text` cut short with … when it is wider than `maxWidth` in the current font. */
function ellipsize(ctx: Ctx, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(chars.slice(0, mid).join('') + '…').width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('').trimEnd() + '…';
}

/** One line of text, left or right aligned at x, centered on y, shrunk and then cut to fit. */
function text(
  ctx: Ctx,
  s: string,
  x: number,
  y: number,
  o: { font: (px: number) => string; size: number; color?: string; align?: CanvasTextAlign; maxWidth?: number; minScale?: number },
): number {
  const size = o.maxWidth ? fitSize(ctx, s, o.font, o.size, o.maxWidth, o.minScale ?? 1) : o.size;
  ctx.font = o.font(size);
  const shown = o.maxWidth ? ellipsize(ctx, s, o.maxWidth) : s;
  ctx.fillStyle = o.color ?? C.ink;
  ctx.textAlign = o.align ?? 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(shown, x, y);
  return ctx.measureText(shown).width;
}

function emoji(ctx: Ctx, s: string, cx: number, cy: number, px: number): void {
  ctx.font = `${px}px ${FONT_EMOJI}`;
  ctx.fillStyle = C.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(s, cx, cy);
}

/** A paper cloud with an ink outline (the app's Cloud, a 66 x 34 drawing), `w` wide, centered. */
function cloud(ctx: Ctx, cx: number, cy: number, w: number): void {
  const k = w / 66;
  const path = new Path2D('M12 28h42a9 9 0 0 0-2-17.6A12.5 12.5 0 0 0 28.5 7 10 10 0 0 0 12 28z');
  ctx.save();
  ctx.translate(cx - w / 2, cy - (34 * k) / 2);
  ctx.scale(k, k);
  ctx.fillStyle = C.paper;
  ctx.fill(path);
  ctx.lineWidth = 5 / k;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = C.ink;
  ctx.stroke(path);
  ctx.restore();
}

/** The grass hill along the bottom (the app's Hill, a 390 x 60 drawing), its top edge in ink. */
function hill(ctx: Ctx): void {
  const top = CARD_H - L.hill;
  const sx = CARD_W / 390;
  const sy = L.hill / 60;
  const p = (x: number, y: number): [number, number] => [x * sx, top + y * sy];
  const edge = () => {
    ctx.moveTo(...p(0, 30));
    ctx.bezierCurveTo(...p(46, 14), ...p(96, 14), ...p(152, 25));
    ctx.bezierCurveTo(...p(208, 36), ...p(262, 45), ...p(322, 27));
    ctx.bezierCurveTo(...p(382, 9), ...p(370, 15), ...p(390, 16));
  };
  ctx.beginPath();
  edge();
  ctx.lineTo(CARD_W, CARD_H);
  ctx.lineTo(0, CARD_H);
  ctx.closePath();
  ctx.fillStyle = C.grass;
  ctx.fill();
  ctx.beginPath();
  edge();
  ctx.lineWidth = L.line;
  ctx.lineCap = 'round';
  ctx.strokeStyle = C.ink;
  ctx.stroke();
}

/** A person's initial in their color and their name, from x on the row centered at y; returns where it ends. */
function who(ctx: Ctx, p: CardPerson, x: number, y: number, lay: CardLayout, nameMax: number): number {
  circle(ctx, x + lay.avatar / 2, y, lay.avatar, cardTint(p.color));
  text(ctx, cardInitial(p.name), x + lay.avatar / 2, y + 1, { font: words, size: Math.round(lay.avatar * 0.44), align: 'center' });
  const nameX = x + lay.avatar + 14;
  const width = text(ctx, p.name, nameX, y, { font: words, size: 32, maxWidth: Math.max(40, nameMax) });
  return nameX + width;
}

/** An arrow pointing right, `w` wide, centered on y (the plan's →). */
function arrow(ctx: Ctx, x: number, y: number, w: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x + 2, y);
  ctx.lineTo(x + w - 3, y);
  ctx.moveTo(x + w - 11, y - 8);
  ctx.lineTo(x + w - 3, y);
  ctx.lineTo(x + w - 11, y + 8);
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = C.ink2;
  ctx.stroke();
  ctx.restore();
}

/** A seal with a check, as the app's 已結清 stamp has it. */
function seal(ctx: Ctx, cx: number, cy: number, d: number): void {
  ctx.save();
  ctx.beginPath();
  const bumps = 12;
  for (let i = 0; i <= bumps * 2; i++) {
    const a = (i / (bumps * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = (d / 2) * (i % 2 === 0 ? 1 : 0.86);
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.lineWidth = 3.5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = C.ink;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - d * 0.2, cy + d * 0.01);
  ctx.lineTo(cx - d * 0.05, cy + d * 0.15);
  ctx.lineTo(cx + d * 0.22, cy - d * 0.14);
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

export function drawSettleCard(ctx: Ctx, cardData: SettleCardData, w: CardWords, mascot: HTMLImageElement | null): void {
  const c = cardData;
  const lay = cardLayout(c);
  const t = (zh: string, en: string) => (w.zh ? zh : en);
  const money = (m: number) => formatMoney(m, c.currency, w.locale);
  const left = L.margin;
  const width = CARD_W - 2 * L.margin;
  const right = left + width;

  // The sky, two clouds (one behind the mascot's head) and the hill, behind the cards.
  ctx.fillStyle = C.skyTint;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  if (lay.top >= 72) cloud(ctx, 600, lay.top / 2 + 2, 112);
  cloud(ctx, 966, lay.summaryTop - lay.mascot + 34, 150);
  hill(ctx);

  // The group's tile and name, and the days its entries span.
  const tile = L.header;
  const hy = lay.top;
  card(ctx, left, hy, tile, tile, 34, cardTint(c.color), L.thin);
  emoji(ctx, c.emoji.trim() || '👥', left + tile / 2, hy + tile / 2 + 3, 58);
  const nameX = left + tile + 24;
  const nameMax = width - L.mascotRoom - tile - 24;
  const range = c.firstDate && c.lastDate ? cardDateRange(c.firstDate, c.lastDate, w.zh) : '';
  if (range) {
    text(ctx, c.name, nameX, hy + 33, { font: words, size: 56, maxWidth: nameMax, minScale: 0.6 });
    text(ctx, range, nameX, hy + 92, { font: words, size: 32, color: C.ink2, maxWidth: nameMax, minScale: 0.8 });
  } else {
    text(ctx, c.name, nameX, hy + tile / 2, { font: words, size: 56, maxWidth: nameMax, minScale: 0.6 });
  }

  // What the group spent, and on the right the top 3 categories.
  const sy = lay.summaryTop;
  card(ctx, left, sy, width, L.summary, L.radius, C.yolkTint);
  const catW = 490;
  const hasCats = c.categories.length > 0;
  const totalW = width - 2 * 28 - (hasCats ? 20 + 4 + 20 + catW : 0);
  text(ctx, c.trip ? t('這趟總花費', 'Trip total') : t('總花費', 'Total spent'), left + 28, sy + 22 + 19, { font: words, size: 32, color: C.ink2, maxWidth: totalW });
  text(ctx, money(c.spent), left + 28, sy + 22 + 38 + 4 + 50, { font: digits, size: 84, maxWidth: totalW, minScale: 0.5 });
  if (hasCats) {
    const dashX = left + 28 + totalW + 20 + 2;
    dash(ctx, dashX, sy + 24, dashX, sy + L.summary - 24);
    const cx = dashX + 2 + 20;
    text(ctx, t('花在哪裡', 'By category'), cx, sy + 22 + 17, { font: words, size: 28, color: C.ink2, maxWidth: catW });
    c.categories.forEach((cat, i) => {
      const y = sy + 22 + 38 + 23 + i * 46;
      const info = getCategory(cat.key);
      circle(ctx, cx + 20, y, 40, cardCategoryFill(info.parent));
      emoji(ctx, info.emoji, cx + 20, y + 1, 20);
      ctx.font = digits(30);
      const amount = money(cat.amount);
      const amountW = Math.min(ctx.measureText(amount).width, catW / 2);
      text(ctx, amount, cx + catW, y, { font: digits, size: 30, align: 'right', maxWidth: catW / 2, minScale: 0.7 });
      text(ctx, categoryLabel(cat.key, w.locale), cx + 40 + 12, y, { font: words, size: 28, maxWidth: catW - 40 - 12 - 12 - amountW, minScale: 0.7 });
    });
  }

  // The mascot on the summary card's top edge, its feet on the outline, at the right.
  if (mascot) {
    const h = lay.mascot;
    const mw = mascot.naturalWidth && mascot.naturalHeight ? (h * mascot.naturalWidth) / mascot.naturalHeight : h;
    ctx.drawImage(mascot, right - 40 - mw, sy - h + L.line, mw, h);
  }

  // 誰付了多少: each person's paid and share in two columns that line up, the folded people last.
  const py = sy + L.summary + lay.gap;
  card(ctx, left, py, width, lay.people, L.radius, C.paper);
  const inL = left + 32;
  const inR = right - 32;
  const paidWord = t('付了', 'Paid');
  const shareWord = t('分到', 'Share');
  const rowsOfPeople = [...c.people.map(p => [p.paid, p.share]), ...(c.morePeople ? [[c.morePeople.paid, c.morePeople.share]] : [])];
  const widest = (list: string[], font: string) => {
    ctx.font = font;
    return Math.max(0, ...list.map(s => Math.ceil(ctx.measureText(s).width) + 4));
  };
  const paidW = Math.max(widest([paidWord], words(28)), widest(rowsOfPeople.map(r => money(r[0])), digits(32)));
  const shareW = Math.max(widest([shareWord], words(28)), widest(rowsOfPeople.map(r => money(r[1])), digits(32)));
  const titleY = py + L.pad + L.title / 2;
  text(ctx, t('誰付了多少', 'Who paid what'), inL, titleY, { font: words, size: 36, maxWidth: inR - inL - paidW - shareW - 72 });
  text(ctx, shareWord, inR, titleY, { font: words, size: 28, color: C.ink2, align: 'right' });
  text(ctx, paidWord, inR - shareW - 24, titleY, { font: words, size: 28, color: C.ink2, align: 'right' });
  const rowTop = py + L.pad + L.title;
  const nameRoom = inR - inL - lay.avatar - 14 - paidW - shareW - 3 * 24 - 12;
  c.people.forEach((p, i) => {
    const y = rowTop + i * lay.row + lay.row / 2;
    if (i > 0) dash(ctx, inL, rowTop + i * lay.row, inR, rowTop + i * lay.row);
    who(ctx, p, inL, y, lay, nameRoom);
    text(ctx, money(p.paid), inR - shareW - 24, y, { font: digits, size: 32, align: 'right' });
    text(ctx, money(p.share), inR, y, { font: digits, size: 32, align: 'right' });
  });
  if (c.morePeople) {
    const i = c.people.length;
    const y = rowTop + i * lay.row + lay.row / 2;
    dash(ctx, inL, rowTop + i * lay.row, inR, rowTop + i * lay.row);
    const n = c.morePeople.count;
    text(ctx, t(`還有 ${n} 人`, n === 1 ? 'and 1 more person' : `and ${n} more people`), inL + lay.avatar + 14, y, { font: words, size: 30, color: C.ink2, maxWidth: nameRoom });
    text(ctx, money(c.morePeople.paid), inR - shareW - 24, y, { font: digits, size: 32, color: C.ink2, align: 'right' });
    text(ctx, money(c.morePeople.share), inR, y, { font: digits, size: 32, color: C.ink2, align: 'right' });
  }

  // 怎麼結清: the plan, 「A → B ¥7,500」 a line, the folded payments last; or 大家都結清了！.
  const ly = py + lay.people + lay.gap;
  card(ctx, left, ly, width, lay.plan, L.radius, C.paper);
  text(ctx, t('怎麼結清', 'How to settle up'), inL, ly + L.pad + L.title / 2, { font: words, size: 36, maxWidth: inR - inL });
  const planTop = ly + L.pad + L.title;
  if (c.payments.length === 0) {
    const label = t('大家都結清了！', 'Everyone is settled up!');
    ctx.font = words(44);
    const labelW = ctx.measureText(label).width;
    const stampW = Math.min(inR - inL, 36 + 40 + 14 + labelW + 36);
    const stampH = 53 + 36;
    const sx = (left + right) / 2 - stampW / 2;
    const scy = planTop + L.settled / 2;
    card(ctx, sx, scy - stampH / 2, stampW, stampH, stampH / 2, C.sky);
    seal(ctx, sx + 36 + 20, scy, 40);
    text(ctx, label, sx + 36 + 40 + 14, scy, { font: words, size: 44, maxWidth: stampW - 36 - 40 - 14 - 36 });
  } else {
    ctx.font = words(32);
    const fromNames = Math.max(0, ...c.payments.map(p => Math.ceil(ctx.measureText(p.from.name).width) + 4));
    const fromW = Math.min(330, lay.avatar + 14 + fromNames);
    c.payments.forEach((p, i) => {
      const y = planTop + i * lay.row + lay.row / 2;
      if (i > 0) dash(ctx, inL, planTop + i * lay.row, inR, planTop + i * lay.row);
      ctx.font = digits(34);
      const amount = money(p.amount);
      const amountW = ctx.measureText(amount).width;
      who(ctx, p.from, inL, y, lay, fromW - lay.avatar - 14);
      const ax = inL + fromW + 14;
      arrow(ctx, ax, y, 28);
      const toX = ax + 28 + 14;
      who(ctx, p.to, toX, y, lay, inR - amountW - 16 - toX - lay.avatar - 14);
      text(ctx, amount, inR, y, { font: digits, size: 34, align: 'right' });
    });
    if (c.morePayments > 0) {
      const i = c.payments.length;
      const y = planTop + i * lay.row + lay.row / 2;
      dash(ctx, inL, planTop + i * lay.row, inR, planTop + i * lay.row);
      const n = c.morePayments;
      text(ctx, t(`還有 ${n} 筆`, n === 1 ? 'and 1 more payment' : `and ${n} more payments`), inL + lay.avatar + 14, y, { font: words, size: 30, color: C.ink2, maxWidth: inR - inL - lay.avatar - 14 });
    }
  }

  // The app's name and address on the grass.
  ctx.font = words(28);
  const site = 'split.ginochang.com';
  const nameW = ctx.measureText(w.appName).width;
  const siteW = ctx.measureText(site).width;
  const fx = CARD_W / 2 - (nameW + 18 + siteW) / 2;
  const fy = CARD_H - 32 - 17;
  text(ctx, w.appName, fx, fy, { font: words, size: 28 });
  text(ctx, site, fx + nameW + 18, fy, { font: words, size: 28 });
}
