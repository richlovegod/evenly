// 從 Splitwise 匯入: pick a Splitwise CSV export (a group or a friend), match each person in it to
// a member (or add them by name), give one rate per other currency (prefilled with today's rate,
// or mark the rows as really being in the group currency), check the preview, then import.
// What gets imported is exactly what the preview showed: if adding the new people moves any
// number, the sheet shows the new numbers and waits for another press.
// The parsing and mapping live in splitwiseImport.ts.

import { useMemo, useState, type ChangeEvent } from 'react';
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
import { radioKeys } from './NewGroupPage';
import {
  buildImport,
  fileCurrencies,
  importInBatches,
  parseSplitwiseCsv,
  samePreview,
  suggestMembers,
  type ImportOptions,
  type SplitwiseFile,
  type SplitwiseParseError,
  type SplitwiseSkipReason,
} from './splitwiseImport';
import s from './ImportSplitwise.module.css';

/** Mapping value for "add this person as a new member". */
const NEW = '';
const MAX_FILE_BYTES = 5_000_000;
const MAX_ACTIVE = 50;

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
  const [relabel, setRelabel] = useState<Record<string, boolean>>({});
  const [fxLoading, setFxLoading] = useState(false);
  const [done, setDone] = useState(0);
  const [result, setResult] = useState<{ imported: number; total: number } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openMap, setOpenMap] = useState<number | null>(null);

  const base = snap.group.currency;
  const meId = snap.me.memberId;
  const today = todayISO();
  const activeMembers = snap.members.filter(m => m.active);
  const leftMembers = snap.members.filter(m => !m.active);

  function reset() {
    setStep('pick');
    setFileName('');
    setFile(null);
    setReadError(null);
    setMapping([]);
    setRates({});
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
    let text: string;
    try {
      text = await f.text();
    } catch {
      setReadError(t('讀不到這個檔案，請再試一次', 'Could not read that file. Try again'));
      return;
    }
    const r = parseSplitwiseCsv(text);
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
    setFile(r.file);
    setFileName(f.name);
    setMapping(suggested.map(x => x ?? NEW));
    setRates({});
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
        const r = parseRate(rates[code]);
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
  }, [foreign, relabel, rates, base, gid, today, t]);

  const plan = useMemo(() => (file ? buildImport(file, { ...options, memberIds: mapping.map((m, i) => m || `new:${i}`) }) : null), [file, options, mapping]);

  const missingRates = foreign.filter(c => !relabel[c.code] && parseRate(rates[c.code]) === null).map(c => c.code);
  const newCount = mapping.filter(m => m === NEW).length;
  const tooMany = activeMembers.length + newCount > MAX_ACTIVE;
  const merged = new Set(mapping.filter(Boolean)).size < mapping.filter(Boolean).length;
  const ready = !!plan && plan.entries.length > 0 && missingRates.length === 0 && !tooMany && online;

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
        const name = Array.from(file.people[i].replace(/\s+/g, ' ').trim()).slice(0, 60).join('') || t('Splitwise 成員', 'Splitwise member');
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
      const imported = await importInBatches(
        final.entries,
        batch => actions.importExpenses(gid, batch),
        e => e instanceof ApiError && (e.status === 413 || e.code === 'payload_too_large'),
        n => setDone(n),
      );
      setResult({ imported, total: final.entries.length });
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

            <section className={s.section} aria-labelledby="sw-people">
              <h3 className={s.h} id="sw-people">{t('檔案裡的人', 'People in the file')}</h3>
              <p className={s.note}>{t('每一欄要對到群組裡的誰？對不到的會用名字新增成員。', 'Who is each column in this group? Anyone not matched is added by name.')}</p>
              <div className={s.panel}>
                {file.people.map((p, i) => {
                  const value = mapping[i] ?? NEW;
                  const isOpen = openMap === i;
                  const choices = [NEW, ...activeMembers.map(m => m.id), ...leftMembers.map(m => m.id)];
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
                                tabIndex={on ? 0 : -1}
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
                <p className={s.error} role="alert">
                  <Icon name="warning" size={16} />
                  {t('一個群組最多 50 人。請把一些欄對到現有的成員。', 'A group can have at most 50 people. Match some columns to existing members.')}
                </p>
              ) : null}
            </section>

            {foreign.length > 0 ? (
              <section className={s.section} aria-labelledby="sw-fx">
                <h3 className={s.h} id="sw-fx">{t('匯率', 'Exchange rates')}</h3>
                <p className={s.note}>
                  {t(
                    '這個群組用 {base}。其他幣別的費用要換算，已先填好今天的匯率，可以改。',
                    'This group uses {base}. Entries in other currencies are converted; today\'s rate is filled in and you can change it.',
                    { base },
                  )}
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
            {result.imported < result.total ? (
              <p className={s.note}>
                {t('另外 {n} 筆之前已經匯入過，沒有重複加入', plural(result.total - result.imported, '{n} more was already imported before, so it was not added again', '{n} more were already imported before, so they were not added again'), { n: result.total - result.imported })}
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
