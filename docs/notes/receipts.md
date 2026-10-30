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

## Production reads with Qwen 3.8 (Gino, 2026-10-29)

Production's `RECEIPT_MODEL` is `@cf/qwen/qwen3.8-27b`, set as a Worker secret
(`wrangler secret put RECEIPT_MODEL --name evenly-api`, version a854248f, 2026-10-29 22:54 UTC),
so it outlives every deploy without a code change. The code's default and staging stay Gemma 4,
which keeps staging's 40 scans a day at about 1,200 Neurons of the shared allowance. Never add
`RECEIPT_MODEL` to production `[vars]` while the secret exists (Cloudflare refuses two bindings
with one name). Back to Gemma: `wrangler secret delete RECEIPT_MODEL --name evenly-api`.

Why: the first real scans were order-page screenshots, which the 6 synthetic receipts never
covered. On one (a line showing a sale unit price, a struck list price, "Paid" and a struck line
price) Gemma read the line price wrong 10 times in 10 (a number not on the photo), so the editor
warned that the lines did not fit the total; it also filled in today's date when none was
printed, and flagged the printed US$ as a guess 4 times in 10. A prompt line fixed the
line price but small prompt changes broke other receipts, so the reader changed instead. Qwen
read all 8 receipts (the 6 synthetic and 2 real screenshots) right in 2 of 2 runs on every field,
then both screenshots again live on production (140 and 132 Neurons, 3 to 5 s). Replays:
`tmp/scan-1029/compare.ts` (local only, not in git: the screenshots show an order number).

Cost: 130 to 233 Neurons a scan, about 180 on average, so the free 10,000 a day would cover about
55 scans, and past them Workers Paid bills US$0.011 per 1,000 Neurons (about US$0.002 a scan).
Production stops at `RECEIPT_NEURONS_PER_DAY` instead (8,000 of the 10,000): each scan sets its
worst case aside first (764 Neurons with Qwen 3.8), which leaves about 40 scans a day, and then
answers 429 `rate_limited` {scope: 'ai'} until 00:00 UTC, so the scans never take the account past
its free allowance. Speed: mostly 3 to 12 s, 37 s at worst in 18 runs, inside the 55 s
`RECEIPT_TIMEOUT_MS`.

## Several photos in one scan (2026-10-30)

Gino (2026-10-29 23:52 PT): 「可以把上傳收據 改成可以上傳三張嗎，有時候一張不夠」, and (00:03 PT) one tap
of 掃描收據 reads all of them together, because a long receipt can have its items on two photos and
its total on a third. An expense keeps up to three photos (SPEC section 6, Receipt photos), and a
scan sends `image` for one photo (the request from before, byte for byte) or `images` for two or
three.

What Cloudflare publishes (checked 2026-10-30): the input schemas of Qwen 3.8 and Gemma 4
(`developers.cloudflare.com/workers-ai/models/<model>/sync-input.json`) take a user message whose
`content` is an array of parts (`text`, `image_url`, ...), `minItems` 1 and no `maxItems`, so
three `image_url` parts are valid input; the model pages say Vision: Yes (contexts 262,144 and
256,000 tokens) but show no image example and no limit on images per request; the changelog
(2026-02-17) says chat `content` takes arrays of parts. Llama 4 Scout's page shows only the
prompt form, though the Worker has always sent it an image part. Nothing had sent two images, and
a model could refuse a second one (an error) or quietly keep only the first (only the prompt
tokens show it). So the server has both paths:
- **One call with every photo** where the check below passed: the `RECEIPT_JOINT` secret is `on`
  and the model is in `RECEIPT_JOINT_MODELS` (Gemma 4, Qwen 3.8), or the owner sends `?joint=1`.
  The photos paragraph (`RECEIPT_PHOTOS_PROMPT`), `sameReceipt`, 2,250 or 3,000 output tokens,
  85 s. A Qwen answer with fewer prompt tokens than 1,200 plus 1 per 1,400 px a photo gets
  `notAllRead` (and a log line).
- **One call per photo** otherwise (`?joint=0` forces it): the one-photo request with a sentence
  saying which part it is, all at once, joined by `mergeReadings`.

Either way one reservation of the whole worst case first (`receiptWorstCase(model, n)`, one call
per photo n times the one-photo case), then one correction. The worst cases hold because the
route refuses a photo over 2,000 px on its longest side (`imageSize` reads the header): a
2,000 x 2,000 photo is at most about 5,200 tokens with Qwen.

| Scan (Qwen 3.8, production) | Set aside | Really uses | Fit in 8,000 |
|---|---|---|---|
| 1 photo | 764 | 130 to 233, about 180 (measured) | about 41 |
| 2 photos, one call | 1,195 | about 250 to 450 (estimate) | about 20 |
| 3 photos, one call | 1,626 | about 350 to 650, about 500 (estimate) | about 13 |
| 3 photos, one call per photo | 2,292 | about 550 to 750 (estimate) | about 10 |

