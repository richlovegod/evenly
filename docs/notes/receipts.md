# Receipt scan: notes for SPEC.md and WORKER.md (agent D, 2026-10-17)

Only reading for now (plan section 3): the photo is sent once, read by Workers AI and dropped.
Nothing is stored, no R2. Neither the photo nor the receipt's text is logged.

## SPEC section 6, "Other"

| Method | Path | Auth | Body -> Response |
|---|---|---|---|
| POST | /api/receipts/scan | user | ReceiptScanReq -> ReceiptScanDTO. Body up to 3 MiB (`RECEIPT_MAX_BYTES`, past the 256 KB gate); `image` must be a `data:image/jpeg`, `png` or `webp` base64 data URL; `currency` is the hint, which the app sets to the form's currency when the scan starts (not the group's: a receipt without a currency is read in the hint's decimals and goes into that form). Limits: `RECEIPT_PER_DAY` per account (default 30) and `RECEIPT_GLOBAL_PER_DAY` for the app (default 300; staging 40), fixed UTC days. 429 `rate_limited` with `details.scope` `user`, `app` or `ai` (Workers AI daily allowance, error 3036) and `retryAfter` to 00:00 UTC; 502 `scan_failed` with `details.reason` `model`, `timeout` or `unreadable`. `?model=` (the owner only, in every environment) picks one of `@cf/google/gemma-4-26b-a4b-it`, `@cf/qwen/qwen3.8-27b`, `@cf/meta/llama-4-scout-17b-16e-instruct`; from anyone else it is 403 `forbidden`, and another name is 400 `validation`. |

Error order: 401 (no session), 413, 400 `bad_request` (not JSON), 400 `validation` (fields,
image prefix), 403 `forbidden` (`?model=` from anyone but the owner), 400 `validation`
(`?model=` not in the list), 502 when the AI binding is missing, then the two limits (every
attempt that got this far counts), then the model. None of the errors before the limits count
a scan.

Why `?model=` is the owner's only, on staging too: the free 10,000 Neurons a day belong to the
Cloudflare account, so staging and production draw on the same allowance, while our two limits
are counted per environment in its own D1, and they count scans, not Neurons. A scan costs about
19 to 29 Neurons with Gemma 4, 102 to 115 with Llama 4 Scout and 180 to 233 with Qwen 3.8
(staging, 2026-10-17), so about 45 Qwen scans by any staging account could stop every production
scan until 00:00 UTC (08:00 in Taiwan). Now only the owner can pick a dearer model, and
staging's `RECEIPT_GLOBAL_PER_DAY = "40"` (wrangler.toml) caps staging at about 1,200 Neurons of
Gemma a day. The owner's own picks still count as one scan each: 40 Qwen scans on staging are
about 7,200 to 9,300 Neurons, so compare models there in small runs.

## What the answer means (ReceiptScanDTO)

Money is in major units as plain numbers (13838 for ¥13,838, 110.49 for US$110.49), already
checked against the decimals of `src/shared/currencies.ts` (TWD and JPY have 0 here).

- `merchant`: NFKC, single spaces, at most 120 characters, or null.
- `date`: YYYY-MM-DD in the Western calendar, 2000-01-01 to tomorrow (UTC); 令和, 平成 and
  民國 years are converted even if the model did not. A date that cannot be right is null
  with a warning.
- `currency`: a known ISO code, or null when the model could not tell (the amounts are then in
  the hint's decimals, and a warning says to check the currency). Signs such as NT$, 円, ¥, US$
  are mapped; a bare $ is a guess. The model's `currencyGuessed` counts only when its answer is
  the hint: a JPY answer for a Japanese receipt with a TWD hint is JPY, even if flagged a guess.
- `total`: the printed final amount (tax, service and tip included). A fraction in a 0-decimal
  currency is refused. Missing or refused: the lines' sum (less the bill discount, plus tip, plus
  tax when it is 外税) with a warning, but only when no other amount was refused (an item or
  discount line, a tax or tip line, the tax, the tip, the discount). Then the total stays null,
  since that sum would leave the refused money out (with a TWD hint, a US receipt's
  `Latte 4.50, Bagel 3.25, Water 2` used to give a total of 2).
