// 從 Splitwise 匯入: pick a Splitwise CSV export (a group or a friend), match each person in it to
// a member (or add them by name), give one rate per other currency (prefilled with today's rate,
// or mark the rows as really being in the group currency), check the preview, then import.
// What gets imported is exactly what the preview showed: if adding the new people moves any
// number, the sheet shows the new numbers and waits for another press. Entries the group already
// has are not sent again, and the done screen says which entries did not go in and why (the group
// was full, or the server refused them). A file that is not UTF-8 is refused (its Chinese would be
// garbled), and one in another language than English gets a note about its payments.
// The parsing and mapping live in splitwiseImport.ts.

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { currencyName } from '../../../shared/currencies';
import { todayISO } from '../../../shared/dates';
import type { GroupSnapshotDTO } from '../../../shared/types';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Money, MoneyStatus } from '../../components/Money';
import { Sheet } from '../../components/Sheet';
import { Spinner } from '../../components/Spinner';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useT } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { actions, useStore } from '../../lib/store';
import { parseRate as parseEditorRate } from '../expenses/editorLogic';
import { cx } from './cx';
import { cleanName } from './memberNames';
import { radioKeys } from './NewGroupPage';
import { isPairLedger } from './settingsRules';
import {
  buildImport,
  entryRoom,
  fileCurrencies,
  fillPairMapping,
  importInBatches,
  importOutcome,
  parseSplitwiseCsv,
  samePreview,
  suggestMembers,
  type ImportOptions,
  type ImportOutcome,
  type SplitwiseFile,
  type SplitwiseParseError,
  type SplitwiseSkipReason,
} from './splitwiseImport';
import s from './ImportSplitwise.module.css';

/** Mapping value for "add this person as a new member". */
const NEW = '';
const MAX_FILE_BYTES = 5_000_000;
const MAX_ACTIVE = 50;
/** People in a 1:1 ledger (routes/groups.ts PAIR_MEMBERS). */
const PAIR_MEMBERS = 2;
/** How long typing in a rate box pauses before the preview is built again with it. */
const RATE_SETTLE_MS = 300;

/** English singular or plural template (Chinese needs none). */
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

type Step = 'pick' | 'review' | 'importing' | 'done';

