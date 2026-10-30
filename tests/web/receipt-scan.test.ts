// A scan of up to three receipt photos in the web app (docs/SPEC.md section 8.7): what
// receiptScan.ts sends (one photo as `image`, exactly as before several photos; two or three as
// `images`, each its scan copy unless that is over 1,000,000 characters) and how long it waits
// (60 s, 90 s); the editor's photo rules without React (editorPhotos.ts: where the list starts,
// picking past three, a duplicate, what 儲存 queues, what the scan button offers); and the words for
// two or three photos (editorText.ts: the summary, the nudge, the errors, the statuses, the titles).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The app's modules read storage and the page's address when they load.
vi.hoisted(() => {
  const map = new Map<string, string>([['evenly.api', 'same-origin']]);
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage = storage;
  g.sessionStorage = storage;
  g.location = { origin: 'https://split.test', href: 'https://split.test/', pathname: '/', search: '', hash: '' };
});

import type { ReceiptDTO } from '../../src/shared/types';
import { photosKey, photoSavePlan, pickPlan, scanOffer, startingPhotos, withPhoto, type FormPhoto } from '../../src/web/features/expenses/editorPhotos';
import { giveScanConsent, hasScanConsent, resetScanConsent } from '../../src/web/features/expenses/editorPrefs';
import type { ScanApplied } from '../../src/web/features/expenses/editorLogic';
import {
  photoPrefixText, photosPreparingText, receiptDuplicateText, receiptLongHint, receiptPhotoErrorText, receiptsTitleText, receiptStatusText,
  receiptTrimmedText, scanConsentCardText, scanConsentText, scanErrorText, scanNudge, scanPhotosLabel, scanReadingText, scanSummaryText,
  viewerTitleText,
} from '../../src/web/features/expenses/editorText';
import { SCAN_COPY_MAX_CHARS, SCAN_TIMEOUT_MS, SCAN_TIMEOUT_MULTI_MS, ScanError, scanRequest, scanTimeoutMs } from '../../src/web/features/expenses/receiptScan';
import { ApiError } from '../../src/web/lib/api';
import { setLocale } from '../../src/web/lib/i18n';
import { visiblePhotos } from '../../src/web/lib/outbox';

const url = (tag: string, n = 300) => 'data:image/jpeg;base64,' + tag + 'A'.repeat(n);

afterEach(() => setLocale('zh-TW'));

// ---------- what a scan sends ----------

describe('scanRequest and its timeout', () => {
  const o = { currency: 'JPY', locale: 'zh-TW' as const };

  it('one photo goes as `image`, its scan copy, exactly as before several photos (no images key)', () => {
    expect(scanRequest([{ image: url('kept'), scanCopy: url('scan') }], o)).toEqual({ image: url('scan'), currency: 'JPY', locale: 'zh-TW' });
    expect(Object.keys(scanRequest([{ image: url('kept'), scanCopy: url('scan') }], o))).toEqual(['image', 'currency', 'locale']);
    // Without a scan copy, the kept copy.
    expect(scanRequest([{ image: url('kept') }], o)).toEqual({ image: url('kept'), currency: 'JPY', locale: 'zh-TW' });
  });

  it('two or three go as `images`, in order: each its scan copy unless that is over 1,000,000 characters, then its kept copy', () => {
    const big = url('big', SCAN_COPY_MAX_CHARS);
    expect(SCAN_COPY_MAX_CHARS).toBe(1_000_000);
    const r = scanRequest([{ image: url('k1'), scanCopy: url('s1') }, { image: url('k2'), scanCopy: big }, { image: url('k3') }], o);
    expect(r).toEqual({ images: [url('s1'), url('k2'), url('k3')], currency: 'JPY', locale: 'zh-TW' });
    expect('image' in r).toBe(false);
    // Exactly at the limit is still the scan copy.
    const edge = 'data:image/jpeg;base64,' + 'B'.repeat(SCAN_COPY_MAX_CHARS - 23);
    expect(edge.length).toBe(SCAN_COPY_MAX_CHARS);
    expect(scanRequest([{ image: url('k1'), scanCopy: edge }, { image: url('k2') }], o).images![0]).toBe(edge);
  });

  it('waits 60 s for one photo and 90 s for two or three', () => {
    expect([SCAN_TIMEOUT_MS, SCAN_TIMEOUT_MULTI_MS]).toEqual([60_000, 90_000]);
    expect([1, 2, 3].map(scanTimeoutMs)).toEqual([60_000, 90_000, 90_000]);
  });
});