- `items`: at most 50 lines of at most 60 characters, all above 0. Taken out: subtotal, total,
  tax, tip, service, payment, cash, change and points lines (by name), a line equal to the total
  or to the lines above it when dropping it makes the lines fit, and lines with a fraction in a
  0-decimal currency (counted in a warning). Discount lines after the last item are a discount on
  the whole bill (out of the lines); higher up they come off the line above.
- `tax`, `tip`: as printed (tip includes 服務費 and サービス料), or null.
- `category`: a key of `src/shared/categories.ts`, never `payment`: the model's, else one found
  from the store name, else null.
- `warnings`: in the request's `locale` (default zh-TW): the lines do not fit the total, the
  total may leave out 外税 or count 内税 twice, no total was read (with the lines' sum used, or
  「沒讀到總額，請自己輸入金額」 when that sum would miss refused money), the total looked
  misread, how many lines looked misread (「有 {n} 個品項的金額看起來讀錯了，沒有放進來」), more
  than 50 lines, the date looked wrong, the currency could not be told.
- `usage`: `{model, promptTokens, completionTokens, neurons}`; neurons from the token counts at
  9,091 / 27,273 (Gemma 4), 40,909 / 290,909 (Qwen 3.8), 24,545 / 77,273 (Llama 4 Scout) per
  million input / output tokens; 0 for another model.

"Fits the total" means: total minus the lines equals the tax (when added on top), the tip, less
a bill discount, within one minor unit per line. The tax mode follows the model's `taxIncluded`
(外税 false, 内税 true).

## WORKER.md

### routes/receipts.ts (owner: D) exports `receiptRoutes`, `RECEIPT_MAX_BYTES`

`POST /receipts/scan` with `requireUser` on the route. Reads the body with its own size check
(Content-Length and text length at most 3 MiB), `JSON.parse` once, zod for types and lengths;
the image prefix is checked with `startsWith`, never a regex over the base64. `?model=` is the
owner's only (`isOwner`, every environment; 403 `forbidden` for anyone else, never a silent swap
to the default, so a comparison run cannot compare one model with itself). Limit keys:
`receipt:user:<uid>:<YYYY-MM-DD>` and `receipt:app:<YYYY-MM-DD>`, 86,400 s windows.

### services/receipt.ts (owner: D)

- `DEFAULT_RECEIPT_MODEL`, `RECEIPT_MODELS`, `RECEIPT_MAX_TOKENS` (1500), `RECEIPT_TIMEOUT_MS`
  (40 s; the app waits 45 s), `RECEIPT_SCHEMA`, `RECEIPT_SYSTEM_PROMPT`.
- `receiptRequest(model, image, {today, hint})`: Gemma 4 and Qwen 3.8 get
  `response_format: {type: 'json_schema', json_schema: {name: 'receipt', schema, strict: true}}`
  and `chat_template_kwargs: {enable_thinking: false}` (Qwen also `reasoning_effort: 'low'`);
  Llama 4 Scout gets `json_schema` set to the schema itself. Messages: the system prompt, then a
  user message with the image (data URL) and the text `Today is <date>. Currency hint: <code>.`
  `temperature: 0`.