With Gemma 4 (staging, the code's default): 114 / 182 / 250 set aside for 1 / 2 / 3 photos in one
call and 342 for three separate calls, using about 20 / 30 / 45 (measured below: 32 and 65).

### The release check on staging (Gemma 4, 2026-10-30 10:05 UTC)

Photos: `tmp/receipts/make-receipts.cjs jp-supermarket-long-parts us-bill-slip-set` (local, not
in git) cuts the long AEON receipt into top, middle and bottom photos (1200 x 1600, two lines
shared at each cut, the total only on the bottom one), and draws a restaurant bill with its signed
card slip (the tip and the total written by hand on the slip). `node tmp/receipts/release-check.mjs
<base> <owner email> <password>` sends each set with `?joint=0` and then `?joint=1`, one after the
other, as the environment's owner, through its own Worker only (which refuses anything past the
day's budget), and judges every rule of the contract: 200; every line once, in printed order; the
bottom photo's total; the store and date from the top; no "does not fit" note; one receipt; the
prompt tokens; `usage.calls`; under 85 s. Staging had used 36 of its 500 neurons that day.

| Photos | Path | Answer | Time | Prompt / completion tokens | Neurons (counted) | Result |
|---|---|---|---|---|---|---|
| AEON in 3 | one call per photo | 200 | 6.2 s | 4,942 / 733 | 64.919 (67) | **Fail**: 6 lines, the bottom photo's only (below) |
| AEON in 3 | one call | 200 | 8.1 s | 2,432 / 347 | 31.573 (32) | **Pass**: all 15 lines in order, each shared line once, ¥4,809, tax ¥379, AEON 札幌桑園店, 2026-10-14, no notes |
| Bill and slip | one call per photo | 200 | 3.6 s | 3,292 / 248 | 36.691 (38) | **Pass**: US$110.49 (the slip's handwritten total), tip 20, tax 8.49; totalsDiffer said so |
| Bill and slip | one call | 200 | 4.8 s | 2,163 / 242 | 26.264 (27) | **Pass**: US$110.49, tip 20, tax 8.49; a guessed currency (no $ printed) |

- The prompt tokens prove one call read every photo: about 1,350 for the prompt, 270 for the photos
  paragraph and 270 a Gemma photo (2,430 expected for three, 2,160 for two); the first photo alone
  would have been about 1,890. The four scans used 164 neurons; one call costs about half of one
  call per photo (31.6 against 64.9 for three photos), and takes a little longer (8.1 s against
  6.2 s, the separate calls running at once).
- The one fail: Gemma wrote today's date (2026-10-30) on the two parts that print no date, so the
  merge took three parts for three receipts and kept only the bottom photo's lines (with
  linesMissing and notSameReceipt). `mergeReadings` now compares dates only between photos that
  name the store, and takes the date from the store's photo first (6120e4f; a test replays it).
  Checked again on staging with that code (10:22 UTC), with the two photos the failure was about,
  the top (store and date) and the bottom (the total, no store, and again today's date from the
  model), one call per photo: 200 in 5.4 s, 3,294 / 448 tokens, 42.164 neurons (228 set aside, in
  what was left of the day's 500): one receipt now, AEON 札幌桑園店 and 2026-10-14 from the top,
  ¥4,809 and tax ¥379 from the bottom, its 12 lines in order, and "The items come to ¥504 less
  than the total. Some lines may be missing between the photos" (linesMissing, locale en): exactly
  the three lines of the middle photo that was left out. The three photos together with one call
  per photo need 342, which did not fit that day.
- So `RECEIPT_JOINT` is `on` on staging since 10:06 UTC (version ad0a1118), and
  `RECEIPT_JOINT_MODELS` keeps Gemma 4 and Qwen 3.8.

Which environment reads how: staging, two or three photos in one call (Gemma 4); production, one
call per photo until its own check (Qwen 3.8, after the deploy, early in a UTC day: `?joint=0`
sets 2,292 aside, `?joint=1` 1,626, about 1,200 of production's 8,000 in all; `on` only if the one
call passes). One photo is one call everywhere, as before.

### After the review (2026-10-30, review of the three-photo change)

- The merge of one call per photo, three more of its rules (pure functions, tested; no scan was
  run again for them): a date of today does not count once another photo prints a different one
  and some photo has no total of its own, wherever the store's name is (the bottom photo can print
  the date, a part above it get today's from the model). The fix check (2026-10-30) narrowed it
  twice: tomorrow is a real date (in Taiwan's or Japan's early hours a receipt prints the local
  day, which is UTC tomorrow, while the model is told the UTC day), and so is today when every
  photo has its own total (whole receipts: two from one store, one from today, stay two); store names are compared by their letters and digits (NFKC, any
  case), one inside the other counting as one store, and a photo naming another store with no
  lines and the largest total is the bill's card slip (THE PINK DOOR on the slip, or the name in
  another script); the currency follows `normalizeReceipt`'s rule for one answer, so a ¥ reading
  the model calls a guess beats another photo's guess of the hint.
- The overlap safety net tries repeated blocks by their length and sum (one line 200 times over
  three photos built about 1.1 million pairs before, about 234 ms and 90 MB; now a few ms).
- The calls and the neuron correction run inside `waitUntil`, so a scan stopped in an app keeps only
  what it really used counted.
- The Qwen guard's floor is a sum, so it tells only for photos of similar size: a reading of only
  the first photo can pass it when that one is much larger than the others (a 1200 x 1600 camera
  shot with two 738 x 1600 screenshots: floor 3,414, the first photo alone about 3,495). No token
  count can say which photos were read. The release check's photos are all 1200 x 1600; the lines
  it checks, not the guard, are what show a photo left out.

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