function norm(n: string): string {
  return n.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A typed rate, read the same way as in the expense editor ("1,400" is 1400, "0,21" is 0.21). */
function parseRate(text: string | undefined): number | null {
  if (!text) return null;
  return parseEditorRate(text);
}

function rateText(r: number): string {
  return String(Number(r.toPrecision(6)));
}

export function ImportSplitwise({ open, onClose, gid, snap }: { open: boolean; onClose: () => void; gid: string; snap: GroupSnapshotDTO }) {
  const { t, locale, date } = useT();
  const me = useStore(st => st.me);
  const online = useStore(st => st.online);
  const [step, setStep] = useState<Step>('pick');
  const [fileName, setFileName] = useState('');
  const [file, setFile] = useState<SplitwiseFile | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<string[]>([]);
  const [rates, setRates] = useState<Record<string, string>>({});
  // The rates the preview is built with: what is typed, once typing stops for RATE_SETTLE_MS, so a
  // long file is not built again on every keystroke. 匯入 waits until the two are the same.
  const [planRates, setPlanRates] = useState<Record<string, string>>(rates);
  const [relabel, setRelabel] = useState<Record<string, boolean>>({});
  const [fxLoading, setFxLoading] = useState(false);
  // The prefilled rates' date, and whether they are an older copy kept on this device (no connection).
  const [fxInfo, setFxInfo] = useState<{ date: string; stale: boolean } | null>(null);
  const [done, setDone] = useState(0);
  // byRows: the room was the 20,000 rows, deleted ones included (entryRoom).
  const [result, setResult] = useState<(ImportOutcome & { byRows: boolean }) | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openMap, setOpenMap] = useState<number | null>(null);

  const base = snap.group.currency;
  const meId = snap.me.memberId;
  const today = todayISO();
  const activeMembers = snap.members.filter(m => m.active);
  const leftMembers = snap.members.filter(m => !m.active);
  // A 1:1 ledger holds two people (the Worker refuses a third, limit_reached pair_members): with
  // both in it, a column can only be one of them (review W3-contract-02).
  const pair = isPairLedger(snap.group);
  const cap = pair ? PAIR_MEMBERS : MAX_ACTIVE;
  /** A column may still be added as a new member. */
  const canAdd = activeMembers.length < cap;

  useEffect(() => {
    if (planRates === rates) return;
    const timer = setTimeout(() => setPlanRates(rates), RATE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [rates, planRates]);

  /** No rates typed: the preview uses the same (empty) ones at once. */
  function clearRates() {
    const none: Record<string, string> = {};
    setRates(none);
    setPlanRates(none);
    setFxInfo(null);
  }

  function reset() {
    setStep('pick');
    setFileName('');
    setFile(null);
    setReadError(null);
    setMapping([]);
    clearRates();
    setRelabel({});
    setDone(0);
    setResult(null);
    setImportError(null);
    setNotice(null);
    setOpenMap(null);
  }

  function close() {
    if (step === 'importing') return;
    reset();
    onClose();
  }

  const parseMessage = (e: SplitwiseParseError): string => {
    switch (e) {
      case 'empty':
        return t('這個檔案是空的', 'This file is empty');
      case 'no_people':
        return t('檔案裡找不到每個人的欄位，請用 Splitwise 的「匯出成試算表」重新下載。', 'There are no person columns in this file. Download it again with Export as spreadsheet in Splitwise.');
      default:
        return t('這看起來不是 Splitwise 匯出的檔案', 'This does not look like a Splitwise export');
    }
  };

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setReadError(null);
    if (f.size > MAX_FILE_BYTES) {
      setReadError(t('檔案太大了，最多 5 MB', 'That file is too big (5 MB at most)'));
      return;
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await f.arrayBuffer();
    } catch {
      setReadError(t('讀不到這個檔案，請再試一次', 'Could not read that file. Try again'));
      return;
    }
    // Splitwise writes UTF-8. A copy saved again in another encoding (Excel's plain CSV on a Chinese
    // Windows writes Big5) would read as garbage: names that match nobody would be added as new
    // members, so such a file is refused rather than guessed at.
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      setReadError(
        t(
          '這個檔案不是 UTF-8 編碼，中文會變成亂碼。請直接用 Splitwise 下載的檔案，或在 Excel 另存成「CSV UTF-8」。',
          'This file is not in UTF-8, so Chinese text would come out garbled. Use the file as Splitwise downloaded it, or save it from Excel as CSV UTF-8.',
        ),
      );
      return;
    }
    let r: ReturnType<typeof parseSplitwiseCsv>;
    try {
      r = parseSplitwiseCsv(text);
    } catch {
      setReadError(t('讀不到這個檔案，請再試一次', 'Could not read that file. Try again'));
      return;
    }
    if (!r.ok) {
      setReadError(parseMessage(r.error));
      return;
    }
    if (r.file.rows.length === 0) {
      setReadError(t('這個檔案裡沒有任何費用', 'This file has no expenses in it'));
      return;
    }
    const myMember = snap.members.find(m => m.id === meId);
    const names = [me?.user.name ?? '', myMember?.name ?? ''].filter(Boolean);
    const suggested = suggestMembers(
      r.file.people,
      snap.members.map(m => ({ id: m.id, name: m.name, active: m.active })),
      { memberId: meId, names },
    );
    const mapped = suggested.map(x => x ?? NEW);
    setFile(r.file);
    setFileName(f.name);
    // In a full 1:1 ledger, the one column nobody matched is the one of us nobody matched.
    setMapping(pair && !canAdd ? fillPairMapping(mapped, activeMembers.map(m => m.id)) : mapped);
    clearRates();
    setRelabel({});
    setStep('review');
    void prefillRates(r.file);
  }

  async function prefillRates(f: SplitwiseFile) {
    const foreign = fileCurrencies(f).filter(c => c !== base);
    if (foreign.length === 0) return;
    setFxLoading(true);
    try {
      const fx = await actions.getFx(base, today);
      if (!fx) return;
      // Without a connection (or after 8 s), getFx answers with the rates last kept on this device,
      // which can be months old: the note says their date, and asks to check them.
      setFxInfo({ date: fx.date, stale: !!fx.stale });
      setRates(prev => {
        const next = { ...prev };
        for (const c of foreign) {
          const r = fx.rates[c];
          if (!next[c] && typeof r === 'number' && r > 0) next[c] = rateText(r);
        }
        return next;
      });
    } finally {
      setFxLoading(false);
    }
  }

  const foreign = useMemo(() => {
    if (!file) return [] as { code: string; rows: number }[];
    const counts = new Map<string, number>();
    for (const r of file.rows) if (/^[A-Z]{3}$/.test(r.currency) && r.currency !== base) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
    return fileCurrencies(file).filter(c => c !== base).map(code => ({ code, rows: counts.get(code) ?? 0 }));
  }, [file, base]);

  const options = useMemo((): Omit<ImportOptions, 'memberIds'> => {
    const parsed: Record<string, number> = {};
    const relabelMap: Record<string, string> = {};
    for (const { code } of foreign) {
      if (relabel[code]) relabelMap[code] = base;
      else {
        const r = parseRate(planRates[code]);
        if (r !== null) parsed[code] = r;
      }
    }
    return {
      groupId: gid,
      groupCurrency: base,
      rates: parsed,
      relabel: relabelMap,
      today,
      fallbackDescription: t('（沒有說明）', '(no description)'),
      costNote: (cost, cur) => t('從 Splitwise 匯入，有好幾個人付款。原本的金額是 {cur} {cost}。', 'Imported from Splitwise; several people paid. The original cost was {cur} {cost}.', { cost, cur }),
    };
  }, [foreign, relabel, planRates, base, gid, today, t]);

  const plan = useMemo(() => (file ? buildImport(file, { ...options, memberIds: mapping.map((m, i) => m || `new:${i}`) }) : null), [file, options, mapping]);

  const missingRates = foreign.filter(c => !relabel[c.code] && parseRate(rates[c.code]) === null).map(c => c.code);
  const newCount = mapping.filter(m => m === NEW).length;
  const tooMany = activeMembers.length + newCount > cap;
  const merged = new Set(mapping.filter(Boolean)).size < mapping.filter(Boolean).length;
  // Entries of the file the group does not have yet, against the room it has left (the Worker skips
  // what does not fit, so the import says so before it starts).
  const knownIds = useMemo(() => new Set(snap.expenses.map(e => e.id)), [snap.expenses]);
  const freshCount = plan ? plan.entries.reduce((n, e) => (knownIds.has(e.id) ? n : n + 1), 0) : 0;
  const { room } = entryRoom(snap.expenses);
  const full = freshCount > 0 && room === 0;
  const ready = !!plan && plan.entries.length > 0 && missingRates.length === 0 && !tooMany && online && planRates === rates && !full;

  const nameFor = (id: string): string => {
    if (id.startsWith('new:')) return file?.people[Number(id.slice(4))] ?? '?';
    const m = snap.members.find(x => x.id === id);
    if (!m) return '?';
    return m.id === meId ? t('{name}（你）', '{name} (you)', { name: m.name }) : m.name;
  };

  const reasonText = (r: SplitwiseSkipReason): string => {
    switch (r) {
      case 'bad_date': return t('日期看不懂', 'the date is not readable');
      case 'date_range': return t('日期太早或太晚（2000 年以後、一年內）', 'the date is out of range (2000 to a year from now)');
      case 'bad_amount': return t('金額看不懂或是 0', 'the amount is not readable or rounds to 0');
      case 'bad_currency': return t('幣別看不懂', 'the currency is not readable');
      case 'no_rate': return t('還沒填這個幣別的匯率', 'no exchange rate for its currency yet');
      case 'no_change': return t('沒有人的帳因此改變（例如只有自己付自己）', 'nobody\'s balance changes (someone paid only for themselves)');
      case 'unbalanced': return t('每個人的金額加起來不是 0', 'the amounts per person do not add up to 0');
      case 'payment_shape': return t('付款不是一個人付給另一個人', 'the payment is not from one person to one other person');
      case 'too_large': return t('金額太大', 'the amount is too large');
      case 'too_many_people': return t('超過 50 個人', 'more than 50 people');
    }
  };

  async function runImport() {
    if (!file || !plan || !ready) return;
    // The preview being confirmed, and the member ids it was built with.
    const shown = plan;
    const shownIds = [...mapping];
    setStep('importing');
    setImportError(null);
    setNotice(null);
    setDone(0);
    const ids = [...mapping];
    let added = false;
    try {
      // Add the new people first, one by one; each id is kept right away so a retry
      // after a failure does not add anyone twice.
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] !== NEW) continue;
        // Cut to the 60 UTF-16 units the Worker takes (memberNames.ts).
        const name = cleanName(file.people[i]) || t('Splitwise 成員', 'Splitwise member');
        const m = await actions.addMember(gid, { name });
        ids[i] = m.id;
        added = true;
        setMapping([...ids]);
      }
      const final = buildImport(file, { ...options, memberIds: ids });
      if (added && !samePreview(file, shown, shownIds, final, ids)) {
        // Converting other currencies breaks rounding ties by member id, which the new people
        // only have now. Show the numbers that will really be imported and wait for another press.
        setNotice(
          t(
            '新成員已經加進群組了。有幾筆換算成 {base} 的金額，四捨五入後差了一點，結餘已經更新。確認後請再按一次匯入。',
            'The new members are in the group now. A few amounts converted into {base} round a little differently, so the balances are updated. Check them and press Import again.',
            { base },
          ),
        );
        setStep('review');
        return;
      }
      // The group as it is now (a run that stopped part way, or another device, may have imported
      // some of these): entries it has are counted as imported before and not sent again, so they
      // never use up the room the Worker leaves for new ones (a Worker from before review B6b-02
      // counts every entry it is sent; today's skips them as exists first).
      const latest = (await actions.loadGroup(gid, { force: true })) ?? snap;
      const known = new Set(latest.expenses.map(e => e.id));
      // Rates were chosen against the group currency the preview used: the Worker converts them if
      // the group currency changes meanwhile (rateBase), whatever the device has loaded by then.
      const todo = final.entries.filter(e => !known.has(e.id)).map(e => ({ ...e, rateBase: options.groupCurrency }));
      const { room, byRows } = entryRoom(latest.expenses);
      // Why the Worker left each entry out (exists, limit_reached, or a field it refused), so the
      // done screen says which, rather than guessing from counts (review B6b-02).
      const skipped: string[] = [];
      let imported = 0;
      if (todo.length) {
        try {
          imported = await importInBatches(
            todo,
            async batch => {
              // The group is loaded once, after the last batch, not after each one (review B6b-04).
              const r = await actions.importExpenses(gid, batch, { reload: false });
              for (const x of r.skipped) skipped.push(x.code);
              return r.imported;
            },
            e => e instanceof ApiError && (e.status === 413 || e.code === 'payload_too_large'),
            n => setDone(n),
          );
        } finally {
          // Also after a batch that failed: what went in before it shows.
          await actions.loadGroup(gid, { force: true }).catch(() => null);
          void actions.loadMe();
        }
      }
      setResult({ ...importOutcome(final.entries.length, todo.length, imported, room, skipped), byRows });
      setStep('done');
    } catch (e) {
      setImportError(errorMessage(e));
      setStep('review');
    }
  }

  const people = plan ? Object.keys(plan.netByMember) : [];

  const footer =
    step === 'review' ? (
      <div className={s.footer}>
        {importError ? (
          <p className={s.error} role="alert">
            <Icon name="warning" size={16} />
            {importError}
          </p>
        ) : null}
        {notice && !importError ? (
          <p className={s.notice} role="status" data-testid="import-recheck">
            <Icon name="info" size={16} />
            {notice}
          </p>
        ) : null}
        <Button variant="primary" size="lg" block disabled={!ready} onClick={() => void runImport()} data-testid="import-submit">
          {plan && plan.entries.length > 0 ? t('匯入 {n} 筆', plural(plan.entries.length, 'Import {n} entry', 'Import {n} entries'), { n: plan.entries.length }) : t('匯入', 'Import')}
        </Button>
      </div>
    ) : step === 'done' ? (
      <div className={s.footer}>
        <Button
          variant="primary"
          size="lg"
          block
          onClick={() => {
            close();
            navigate('/g/' + encodeURIComponent(gid));
          }}
        >
          {t('查看費用', 'See the expenses')}
        </Button>
      </div>
    ) : undefined;

  return (
    <Sheet open={open} onClose={close} title={t('從 Splitwise 匯入', 'Import from Splitwise')} size="full" dismissible={step !== 'importing'} footer={footer}>
      <div className={s.body}>
        {step === 'pick' ? (
          <div className={s.pickStep}>
            <ol className={s.steps}>
              <li>{t('在 Splitwise 網頁版打開要搬過來的群組或朋友', 'In Splitwise on the web, open the group or friend you want to bring over')}</li>
              <li>{t('選「匯出成試算表」（Export as spreadsheet），下載 CSV 檔', 'Choose Export as spreadsheet and download the CSV file')}</li>
              <li>{t('在這裡選那個檔案，確認內容後匯入', 'Pick that file here, check the preview, and import')}</li>
            </ol>
            <label className={s.pick}>
              <input
                type="file"
                accept=".csv,text/csv,text/comma-separated-values"
                className="sr-only"
                onChange={e => void onFile(e)}
                data-testid="import-file"
              />
              <Icon name="upload" size={20} />
              <span>{t('選擇 CSV 檔', 'Choose a CSV file')}</span>
            </label>
            {readError ? (
              <p className={s.error} role="alert">
                <Icon name="warning" size={16} />
                {readError}
              </p>
            ) : null}
            <p className={s.note}>
              {t(
                '費用、付款和每個人的份都會照原樣匯入「{group}」。同一個檔案匯入兩次，也不會重複。',
                'Expenses, payments and everyone\'s part come into {group} as they are. Importing the same file again adds nothing twice.',
                { group: snap.group.name },
              )}
            </p>
          </div>
        ) : null}

        {(step === 'review' || step === 'importing') && file && plan ? (
          <div className={cx(s.review, step === 'importing' && s.busy)} aria-busy={step === 'importing'}>
            <p className={s.fileLine}>
              <Icon name="note" size={18} />
              <span className={s.fileName}>{fileName}</span>
              <button type="button" className={s.change} onClick={reset} disabled={step === 'importing'}>
                {t('換一個檔案', 'Pick another file')}
              </button>
            </p>
            {/* A file in another language: its payments are known only in the languages seen so far. */}
            {!file.english && plan.paymentCount === 0 ? (
              <p className={s.notice} data-testid="import-language-note">
                <Icon name="info" size={16} />
                {t(
                  '這個檔案不是英文版的 Splitwise 匯出，付款可能會被當成費用。建議先把 Splitwise 的語言改成 English 再匯出。',
                  'This is not an English Splitwise export, so payments may come in as expenses. To be safe, switch Splitwise to English and export again.',
                )}
              </p>
            ) : null}

            <section className={s.section} aria-labelledby="sw-people">
              <h3 className={s.h} id="sw-people">{t('檔案裡的人', 'People in the file')}</h3>
              <p className={s.note}>
                {pair && !canAdd
                  ? t('每一欄要對到你們哪一位？', 'Which of you is each column?')
                  : t('每一欄要對到群組裡的誰？對不到的會用名字新增成員。', 'Who is each column in this group? Anyone not matched is added by name.')}
              </p>
              <div className={s.panel}>
                {file.people.map((p, i) => {
                  const value = mapping[i] ?? NEW;
                  const isOpen = openMap === i;
                  // Adding by name only while the group has room for one more (never in a full 1:1 ledger).
                  const choices = [...(canAdd ? [NEW] : []), ...activeMembers.map(m => m.id), ...leftMembers.map(m => m.id)];
                  // Nothing picked yet (a new member that cannot be added): the first choice takes the focus.
                  const firstFocus = choices.includes(value) ? value : choices[0];
                  const choiceLabel = (id: string) => (id === NEW ? t('用名字新增「{name}」', 'Add "{name}" by name', { name: p }) : nameFor(id));
                  const pick = (id: string) => setMapping(list => list.map((x, j) => (j === i ? id : x)));
                  return (
                    <div key={i} className={s.mapItem}>
                      <button
                        type="button"
                        className={s.mapRow}
                        aria-expanded={isOpen}
                        aria-controls={`sw-map-${i}`}
                        disabled={step === 'importing'}
                        onClick={() => setOpenMap(isOpen ? null : i)}
                      >
                        <span className={s.mapName}>{p}</span>
                        <Icon name="arrowRight" size={16} className={s.mapArrow} />
                        <span className={cx(s.mapValue, value === NEW && s.mapNew)}>{value === NEW ? t('新成員', 'New member') : nameFor(value)}</span>
                        <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={18} className={s.chev} />
                      </button>
                      {isOpen ? (
                        <div
                          id={`sw-map-${i}`}
                          className={s.options}
                          role="radiogroup"
                          aria-label={t('「{name}」是誰', 'Who "{name}" is', { name: p })}
                          onKeyDown={e => radioKeys(e, choices, value, pick)}
                        >
                          {choices.map(id => {
                            const on = id === value;
                            const gone = !!id && leftMembers.some(m => m.id === id);
                            return (
                              <button
                                key={id || '_new'}
                                type="button"
                                role="radio"
                                aria-checked={on}
                                tabIndex={id === firstFocus ? 0 : -1}
                                className={cx(s.option, on && s.optionOn)}
                                onClick={() => {
                                  pick(id);
                                  setOpenMap(null);
                                }}
                              >
                                <span className={s.optionMark} aria-hidden="true">
                                  {on ? <Icon name="check" size={16} strokeWidth={2.4} /> : null}
                                </span>
                                <span className={s.optionText}>{choiceLabel(id)}</span>
                                {gone ? <span className={s.optionNote}>{t('已離開', 'left')}</span> : null}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {merged ? <p className={s.note}>{t('有幾欄對到同一個人，他們的金額會加在一起。', 'Some columns go to the same person; their amounts are added together.')}</p> : null}
              {tooMany ? (
                <p className={s.error} role="alert" data-testid="import-too-many">
                  <Icon name="warning" size={16} />
                  {pair
                    ? t('兩人帳本只有你們兩個人。請把每一欄都對到你們其中一位。', 'A friend ledger holds just the two of you. Match every column to one of you.')
                    : t('一個群組最多 50 人。請把一些欄對到現有的成員。', 'A group can have at most 50 people. Match some columns to existing members.')}
                </p>
              ) : null}
            </section>

            {foreign.length > 0 ? (
              <section className={s.section} aria-labelledby="sw-fx">
                <h3 className={s.h} id="sw-fx">{t('匯率', 'Exchange rates')}</h3>
                <p className={s.note} data-testid="import-fx-note">
                  {fxInfo
                    ? t(
                        // {d} is 「2026年11月7日」: no space between it and 的 (DESIGN.md 13.2).
                        '這個群組用 {base}。其他幣別的費用要換算，已先填好 {d}的匯率，可以改。',
                        'This group uses {base}. Entries in other currencies are converted: the rates of {d} are filled in, and you can change them.',
                        { base, d: date(fxInfo.date, 'long') },
                      ) +
                      (fxInfo.stale
                        ? t('（網路不穩，這是之前存下的匯率，請確認）', ' (The connection is unstable, so these are rates saved earlier. Check them.)')
                        : '')
                    : fxLoading
                      ? t('這個群組用 {base}。其他幣別的費用要換算，正在找今天的匯率。', 'This group uses {base}. Entries in other currencies are converted; looking up today\'s rates.', { base })
                      : t('這個群組用 {base}。其他幣別的費用要換算，請填匯率。', 'This group uses {base}. Entries in other currencies are converted; enter a rate for each.', { base })}
                  {fxLoading ? <Spinner size={14} /> : null}
                </p>
                {foreign.map(({ code, rows }) => (
                  <div key={code} className={s.fxRow}>
                    <p className={s.fxHead}>
                      <span className={s.code}>{code}</span>
                      <span className={s.fxName}>{currencyName(code, locale)}</span>
                      <span className={s.count}>{t('{n} 筆', plural(rows, '{n} row', '{n} rows'), { n: rows })}</span>
                    </p>
                    {!relabel[code] ? (
                      <label className={s.rate}>
                        <span className={s.rateSide}>1 {code} =</span>
                        <input
                          className={cx(s.rateInput, parseRate(rates[code]) === null && s.rateBad)}
                          value={rates[code] ?? ''}
                          inputMode="decimal"
                          enterKeyHint="done"
                          autoComplete="off"
                          disabled={step === 'importing'}
                          aria-label={t('1 {code} 等於多少 {base}', 'How many {base} one {code} is worth', { code, base })}
                          onChange={e => {
                            const v = e.target.value;
                            setRates(prev => ({ ...prev, [code]: v }));
                          }}
                        />
                        <span className={s.rateSide}>{base}</span>
                      </label>
                    ) : null}
                    <label className={s.check}>
                      <input
                        type="checkbox"
                        checked={!!relabel[code]}
                        disabled={step === 'importing'}
                        onChange={e => {
                          const v = e.target.checked;
                          setRelabel(prev => ({ ...prev, [code]: v }));
                        }}
                      />
                      <span>
                        {t('這些其實是 {base}', 'These were really {base}', { base })}
                        <span className={s.checkNote}>
                          {t('Splitwise 有時會把日圓之類的金額存成別的幣別。勾選後數字不換算，直接當成 {base}。', 'Splitwise sometimes saved yen and similar amounts under another currency. Check this to keep the numbers as they are, in {base}.', { base })}
                        </span>
                      </span>
                    </label>
                  </div>
                ))}
                {missingRates.length > 0 ? (
                  <p className={s.error} role="alert">
                    <Icon name="warning" size={16} />
                    {t('請填 {codes} 的匯率', 'Enter a rate for {codes}', { codes: missingRates.join(t('、', ', ')) })}
                  </p>
                ) : null}
              </section>
            ) : null}

            <section className={s.section} aria-labelledby="sw-preview">
              <h3 className={s.h} id="sw-preview">{t('匯入前確認', 'Before you import')}</h3>
              <div className={s.preview}>
                <p className={s.lead}>
                  <span className={s.leadLabel}>{t('可以匯入', 'Ready to import')}</span>
                  <i className={s.leader} aria-hidden="true" />
                  <span className={s.leadValue}>{t('{n} 筆', '{n}', { n: plan.entries.length })}</span>
                </p>
                <p className={s.sub}>
                  {plan.refundCount
                    ? t(
                        '{e} 筆費用、{r} 筆退款、{p} 筆付款',
                        plural(plan.expenseCount - plan.refundCount, '{e} expense', '{e} expenses') +
                          plural(plan.refundCount, ', {r} refund', ', {r} refunds') +
                          plural(plan.paymentCount, ', {p} payment', ', {p} payments'),
                        { e: plan.expenseCount - plan.refundCount, r: plan.refundCount, p: plan.paymentCount },
                      )
                    : t('{e} 筆費用、{p} 筆付款', plural(plan.expenseCount, '{e} expense', '{e} expenses') + plural(plan.paymentCount, ', {p} payment', ', {p} payments'), { e: plan.expenseCount, p: plan.paymentCount })}
                  {plan.firstDate && plan.lastDate
                    ? t('，{a} 到 {b}', ', {a} to {b}', { a: date(plan.firstDate, 'long'), b: date(plan.lastDate, 'long') })
                    : ''}
                </p>
                <p className={s.lead}>
                  <span className={s.leadLabel}>{t('總花費', 'Total spent')}</span>
                  <i className={s.leader} aria-hidden="true" />
                  <span className={s.leadValue}>
                    <Money amount={plan.spent} currency={base} />
                  </span>
                </p>

                <hr className={s.dash} />
                <p className={s.sub}>{t('匯入後每個人的結餘（{base}）', 'Each person\'s balance after the import ({base})', { base })}</p>
                <ul className={s.nets} role="list">
                  {people.map(id => {
                    const net = plan.netByMember[id] ?? 0;
                    const want = plan.expected ? plan.expected[id] : undefined;
                    return (
                      <li key={id} className={s.netRow}>
                        <span className={s.netName}>
                          {nameFor(id)}
                          {id.startsWith('new:') ? <span className={s.newTag}>{t('新成員', 'new')}</span> : null}
                        </span>
                        <span className={s.netValue}>
                          <MoneyStatus amount={net} currency={base} kind={id === meId ? 'groupMine' : 'member'} size="sm" />
                          {want !== undefined ? (
                            want === net ? (
                              <span className={s.match}>
                                <Icon name="check" size={14} strokeWidth={2.4} />
                                {t('和 Splitwise 一樣', 'matches Splitwise')}
                              </span>
                            ) : (
                              <span className={s.mismatch}>
                                {t('Splitwise：', 'Splitwise: ')}
                                <Money amount={want} currency={base} />
                              </span>
                            )
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className={s.foot}>
                  {t('※ 只算這個檔案裡的費用，不含群組裡原本的帳', 'Note: only the entries in this file, not what the group already has')}
                </p>
                {plan.rounded > 0 ? (
                  <p className={s.foot}>
                    {t('※ {n} 筆有小數的金額，已四捨五入成整數（這些幣別沒有小數）', plural(plan.rounded, 'Note: {n} entry had cents in a currency without them and was rounded to whole units', 'Note: {n} entries had cents in a currency without them and were rounded to whole units'), { n: plan.rounded })}
                  </p>
                ) : null}
              </div>

              {freshCount > room ? (
                <p className={s.error} role="alert" data-testid="import-room">
                  <Icon name="warning" size={16} />
                  {room === 0
                    ? t('這個群組已經放滿了，不能再匯入新的費用。', 'This group is full, so no new entries can be imported.')
                    : t('這個群組只能再放 {room} 筆，超過的不會匯入。', plural(room, 'This group has room for {room} more entry; the rest will not be imported.', 'This group has room for {room} more entries; the rest will not be imported.'), { room })}
                </p>
              ) : null}

              {plan.skipped.length > 0 ? (
                <details className={s.skipped}>
                  <summary className={s.skippedSummary}>
                    <Icon name="info" size={16} />
                    {t('略過 {n} 筆（看原因）', plural(plan.skipped.length, 'Skipping {n} row (see why)', 'Skipping {n} rows (see why)'), { n: plan.skipped.length })}
                  </summary>
                  <ul className={s.skipList} role="list">
                    {plan.skipped.map((r, i) => (
                      <li key={i} className={s.skipRow}>
                        <span className={s.skipWhere}>
                          {t('第 {line} 行', 'Line {line}', { line: r.line })}
                          {r.date ? t('，', ', ') + r.date : ''}
                        </span>
                        <span className={s.skipWhat}>{r.description || t('（沒有說明）', '(no description)')}</span>
                        <span className={s.skipWhy}>{reasonText(r.reason)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </section>

            {step === 'importing' ? (
              <p className={s.progress} role="status">
                <Spinner size={18} />
                {done > 0 ? t('匯入中，已完成 {n} 筆…', 'Importing, {n} done…', { n: done }) : t('匯入中…', 'Importing…')}
              </p>
            ) : null}
          </div>
        ) : null}

        {step === 'done' && result ? (
          <div className={s.doneStep} role="status">
            <span className={s.doneIcon} aria-hidden="true">
              <Icon name="check" size={30} strokeWidth={3} />
            </span>
            <p className={s.doneTitle}>{t('已匯入 {n} 筆', plural(result.imported, 'Imported {n} entry', 'Imported {n} entries'), { n: result.imported })}</p>
            {result.already > 0 ? (
              <p className={s.note}>
                {t('另外 {n} 筆之前已經匯入過，沒有重複加入', plural(result.already, '{n} more was already imported before, so it was not added again', '{n} more were already imported before, so they were not added again'), { n: result.already })}
              </p>
            ) : null}
            {/* Entries the Worker did not take: the balances now differ from the preview and from Splitwise. */}
            {result.limited > 0 ? (
              <p className={s.error} data-testid="import-limited">
                <Icon name="warning" size={16} />
                {result.byRows
                  ? t('有 {n} 筆沒有匯入：一個群組最多放 20,000 筆（包括已刪除的）', plural(result.limited, '{n} entry was not imported: a group keeps 20,000 at most, deleted ones included', '{n} entries were not imported: a group keeps 20,000 at most, deleted ones included'), { n: result.limited })
                  : t('有 {n} 筆沒有匯入：一個群組最多 5,000 筆', plural(result.limited, '{n} entry was not imported: a group holds 5,000 at most', '{n} entries were not imported: a group holds 5,000 at most'), { n: result.limited })}
              </p>
            ) : null}
            {result.refused > 0 ? (
              <p className={s.error} data-testid="import-refused">
                <Icon name="warning" size={16} />
                {t('有 {n} 筆沒有匯入，因為伺服器不接受', plural(result.refused, '{n} entry was not imported because the server did not accept it', '{n} entries were not imported because the server did not accept them'), { n: result.refused })}
              </p>
            ) : null}
            <Button variant="secondary" onClick={close}>
              {t('關閉', 'Close')}
            </Button>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