- `runReceiptModel(ai, model, image, ctx)`: one call, aborted after 40 s. 3036 (or "daily free
  allocation") is 429 scope `ai`; every other failure, a timeout or an answer without a JSON
  object is 502 `scan_failed`. "JSON Mode couldn't be met" is a `scan_failed` (no retry). The log
  line (index.ts onError) names only the Workers AI code or the error name.
- `readAnswer(raw)`: `choices[0].message.content` (string or text parts), `response` (string or
  object), the REST `result` wrapper; JSON as is, inside code fences, or the outermost `{...}`.
- `normalizeReceipt(raw, {hint, locale, today})`: the rules above, pure.
- Also exported for tests: `minorUnits`, `receiptDate`, `receiptCurrency`, `receiptCategory`,
  `lineKind`, `parseJsonText`, `aiFailure`, `neuronsFor`, `secondsToNextUtcDay`.

The schema uses "" and 0 for unknown values (no nullable types), so every JSON-schema engine
takes it. The fields follow the receipt top to bottom (lines, tax, tip, discount, then total),
so the model reads the total after the lines it covers.

## SPEC section 8.3, the add sheet

- 掃描 / Scan (camera icon) in the header's empty right cell, only when adding an expense. Icon
  only under 360 px. No new row: the zh-TW 390 x 664 sheet still fits (checked in WebKit).
- Tap: a hidden `<input type="file" accept="image/*">` without `capture` (iPhone offers the
  camera and the photo library). Offline the pill is aria-disabled and a tap says
  「離線中不能掃描收據，連線後再試」. While reading: a spinner and 讀取中; tapping again stops it,
  and leaving the editor stops it.
- The photo is shrunk in the browser (`createImageBitmap` with the EXIF orientation, canvas,
  JPEG 0.85, long side 1600 px; about 90 KB for the test receipts), which also drops EXIF and
  GPS. It is never put in the draft, the stash, IndexedDB or a log.
- The hint sent with the photo is the form's currency when the scan starts. A receipt the Worker
  could not tell the currency of is put into that currency; if the person picked another one
  while it was reading, its amounts are left out (「你剛改了幣別，金額沒有填入」).
- The answer is applied in one step (one exchange-rate fetch): an open sheet is closed first;
  fields the person changed while it was reading are kept; the currency first (a rate typed
  earlier for it comes back, as with the currency picker), then the total, the date if it is
  within the last 90 days (plus tomorrow), the store name into an untouched description with the
  category (a category picked by hand stays), and the lines into `split.items` without changing
  the split method. When the split already is 品項, the split sheet opens so people say who had
  each line. Before replacing 品項 lines someone typed, a dialog asks (換掉 / 保留我的).
- A second scan of the same form (the right photo after a wrong one) replaces the 品項 lines, the
  store name and the category the earlier scan filled, while they still show what it put there:
  nobody typed them. A receipt with no store name leaves the earlier name and category (it may be
  the same receipt again). What the person typed or picked over them stays.
- The toast says what was filled in, where the lines are (「7 個品項放在「分法」的「品項」裡」),
  what to check (the editor's notes and the Worker's warnings) and, the first time on a device,
  「照片只用來辨識，不會存起來」. Its 復原 puts back only the fields that still show the scan. The
  currency and the amounts go back together: when an amount, a 品項 line, a payer's or a
  person's amount or a rate was typed after the scan, it was typed in the scan's currency, so the
  currency stays and so do the scan's amounts, and a second toast says why
  (「掃描後輸入的數字是用 JPY 算的，所以幣別沒有改回來」).
- Errors in `editorText.scanErrorText`: per 429 scope, `scan_failed` reasons, offline, timeout,
  a photo that cannot be opened, too large, not a photo.

## For tuning on staging

- `node tmp/receipts/eval.cjs` (models comma separated, hint currency) scores every synthetic
  receipt; `RECEIPT_MODEL` changes the default without a code change. It passes `?model=`, which
  is now the owner's only: it has to sign in as the staging owner (an `OWNER_EMAILS` account),
  or every row is 403. One run of 6 receipts with all three models costs about 1,300 to 2,100
  Neurons, 13 to 21% of the allowance production also needs, and 18 of staging's 40 scans a day.
- Prompt: `RECEIPT_SYSTEM_PROMPT` in services/receipt.ts. The image comes before the text in the
  user message (Google's advice for Gemma), not after it as the plan sketched.
- Seen on staging on 2026-10-17 (`tmp/receipts/eval-result.json`): Gemma 4 and Llama 4 Scout
  answered all 6 receipts with `response_format` and the image as a content part (Gemma in 3 to
  7 s, Llama in 7 to 16 s); Qwen 3.8 answered 2 and ran into the 40 s timeout on the other 4
  (those still count against our limits). Not yet known: the Worker's CPU time on a 1 MB body
  (JSON.parse plus the binding's serialization).