describe('scanReceipt on the wire', () => {
  class MemoryStorage {
    readonly map = new Map<string, string>();
    getItem(k: string): string | null {
      return this.map.get(k) ?? null;
    }
    setItem(k: string, v: string): void {
      this.map.set(k, String(v));
    }
    removeItem(k: string): void {
      this.map.delete(k);
    }
  }
  let bodies: unknown[];
  let hang: boolean;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    bodies = [];
    hang = false;
    const ls = new MemoryStorage();
    ls.setItem('evenly.api', 'https://api.test');
    ls.setItem('evenly.token', 'tok' + 'a'.repeat(40));
    vi.stubGlobal('localStorage', ls);
    vi.stubGlobal('sessionStorage', new MemoryStorage());
    vi.stubGlobal('location', { origin: 'https://split.test', href: 'https://split.test/#/', pathname: '/', search: '', hash: '#/' });
    vi.stubGlobal('document', { cookie: '', visibilityState: 'visible', addEventListener: () => undefined });
    vi.stubGlobal('navigator', { onLine: true, userAgent: 'test' });
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal('fetch', (u: string, init: RequestInit = {}) => {
      bodies.push(JSON.parse(String(init.body)));
      if (hang) {
        return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      }
      return Promise.resolve(new Response(JSON.stringify({ merchant: 'M', date: null, currency: null, total: 1, items: [], tax: null, tip: null, category: null, warnings: [], totalFound: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function load() {
    vi.resetModules();
    return import('../../src/web/features/expenses/receiptScan');
  }

  it('posts {image} for one photo and {images} for three to POST /api/receipts/scan', async () => {
    const m = await load();
    const signal = new AbortController().signal;
    await m.scanReceipt([{ image: url('k'), scanCopy: url('s') }], { currency: 'TWD', locale: 'en', signal });
    await m.scanReceipt([{ image: url('k1'), scanCopy: url('s1') }, { image: url('k2'), scanCopy: url('s2') }, { image: url('k3'), scanCopy: url('s3') }], { currency: 'TWD', locale: 'en', signal });
    expect(bodies).toEqual([
      { image: url('s'), currency: 'TWD', locale: 'en' },
      { images: [url('s1'), url('s2'), url('s3')], currency: 'TWD', locale: 'en' },
    ]);
  });

  it('gives up with ScanError(timeout) after 60 s for one photo, and after 90 s (not 60) for three', async () => {
    const m = await load();
    hang = true;
    const signal = new AbortController().signal;
    const one = m.scanReceipt([{ image: url('k') }], { currency: 'TWD', locale: 'en', signal }).catch(e => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await one).toBeInstanceOf(m.ScanError);
    const three = m.scanReceipt([{ image: url('a') }, { image: url('b') }, { image: url('c') }], { currency: 'TWD', locale: 'en', signal }).catch(e => e);
    let settled: unknown = 'pending';
    void three.then(v => (settled = v));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(30_000);
    const e = await three;
    expect(e).toBeInstanceOf(m.ScanError);
    expect((e as ScanError).reason).toBe('timeout');
  });
});

// ---------- the editor's photo list ----------

const photo = (version: string, kind: FormPhoto['kind'] = 'new'): FormPhoto =>
  kind === 'stored' ? { version, kind, width: 3, height: 4 } : { version, kind, image: url(version), width: 3, height: 4, ...(kind === 'new' ? { scanCopy: url('s' + version) } : {}) };

describe('the editor\'s receipt photos (editorPhotos.ts)', () => {
  it('start from the entry\'s photos as they show (stored ones, and adds still queued); none for a new expense', () => {
    const dto = (v: string): ReceiptDTO => ({ version: v, mime: 'image/jpeg', width: 3, height: 4, bytes: 9 });
    const start = startingPhotos(
      visiblePhotos(
        { receipt: dto('a'), receipts: [dto('a'), dto('b')] },
        { adds: [{ itemId: 'i1', version: 'c', image: url('c'), width: 5, height: 6, state: 'waiting', code: 'offline' }], drops: ['b'] },
      ),
    );
    expect(start).toEqual([
      { version: 'a', kind: 'stored', width: 3, height: 4 },
      { version: 'c', kind: 'queued', image: url('c'), width: 5, height: 6 },
    ]);
    expect(startingPhotos([])).toEqual([]);
    expect(photosKey(start)).toBe('a,c');
  });

  it('takes picked files in order up to three, trims the rest, and skips a photo already in the form', () => {
    expect(pickPlan(0, 1)).toEqual({ take: 1, trimmed: 0 });
    expect(pickPlan(0, 4)).toEqual({ take: 3, trimmed: 1 });
    expect(pickPlan(2, 3)).toEqual({ take: 1, trimmed: 2 });
    expect(pickPlan(3, 1)).toEqual({ take: 0, trimmed: 1 });
    const one = withPhoto([], photo('a'));
    expect(one).toEqual([photo('a')]);
    expect(withPhoto(one as FormPhoto[], photo('a'))).toBe('duplicate');
    expect(withPhoto([photo('a'), photo('b'), photo('c')], photo('d'))).toBe('full');
    expect(withPhoto([photo('a'), photo('b')], photo('c'))).toEqual([photo('a'), photo('b'), photo('c')]);
  });

  it('儲存 takes off the starting photos the form no longer has, then adds the new ones in order', () => {
    const start = [photo('a', 'stored'), photo('b', 'queued'), photo('c', 'stored')];
    expect(photoSavePlan(start, [photo('a', 'stored'), photo('c', 'stored'), photo('n1')])).toEqual({ drops: ['b'], adds: [photo('n1')] });
    expect(photoSavePlan(start, [photo('n1'), photo('n2')])).toEqual({ drops: ['a', 'b', 'c'], adds: [photo('n1'), photo('n2')] });
    expect(photoSavePlan(start, start)).toEqual({ drops: [], adds: [] });
    expect(photoSavePlan([], [photo('n1'), photo('n2'), photo('n3')]).adds.map(p => p.version)).toEqual(['n1', 'n2', 'n3']);
  });

  it('the scan button: pick with no photo, scan a list not yet scanned, scanned for this exact list, reading while it reads', () => {
    const list = [photo('a'), photo('b')];
    expect(scanOffer([], null, false)).toBe('pick');
    expect(scanOffer(list, null, false)).toBe('scan');
    expect(scanOffer(list, 'a,b', false)).toBe('scanned');
    // Any change to the list offers the scan again.
    expect(scanOffer([photo('a')], 'a,b', false)).toBe('scan');
    expect(scanOffer([...list, photo('c')], 'a,b', false)).toBe('scan');
    expect(scanOffer(list, 'a,b', true)).toBe('reading');
  });
});

// ---------- the words ----------

const applied = (filled: ScanApplied['filled']): ScanApplied => ({ draft: {} as never, filled, notes: [], items: 0, openSplit: false, scannedText: {} as never });

describe('the words for two or three photos', () => {
  it('the scan button, the reading line, the viewer and the page titles', () => {
    expect([1, 2, 3].map(scanPhotosLabel)).toEqual(['掃描這張', '2 張一起掃描', '3 張一起掃描']);
    expect(scanReadingText(3)).toBe('正在一起讀 3 張…');
    expect([viewerTitleText(1, 1), viewerTitleText(2, 3)]).toEqual(['收據', '收據 2/3']);
    expect([receiptsTitleText(1), receiptsTitleText(3)]).toEqual(['收據', '收據（3 張）']);
    expect(photoPrefixText(2)).toBe('第 2 張：');
    expect(receiptLongHint()).toBe('收據太長的話，可以分成最多三張，從上面拍到下面。');
    setLocale('en');
    expect([1, 2, 3].map(scanPhotosLabel)).toEqual(['Scan it', 'Scan both', 'Scan all 3']);
    expect(scanReadingText(2)).toBe('Reading 2 photos…');
    expect([viewerTitleText(1, 1), viewerTitleText(2, 3)]).toEqual(['Receipt', 'Receipt 2 of 3']);
    expect(receiptsTitleText(3)).toBe('Receipts (3)');
    expect(photoPrefixText(2)).toBe('Photo 2: ');
    expect(receiptLongHint()).toBe('For a long receipt, take up to three photos, from the top down.');
  });

  it('picking: trimmed, a duplicate, photos that would not open', () => {
    expect(receiptTrimmedText(2)).toBe('一筆最多三張，多選的 2 張沒有加進來');
    expect(receiptDuplicateText()).toBe('這張已經加過了');
    expect(receiptPhotoErrorText()).toBe('打不開這張照片，請換一張試試');
    expect(receiptPhotoErrorText(2)).toBe('有 2 張照片打不開，沒有加進來');
    setLocale('en');
    expect([receiptTrimmedText(1), receiptTrimmedText(2)]).toEqual(['An expense keeps up to three photos, so 1 was not added', 'An expense keeps up to three photos, so 2 were not added']);
    expect(receiptDuplicateText()).toBe('This photo is already here');
    expect(receiptPhotoErrorText(3)).toBe('3 photos could not be opened, so they were not added');
  });

  it('the summary says how many photos it read, and the nudge comes when fewer than three were read and no total was found', () => {
    const r = applied(['amount', 'date', 'description']);
    expect(scanSummaryText(r, [], false)).toBe('已從收據填入金額、日期和店名');
    expect(scanSummaryText(r, [], false, 3, true)).toBe('已從 3 張收據照片填入金額、日期和店名');
    expect(scanSummaryText(r, ['照片上有不只一個總額，用了第 3 張的 ¥4,809，請確認'], false, 3, true)).toBe('已從 3 張收據照片填入金額、日期和店名。照片上有不只一個總額，用了第 3 張的 ¥4,809，請確認');
    expect(scanSummaryText(r, [], false, 2, false)).toBe('已從 2 張收據照片填入金額、日期和店名。收據太長的話，可以加一張有總額的照片，再掃描一次');
    expect(scanSummaryText(r, [], false, 1, false)).toBe('已從收據填入金額、日期和店名。收據太長的話，可以加一張有總額的照片，再掃描一次');
    // Three photos without a total, or a server that does not say: no nudge.
    expect([scanNudge(3, false), scanNudge(2, true), scanNudge(1, undefined), scanNudge(2, false)]).toEqual([false, false, false, true]);
    // The first scan on a device says what happens to the photos.
    expect(scanSummaryText(r, [], true, 2, true)).toBe('已從 2 張收據照片填入金額、日期和店名。照片會附在這筆費用上，群組的人看得到；掃描會一起讀這筆的所有照片（最多三張）。不想留的話，點「收據」移除');
    setLocale('en');
    expect(scanSummaryText(r, [], false, 3, false)).toBe('Filled in the amount, date and store name from 3 receipt photos');
    expect(scanSummaryText(r, [], false, 2, false)).toBe('Filled in the amount, date and store name from 2 receipt photos. If the receipt is long, add a photo that shows the total and scan again');
    expect(scanSummaryText(applied([]), [], true, 1, true)).toBe(
      'Nothing from the receipt could be filled in. The photos are kept with this expense for the group to see, and a scan reads all of its photos together (up to three). To take one off, tap Receipt',
    );
  });

  it('errors for two or three photos say these photos do not fit or cannot be read; one photo keeps its words', () => {
    const e = (status: number, code: string, details?: unknown) => new ApiError(status, code as never, 'x', details);
    expect(scanErrorText(e(429, 'rate_limited', { scope: 'user' }), 3)).toBe('你今天的收據掃描次數不夠讀這 3 張了，明天再試，或直接輸入');
    expect(scanErrorText(e(429, 'rate_limited', { scope: 'ai' }), 2)).toBe('今天的收據辨識額度不夠一起讀這 2 張了，明天再試，或直接輸入');
    // The app's count too (review C19): three photos may not fit where one still would.
    expect(scanErrorText(e(429, 'rate_limited', { scope: 'app' }), 3)).toBe('今天的收據掃描不夠一起讀這 3 張了，明天再試，或直接輸入');
    expect(scanErrorText(e(429, 'rate_limited', { scope: 'app' }), 1)).toBe('今天的收據掃描已經額滿，明天再試，或直接輸入');
    expect(scanErrorText(e(502, 'scan_failed', { reason: 'unreadable' }), 3)).toBe('看不清楚這幾張收據，請拍清楚一點再試，或直接輸入');
    expect(scanErrorText(e(502, 'scan_failed', { reason: 'timeout' }), 3)).toBe('讀取收據太久了，請再試一次');
    expect(scanErrorText(e(413, 'payload_too_large'), 2)).toBe('這幾張照片加起來太大了，沒能送出去');
    expect(scanErrorText(new ScanError('timeout'), 3)).toBe('讀取收據太久了，請再試一次');
    // One photo: today's words.
    expect(scanErrorText(e(429, 'rate_limited', { scope: 'user' }))).toBe('你今天的收據掃描次數用完了，明天再試，或直接輸入');
    expect(scanErrorText(e(429, 'rate_limited', { scope: 'ai' }), 1)).toBe('今天的收據辨識額度用完了，明天再試，或直接輸入');
    expect(scanErrorText(e(502, 'scan_failed', { reason: 'unreadable' }), 1)).toBe('看不清楚這張收據，請拍清楚一點再試，或直接輸入');
    expect(scanErrorText(e(413, 'payload_too_large'), 1)).toBe('照片太大了，請換一張試試');
    setLocale('en');
    expect(scanErrorText(e(429, 'rate_limited', { scope: 'user' }), 3)).toBe("You don't have enough receipt scans left today for 3 photos. Try again tomorrow, or type it in");
    expect(scanErrorText(e(429, 'rate_limited', { scope: 'ai' }), 3)).toBe("Today's receipt reading can't cover 3 photos now. Try again tomorrow, or type it in");
    expect(scanErrorText(e(429, 'rate_limited', { scope: 'app' }), 2)).toBe("Today's receipt scans can't cover 2 photos now. Try again tomorrow, or type it in");
    expect(scanErrorText(e(429, 'rate_limited', { scope: 'app' }), 1)).toBe('Receipt scans are full for today. Try again tomorrow, or type it in');
    expect(scanErrorText(e(502, 'scan_failed', { reason: 'unreadable' }), 2)).toBe('These receipt photos cannot be read. Take sharper photos, or type it in');
    expect(scanErrorText(e(413, 'payload_too_large'), 3)).toBe('These photos are too large together to send');
  });

  it('an upload refused because the expense has three photos says so', () => {
    expect(receiptStatusText({ failed: true, code: 'limit_reached' }, true)).toBe('這筆已經有三張收據照片了，這張沒有存');
    setLocale('en');
    expect(receiptStatusText({ failed: true, code: 'limit_reached' }, true)).toBe('This expense already has three receipt photos, so this one was not kept');
  });

  it('儲存 or another group while photos are still being prepared says to wait (review C20)', () => {
    expect(photosPreparingText()).toBe('照片還在準備中，請稍等一下');
    setLocale('en');
    expect(photosPreparingText()).toBe('Still preparing the photos. One moment');
  });
});

// ---------- asking before the first scan ----------

describe('asking before an account first scans here (App Review guideline 5.1.2(i))', () => {
  it('is kept per account in this browser, is never taken as given without an account, and 我的 resets it', () => {
    expect(hasScanConsent('U1')).toBe(false);
    giveScanConsent('U1');
    expect([hasScanConsent('U1'), hasScanConsent('U2')]).toEqual([true, false]);
    expect(localStorage.getItem('evenly.scanConsent.U1')).toBe('1');
    // Another version of what was agreed to asks again.
    localStorage.setItem('evenly.scanConsent.U2', '0');
    expect(hasScanConsent('U2')).toBe(false);
    // No account known: asked every time, and nothing is kept.
    giveScanConsent(null);
    expect([hasScanConsent(null), hasScanConsent(undefined), localStorage.getItem('evenly.scanConsent.')]).toEqual([false, false, null]);
    resetScanConsent('U1');
    expect(hasScanConsent('U1')).toBe(false);
    localStorage.removeItem('evenly.scanConsent.U2');
  });

  it('the words, in both languages (the iPhone app asks with the same ones)', () => {
    expect(scanConsentText()).toEqual({
      title: '掃描會把收據照片傳給 AI',
      message: '掃描時，這筆費用的收據照片會傳給第三方 AI 服務 Cloudflare Workers AI，讀出金額、日期、店名和品項。只附上、沒有掃描的照片不會傳出去。同意後，這個帳號在這裡掃描就不會再問，可以在「我的」重設。',
      confirm: '同意並掃描',
      cancel: '取消',
      link: '隱私權政策',
      privacy: '/privacy/#zh-scan',
    });
    expect([scanConsentCardText(true), scanConsentCardText(false).body]).toEqual([
      { title: '收據掃描', body: '你已同意：掃描時，收據照片會傳給 Cloudflare Workers AI 讀取。', reset: '下次掃描前再問我', done: '下次掃描前會再問你' },
      '第一次掃描前會先問你，同意後才會把收據照片傳給 Cloudflare Workers AI。',
    ]);
    setLocale('en');
    expect(scanConsentText()).toEqual({
      title: 'Scanning sends your receipt photos to AI',
      message: "When you scan, this expense's receipt photos are sent to Cloudflare Workers AI, a third-party AI service, to read the amount, date, store and items. Photos you only attach are not sent. Once you agree, this account won't be asked again here, and you can reset this in Account.",
      confirm: 'Agree and scan',
      cancel: 'Cancel',
      link: 'Privacy policy',
      privacy: '/privacy/#en-scan',
    });
    expect([scanConsentCardText(true), scanConsentCardText(false).body]).toEqual([
      { title: 'Receipt scanning', body: 'You agreed: when you scan, receipt photos are sent to Cloudflare Workers AI to be read.', reset: 'Ask me again next time', done: "You'll be asked again before your next scan" },
      "You'll be asked before your first scan. Receipt photos are sent to Cloudflare Workers AI only once you agree.",
    ]);
  });
});
