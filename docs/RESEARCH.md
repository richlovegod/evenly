# Research notes

## Exchange rates (verified 2026-10-16 by direct requests)

Primary provider: **Frankfurter v2**, `https://api.frankfurter.dev/v2/rates?base=USD` (latest) and
`https://api.frankfurter.dev/v2/rates?base=USD&date=YYYY-MM-DD` (historical). No key. The
response is a JSON array of `{ "date": "2026-10-16", "base": "USD", "quote": "TWD", "rate": 32.275 }`
(165 currencies, including TWD, JPY, CNY, KRW, VND, IDR, ISK, DKK, CRC, PEN, MXN, EUR, HUF, KHR).
Some quotes carry the previous day's date (markets publish at different times): use each
quote's own rate and report the newest date as the table date. The response is served from
Cloudflare's cache (`cache-control: public, max-age=60659`). 2024-03-15 returned 165 quotes with
TWD 31.583 and JPY 148.45 per USD.

Fallback provider: **fawazahmed0 currency-api** (free, no key, daily):
`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@<YYYY-MM-DD or latest>/v1/currencies/usd.json`
and the mirror `https://<YYYY-MM-DD or latest>.currency-api.pages.dev/v1/currencies/usd.json`.
Response `{ "date": "2024-03-15", "usd": { "twd": 31.6, "jpy": 148.4, ... } }` with lowercase codes
(also crypto tokens: keep only 3-letter alphabetic codes and uppercase them).

Send a `User-Agent` header (Cloudflare answers some default agents with error 1010) and use a
5 second timeout per request.

Rates are stored per day in D1 `fx_cache` as units per 1 USD; a rate into any base is
`usd[base] / usd[currency]`.

## Splitwise and competitors

The full research report from the research workflow is appended below when it finishes.


## Research report (workflow wf_60ca4aa5-d71, 2026-10-16)

# Splitwise-style split app: research brief for tonight's build (2026-10-16)

**Conventions**
- [free] and [Pro] are Splitwise tiers. "(derived)" marks our own inference, which no source states. "(unverified)" means it could not be confirmed in this run.
- No date is shown on kb.splitwise.com, dev.splitwise.com, splitwise.com product pages, frankfurter.dev, or GitHub docs and source files, unless a date is given below. Forum dates are the dates of the quoted posts.
- Re-fetched during synthesis on 2026-10-16: Frankfurter v2 USD rates, frankfurter.dev, the Splitwise API terms on dev.splitwise.com, and legacy Splitwise article 746853.
- "Brief" marks facts about Gino's own Splitwise data that came with the task. They have no URL.
- Nobody inspected the logged-in Splitwise web app, because browser tools were off-limits. Its UI is described from help pages, blog posts and API docs only.

**Read first**
1. The case for the app is no cap and no friction. Splitwise free allows "up to 4 expenses each day" and adds ads and waits (see 1.1 and 4).
2. The ledger is expenses, per-member paid and owed shares, stored split inputs, and the exchange rate on each expense. Balances are always computed, never stored (see 2 and 3).
3. For exchange rates, Frankfurter v2 has TWD (re-checked today). Frankfurter v1 and api.frankfurter.app do not (see 5.1).
4. Identity should be the group link plus a "Who are you?" picker on each device, with no passwords. Safari wipes script storage after 7 Safari-days, and Workers Free allows 10 ms of CPU per request (see 5.3 and 5.4).
5. GitHub Pages needs a public repo and hash routes. A Worker that serves the app itself is the only setup that gets an uncapped login cookie (see 5.3 and 5.6).
6. Import from Gino's CSV exports, not the Splitwise API. Its terms bar using Splitwise Materials "to create an application that replicates existing Splitwise functionality" (see 1.8).

## 1. Splitwise feature inventory

### 1.1 Limits and plans
- [free] Daily cap: "free users can add up to 4 expenses each day". Pro removes it. Official workaround: a friend adds the expense and picks you as payer. https://kb.splitwise.com/pro/what-is-splitwise-pro , https://feedback.splitwise.com/knowledgebase/articles/2010350-why-am-i-seeing-an-expense-limit
  - Conflict: third parties report 2 to 5 per day. Android Central via Yahoo (2026-04-28) says "five", a Trustpilot review (2026-08-27) says 2, and Tetras (Aug 2026, Japanese account) saw 2. Sources: https://tech.yahoo.com/apps/articles/app-splitwise-best-hack-split-191737811.html , https://www.trustpilot.com/review/splitwise.com , https://tetras-ltd.com/en/blog/splitwise-daily-limit-workaround
  - The KB is the only official number, so treat it as authoritative but expect it to vary by market.
- [free] A wait of about 10 seconds (countdown or Pro interstitial) before adding an expense. Only third parties report it: IT Voice (2023-12-30), Trustpilot (2026-02-26), and Tetras, which saw "continuing in 9 seconds". No official page mentions it. https://itvoice.in/splitwise-has-introduced-restrictions-on-the-number-of-free-expenses-users-can-add
- [Pro] "A totally ad-free experience", which implies the free tier has ads. The ad format is undocumented. https://www.splitwise.com/pro
- [Pro] The ten Pro items:
  - unlimited expenses
  - card transaction import (US only)
  - currency conversion
  - charts
  - receipt scanning
  - itemization
  - search
  - default splits
  - early access
  - ad-free

  Source: https://www.splitwise.com/subscriptions/new . The App Store adds 10GB high-resolution receipt storage, OCR, JSON backups and Open Exchange Rates conversion. https://apps.apple.com/us/app/splitwise/id458023433
- [Pro] Plans: Individual + Trip Pass (annual), Duo + Trip Pass (annual, two people) and Monthly. A Trip Pass "grants Pro features to group members for 30 days" in one trip group. https://kb.splitwise.com/pro/what-is-splitwise-pro
- [Pro] Prices are not shown on splitwise.com. US App Store in-app items run from $2.99 to $39.99. Android Central (2026-04-28) says $4.99 a month or $39.99 a year. https://apps.apple.com/us/app/splitwise/id458023433 , https://tech.yahoo.com/apps/articles/app-splitwise-best-hack-split-191737811.html

### 1.2 Expense entry
- [free] Expense fields (https://dev.splitwise.com/):
  - cost: a decimal string "limited to 2 decimal places"
  - description
  - details ("Also known as notes")
  - date, which may differ from created_at
  - currency_code
  - category, which must be a subcategory
  - group_id, where 0 means no group
  - split_equally, or per-user paid_share and owed_share
  - receipt
  - repeat_interval
- [free] Fixed categories: 7 parents and 43 subcategories with numeric IDs. Examples: Groceries 12, Rent 3, and Hotel 47, which sits under Transportation. There are no custom categories: the request has 669 votes and an official reply on 2017-05-23 said they are not planned. https://secure.splitwise.com/api/v3.0/get_categories , https://feedback.splitwise.com/forums/162446-general/suggestions/2900634-allow-custom-categories
- [free] A basic + - * / calculator in the amount field, on the web only (official reply 2015-09-03, 955 votes). The mobile status is unknown. https://feedback.splitwise.com/forums/162446-general/suggestions/4963941-ability-to-use-a-calculator-when-entering-bill
- [free] Multiple payers on one expense. https://apps.apple.com/us/app/splitwise/id458023433
- [free] Offline entry and cloud sync. Unsynced items show a loading or error icon in place of the category icon. https://www.splitwise.com/ , https://kb.splitwise.com/balances-and-expenses/can-you-explain-the-totals-screen
- [free] Future-dated expenses count toward balances immediately, by design (staff replies 2013-04-20 and 2017-05-23). https://feedback.splitwise.com/forums/162446-general/suggestions/3065146-post-a-bill-only-once-the-posted-date-for-the-bill
- [free] Recurring expenses: weekly, fortnightly, monthly or yearly. https://kb.splitwise.com/balances-and-expenses/how-can-i-manage-recurring-expenses
- [free] Comments on expenses. The edit history appears as "System" comments. https://apps.apple.com/us/app/splitwise/id458023433 , https://dev.splitwise.com/
- [free] (unverified) Receipt attachment. A legacy, undated help page describes image or PDF attachments up to 2MB that must upload within 30 seconds, with no Pro gate. No current page says free users can attach. [Pro] 10GB of high-resolution storage and OCR. https://feedback.splitwise.com/knowledgebase/articles/436745-i-can-t-upload-an-attachment , https://apps.apple.com/us/app/splitwise/id458023433

### 1.3 Split methods
- [free] Equally (the default; tap a name to drop that person), exact amounts, percentage, shares and adjustment. The control is the sentence "Paid by [you] and split [equally]". https://kb.splitwise.com/balances-and-expenses/what-are-different-ways-i-can-split-an-expense
- [free] Reimbursement (refund) split, web only: "this feature isn't supported on the mobile apps yet". https://kb.splitwise.com/balances-and-expenses/how-do-i-add-a-refund-or-reimbursement
- [Pro] Itemization and receipt scanning: "On the mobile app, Pro subscribers can itemize by scanning a receipt". No page states the tier for manual itemizing on the web. https://www.splitwise.com/pro , https://kb.splitwise.com/balances-and-expenses/what-are-different-ways-i-can-split-an-expense
  - Conflict: a press release dated 2026-10-14 makes the new "Itemize" free in the US and UK. One person photographs the receipt, others join by QR "without downloading the app or signing up", everyone claims their items, and totals include "proportional tax and tip". For the US and UK the dated release outranks the undated /pro page; elsewhere, assume it is still Pro. https://www.splitwise.com/press/splitwise-launches-new-feature-that-takes-the-awkwardness-out-of-splitting-the-check
- [Pro] Default split per group ("set it and forget it", e.g. 55%/45%). https://www.splitwise.com/subscriptions/new
- [free] Couples inside a group: give the payer's side 2 shares and the partner 0. Shares cannot be combined with itemization. https://kb.splitwise.com/groups/how-do-i-split-an-expense-for-a-couple-that-is-sharing-costs
- [free] Splitting by nights exists only in the separate travel calculator, which has a days-present grid and no published formula. It is not an expense split method. https://www.splitwise.com/calculators/travel

### 1.4 Groups
- [free] Group types are home, trip, couple and other; apartment and house also exist, but the docs recommend home. Groups have a cover photo, an avatar, invite_link and simplify_by_default. https://dev.splitwise.com/
- [free] You join only by invite (email or phone) or "Invite via link". "You cannot join a group on your own". https://kb.splitwise.com/groups/how-do-i-join-an-existing-group
- [free] Simplify Debts toggle, which any member can change. https://kb.splitwise.com/balances-and-expenses/what-is-simplify-debts
- [free] Whiteboard (shared notes per group), on all platforms since 2019-07-26. https://feedback.splitwise.com/forums/162446-general/suggestions/6371151-whiteboard-on-mobile-app
- [free] No admins or permissions. Anyone in the group, or anyone on an expense, can view, edit or delete it. https://kb.splitwise.com/groups/can-i-prevent-group-members-from-changing-expenses-or-set-permissions
- [free] A member can be removed only at zero balance. https://kb.splitwise.com/groups/how-do-i-remove-a-person-from-a-group
- [free] Deleting a group deletes it for everyone. Undelete restores all its expenses and payments. https://kb.splitwise.com/groups/how-do-i-delete-or-undelete-a-group
- [free] No archive: 168 votes, and an official reply on 2015-03-16 said "not on the roadmap yet". Friends you are fully settled with hide after 30 days without activity. https://feedback.splitwise.com/forums/162446-general/suggestions/7172089-allow-manual-archiving-of-group , https://kb.splitwise.com/balances-and-expenses/can-you-help-me-understand-my-dashboard-balances-on-the-web-app
- [free] Balance reminders go to one friend at a time. "Remind the whole group" has been Planned since 2012-09-12 (160 votes). https://feedback.splitwise.com/forums/162446-general/suggestions/3108868-send-reminder-to-all-people-in-a-group

### 1.5 Friends and account
- [free] Placeholder friend ("someone tracked by name, without contact info"), from the web app only. You can add an email or phone later to give them access. Invitees can be on expenses right away and "indefinitely", and Splitwise sends "one invite, one reminder". https://kb.splitwise.com/getting-started/can-i-add-a-friend-without-adding-their-email-address-or-phone-number
- [free] A friend's contact info is editable until they claim the account. After that, only the owner can change name, email or phone. https://kb.splitwise.com/groups/how-do-i-edit-my-friends-email-or-phone-number
- [free] Non-group expenses sit in a special group that "cannot be deleted or renamed". https://kb.splitwise.com/groups/why-do-i-have-a-non-group-expenses-group
- [free] Duplicate accounts can be merged. It needs both passwords, the two accounts can share no expenses, and it cannot be undone. https://kb.splitwise.com/account-issues/what-can-i-do-if-i-have-two-splitwise-accounts
- [free] Delete a friend (only if you share no group; this removes non-group records), block, or report. https://blog.splitwise.com/2013/11/04/improvements-to-delete-friend-functionality/ (2013-11-04), https://kb.splitwise.com/account-issues/what-do-i-do-if-someone-is-abusing-or-harassing-me-on-splitwise
- [free] Login on the web is email and password, or Google. The iPhone app has no direct Google login. https://www.splitwise.com/login , https://kb.splitwise.com/account-issues/how-do-i-log-in-with-my-google-account-on-the-splitwise-ios-app
- [free] App Store UI languages: English, Dutch, French, German, Indonesian, Italian, Japanese, Polish, Portuguese, Spanish, Swedish and Thai. There is no Chinese. The homepage says only "7+ languages", so the App Store list is the more specific source. https://apps.apple.com/us/app/splitwise/id458023433
- [free] Dark mode on mobile (2026-05-18) and "Log out on all devices". https://blog.splitwise.com/2026/05/18/dark-mode-announcement/ , https://kb.splitwise.com/account-issues/how-do-i-log-out-on-all-devices

### 1.6 Balances and settle up
- [free] The dashboard shows totals owed and owing. For each friend it shows only the largest single-currency balance, with an asterisk when other currencies exist. A friend's page breaks the balance down by group. https://kb.splitwise.com/balances-and-expenses/can-you-help-me-understand-my-dashboard-balances-on-the-web-app
- [free] "Settle up" records a payment made outside the app. Deleting the record undoes it. https://kb.splitwise.com/balances-and-expenses/i-accidentally-settled-up-how-can-i-undo-this
- [free] PayPal and Venmo hand-off on the mobile app: US only, USD balances only, and the recipient is pre-filled with their Splitwise email. "As of 7/2/26" the Venmo integration doesn't work on Android. Splitwise "does not handle the funds". https://kb.splitwise.com/payment-integrations/how-do-i-send-money-via-paypal-or-venmo
- [free] Splitwise Pay (US) and Pay by Bank (select European countries). The "Request" button exists only with these two. https://www.splitwise.com/pay , https://kb.splitwise.com/payment-integrations/can-i-request-a-payment-via-venmo-or-paypal
- [free] Splitwise Card: a US debit card that auto-splits purchases to a default group or friend (e.g. 60/40). Card purchases can be added without Pro. https://www.splitwise.com/card
- [free] Totals screen by month or all time, plus a printable summary on desktop. https://kb.splitwise.com/balances-and-expenses/can-you-explain-the-totals-screen , https://kb.splitwise.com/balances-and-expenses/how-can-i-double-check-my-balances
- [Pro] Charts by category and over time. https://kb.splitwise.com/pro/what-is-splitwise-pro

### 1.7 Currency
- [free] get_currencies returns 153 codes (the homepage says "100+"). Symbols collide: "$" is used for USD, CAD, MXN, HKD, AUD and SGD; "¥" for both JPY and CNY. TWD is "NT$". https://secure.splitwise.com/api/v3.0/get_currencies
- [free] Balances are kept separate per currency. Changing an expense's currency "only changes the currency label". New expenses default to "the last currency used in that group or friendship". Simplify runs separately within each currency. https://kb.splitwise.com/balances-and-expenses/how-can-i-manage-a-friendship-or-group-with-multiple-currencies
- [Pro] Conversion rewrites every expense in the group or friendship, settled ones included, into your default currency. It uses the Open Exchange Rates mid-market rate "at the exact moment you choose to convert". Later expenses are not converted automatically, and reverting "isn't always possible". https://kb.splitwise.com/pro/how-are-exchange-rates-calculated-for-currency-conversion

### 1.8 Search, export, import, activity
- [Pro] Search. https://www.splitwise.com/subscriptions/new
- [free] "Export as spreadsheet" per group or friend. It has one row per transaction, a "Cost" column, and per-person columns showing each transaction's effect on that person's balance. The App Store calls it "Export to CSV". https://kb.splitwise.com/account-issues/how-do-i-export-my-splitwise-data
- [Pro] JSON backup. A full export requires emailing support. Same page as above.
- [Pro] Card transaction import, US only. https://www.splitwise.com/subscriptions/new
- [free] No CSV import was found. The API is "not intended for commercial use". Re-fetched today, the terms also say "you may not use Splitwise Materials to create an application that replicates existing Splitwise functionality" or that "competes with Splitwise". https://dev.splitwise.com/
  - Conflict: one researcher suggested importing with a personal API key. The terms are the authoritative source, so import from Gino's own CSV exports instead.
- [free] Recent Activity "cannot be cleared". Mobile loads only the latest 100 items. Deleted expenses are restored from it. https://kb.splitwise.com/account-issues/where-can-i-view-a-history-of-recent-changes-to-my-account
- [free] Email notifications are delayed 60 seconds and never sent for your own changes. Push notifications also exist. https://kb.splitwise.com/account-issues/why-am-i-not-receiving-email-notifications , https://apps.apple.com/us/app/splitwise/id458023433

### 1.9 Layout
- [free] Mobile layout from the Android 5.0 redesign (2021-04-05) and the iOS redesign (2019-07-09):
  - Groups is the first tab, and an Account tab replaces the hamburger menu.
  - A balance card shows suggested repayments.
  - A horizontally scrolling action row holds Settle up, Balances, Totals and Export.
  - Each expense row shows its date.
  - Expense details have a quick categorizer and a sticky comments bar.
  - A filter shows only outstanding balances.

  Sources: https://blog.splitwise.com/2021/04/05/splitwise-for-android-v5-0/ , https://blog.splitwise.com/2019/07/09/splitwise-redesigned/

## 2. Exact mechanics to replicate

### 2.1 Simplify Debts
- **Documented guarantees** (KB):
  - It restructures debts "to minimize the total number of payments".
  - "It never changes anyone's total balance."
  - It re-simplifies "whenever a new expense or payment is added".
  - It works within each currency separately.
  - Any member can toggle it. Turning it off after payments "unravels the simplified payment paths".

  Source: https://kb.splitwise.com/balances-and-expenses/what-is-simplify-debts
- **Rules inside groups.** The 2012 post states three rules, and a staff comment (2013-05-02) says group simplification keeps two of them:
  - Kept: "Everyone owes the same net amount".
  - Kept: "No one owes more money in total than they did before".
  - Not necessarily kept: "No one owes a person that they didn't owe before".

  So two people who never shared an expense can be told to pay each other; the KB's own example has Anna paying Charlie. Outside groups, the manual version "only moves around debt between people who already have outstanding balances" (support reply 2014-08-21). https://blog.splitwise.com/2012/09/14/debts-made-simple/ , https://feedback.splitwise.com/forums/162446-general/suggestions/6304775-relationships-for-debt-calculation
- **Observed algorithm** (not documented): greedy, usually minimal but not always. In a 42-member test group whose optimum was 40 payments, Splitwise suggested 41 (Anton Cao, 2022-10-23). https://antoncao.me/blog/splitwise , https://feedback.splitwise.com/forums/162446-general/suggestions/3410695-make-the-number-of-transaction-while-settling-mini
  - Conflict: staff (2012-12-11) described it as finding "the minimum necessary transactions". The dated test is stronger evidence.
  - The tie-break order is unknown. A user's 2019 output (forum 6304775) does not follow largest-debtor-first.
- **The math:**
  - Finding the minimum number of transfers is NP-hard (Verhoeff 2004).
  - Greedy creditor-debtor matching needs at most n-1 transfers and also minimizes the total money moved.
  - The exact optimum comes from splitting people into as many disjoint groups as possible whose balances each sum to zero; each group then settles in (size - 1) transfers.

  Sources: https://terbium.io/2020/09/debt-simplification/ (2020-09-25), https://infedu.vu.lt/journal/INFEDU/article/612/info , https://www.geeksforgeeks.org/dsa/minimize-cash-flow-among-given-set-friends-borrowed-money/ (updated 2026-10-03)
- **Default for new groups** (conflict, unresolved for today):
  - The legacy undated article, re-fetched today, says: "The 'simplify' feature is turned off by default, as it can cause confusion when people aren't expecting it". https://feedback.splitwise.com/knowledgebase/articles/746853-my-dashboard-balances-are-different-than-my-group
  - A staff reply on 2013-05-08 says groups had simplify "for a long time" and they were "only now allowing users to turn it off". https://blog.splitwise.com/2012/09/14/debts-made-simple/
  - The current KB and the API's simplify_by_default state no default.
  - Read together: always on before mid-2013, default off later; the current default is undocumented.
  - Competitors: Settle Up is on by default (https://settleup.io/tips.html); SplitPro is off (https://raw.githubusercontent.com/oss-apps/split-pro/main/prisma/schema.prisma).
- **Build (derived):**
  - Compute suggested transfers from each person's net on every read; never store them as debts.
  - Match the largest creditor with the largest debtor, as SplitPro does (https://raw.githubusercontent.com/oss-apps/split-pro/main/src/lib/simplify.ts), and break ties by member id.
  - Optionally run the exact zero-sum search when about 15 or fewer members have non-zero balances.
  - Tests: every net stays unchanged, there are at most n-1 transfers, and no zero transfers.

### 2.2 Split by adjustment
- The KB says: "Enter an adjustment to a person's share, and the rest of the expense will be split equally among everyone else." A blog post (2015-12-17) gives the example "Sam owes $5 more than everyone else". https://kb.splitwise.com/balances-and-expenses/what-are-different-ways-i-can-split-an-expense , https://blog.splitwise.com/2015/12/17/5-new-features-on-iphone/
- Conflict: read literally, the KB makes Sam pay 100/4 + 5 = 30 and the others 70/3 = 23.33, so Sam pays 6.67 more, which contradicts the blog.
- The only formula that matches the blog (derived): base = (T - sum of adjustments) / n, where n counts everyone on the expense, and share_i = base + adj_i.
  - Example: T = 100, 4 people, Sam +5. Base = 23.75 and Sam pays 28.75, exactly 5 more.
  - Prefer this, since the blog example is concrete and dated.
- Negative adjustments were requested on 2017-01-19 (154 votes) and are "under review". Whether they work today is unverified. https://feedback.splitwise.com/forums/162446-general/suggestions/17780110-allow-negative-adjustments-in-split-by-adjustment
- Adjusting for only some members: staff (2013-04-11) say you can type specific names, but a 2016-07-19 idea says adjustment "requires the entire group". Both are old, and current behavior is unverified. https://feedback.splitwise.com/forums/162446-general/suggestions/3823774-allow-to-choose-participants-when-using-unequal-di , https://feedback.splitwise.com/forums/162446-general/suggestions/2886259-split-an-expense-equally-with-individual-or-ad , https://feedback.splitwise.com/forums/162446-general/suggestions/15271701-allow-subset-of-group-members-for-pay-with-adjustm
- Build (derived): allow plus or minus adjustments and any subset of members. Reject the split if any share would be negative. Round the base using the 2.3 rule.

### 2.3 Rounding
- **Splitwise:**
  - Shares are calculated "to the exact penny, with some getting an extra penny" (2018-03-23).
  - Extra pennies go to a random person on all platforms (2013-11-12, 2016-03-25).
  - Giving them to the person entering the expense was dropped because "it's unfair if there's one person in a group who pays for a lot of expenses" (2016-04-08).
  - Re-saving re-rolls the pick. Support suggests re-saving, and a user saw a comment edit move the 3.34 in a 10/3 split.

  Sources: https://feedback.splitwise.com/forums/162446-general/suggestions/13356690-payment-split , https://feedback.splitwise.com/forums/162446-general/suggestions/18510607-track-the-amount-of-unequal-splits-in-cents , https://feedback.splitwise.com/forums/162446-general/suggestions/33733765--bug-splitting-expense-by-shares-calculation-isn , https://feedback.splitwise.com/forums/162446-general/suggestions/3309275-rotate-who-pays-the-extra-penny-when-the-bill-cann , https://feedback.splitwise.com/forums/162446-general/suggestions/8259597-keep-track-of-pennies
- The Splitwise API uses 2 decimals for every currency. https://raw.githubusercontent.com/splitwise/api-docs/main/schemas/expense/common.yaml
- **Spliit** (MIT-licensed code):
  - Each person first gets floor(amount x weight / total weight).
  - Leftover units go to the largest fractional remainders.
  - Ties rotate by an FNV-1a hash of the expense ID.
  - Results always sum exactly, including for negative amounts.

  Source: https://raw.githubusercontent.com/spliit-app/spliit/main/src/lib/shares.ts
- Tricount publishes its rule: EUR 100 / 3 = 33.34 + 33.33 + 33.33. https://help.tricount.com/articles/tricount-faqs
- Rounding errors cost trust. A tester on Spliit's Show HN (2022-06-24) found balances of -0.70 vs 0.69 after settling. https://hn.algolia.com/api/v1/items/31863691
- **Build (derived):**
  - Store integers at the per-currency exponent in 5.2 and use largest remainder.
  - Break ties with hash(expense_id, member_id), so re-saving never moves units.
  - Assert per expense: total paid = total owed = amount.
  - Assert per group: nets sum to 0.

### 2.4 Multiple payers
- Every participant has a paid_share and an owed_share. The API's share example is paid 8.99, owed 4.5, net 4.49. In the UI you choose "2+ people paid" or "Paid by multiple people" and enter each payer's amount. https://raw.githubusercontent.com/splitwise/api-docs/main/schemas/share.yaml , https://feedback.splitwise.com/forums/162446-general/suggestions/3083636-allow-multiple-payers-in-expenses-that-span-multip , https://feedback.splitwise.com/forums/162446-general/suggestions/12847131-split-who-payed
- Who owes which payer is ambiguous. Staff (2012-08-22): "there are multiple possible ways to determine who owes who", and they would "probably" "assign the debt arbitrarily". The current rule is undocumented. Same forum thread 3083636.
- Each person's net is unambiguous: total paid minus total owed (derived). Settling from nets (2.1) avoids the pairwise question entirely.
- Gap to avoid: Spliit allows only one payer (paidById), which an HN commenter (2024-02-02) called "missing very basic option". https://hacker-news.firebaseio.com/v0/item/39226818.json
- Requested shortcut: "Each person paid an equal share" (2015-05-23, under review). https://feedback.splitwise.com/forums/162446-general/suggestions/8093769-bills-paid-by-multiple-people-each-person-paid-a

### 2.5 Payments
- A payment is an expense with payment = true. https://raw.githubusercontent.com/splitwise/api-docs/main/schemas/expense.yaml
- Payments only reduce a running balance. Staff (2017-09-15): they are "still not planning to add the concept of a payment for a specific bill". After a full settle-up, earlier bills hide "behind a tap or click"; after a partial one, everything stays visible. https://feedback.splitwise.com/forums/162446-general/suggestions/2890783-apply-payment-directly-to-expense-pay-for-individu
- Anyone can record or delete a payment, including ones they didn't record (staff, 2015-12-16). Deleting the record of a Venmo, PayPal or Splitwise Pay payment "will not cancel the funds transfer". https://feedback.splitwise.com/forums/162446-general/suggestions/11110113-only-lent-person-should-be-able-to-settle-up-from , https://kb.splitwise.com/balances-and-expenses/i-accidentally-settled-up-how-can-i-undo-this
- Sign conventions:
  - Totals: "Total change in balance" = what you paid for - your share + payments made - payments received.
  - Export: a person's column is positive when they pay for an expense or make a payment, and negative when they borrow or receive one.
  - So a payment from A to B works like an expense A paid in full and B owes in full (derived; the API docs have no payment example).

  Sources: https://kb.splitwise.com/balances-and-expenses/can-you-explain-the-totals-screen , https://kb.splitwise.com/balances-and-expenses/how-can-i-double-check-my-balances
- Forgiving a debt is done by recording a cash payment (staff, 2017-01-30). https://feedback.splitwise.com/forums/162446-general/suggestions/17887495-add-an-option-to-forgive-all-or-a-specific-amount
- Paying someone other than the suggested person is fine; debts re-simplify around the payment (staff, 2015-04-14). https://feedback.splitwise.com/forums/162446-general/suggestions/7558191-edit-simplify-debt-partners
- A payment that clears everything with a friend auto-adds "Settle all balances" entries in each shared group. Editing or deleting that payment does not update them. https://kb.splitwise.com/balances-and-expenses/what-does-it-mean-if-im-fully-settled-up-with-my-friend

### 2.6 Recurring
- API fields (https://raw.githubusercontent.com/splitwise/api-docs/main/schemas/expense.yaml):
  - repeat_interval: never, weekly, fortnightly, monthly or yearly
  - next_repeat
  - email_reminder_in_advance: null, -1, 0 to 7, or 14 days
- Behavior (https://kb.splitwise.com/balances-and-expenses/how-can-i-manage-recurring-expenses):
  - Copies "post within the same hour they were originally added".
  - They "repeat forever" unless stopped or an involved member is removed.
  - Editing the latest copy changes all future copies and leaves past ones alone.
  - To stop: "Just this once" on mobile, or "Cancel future recurrences" on the web.
  - An optional email reminder goes "to all members on the expense".
  - Mobile has no central list of recurring expenses.
- New group members are not added to existing recurring bills (staff, 2015-10-26). https://feedback.splitwise.com/forums/162446-general/suggestions/10371243-adding-new-people-to-groups-automatically-splits-f
- Better specs elsewhere:
  - Spliit keeps the monthly anchor day: "A 31st clamps to the 28th in February, then returns to the 31st in March". https://raw.githubusercontent.com/spliit-app/spliit/main/src/lib/recurrence.ts
  - Settle Up stores an end date, an end count, "last day of month" and the creator's time zone, and generates copies between 1am and 5am local time. https://api.settleup.io/entities/
  - SplitPro: editing the template affects future copies only, and deleting it keeps the copies already made. https://raw.githubusercontent.com/oss-apps/split-pro/main/docs/RECURRING_TRANSACTIONS.md

### 2.7 Placeholder users and claiming
- Each user has a registration_status of confirmed, dummy or invited. https://raw.githubusercontent.com/splitwise/api-docs/main/schemas/user.yaml
- Adding a person who has no account requires user_first_name. For an existing user, any names supplied are ignored. https://dev.splitwise.com/
- A placeholder is "someone tracked by name, without contact info", added from the web only. Add an email or phone later "to give them access". Splitwise recommends against fake emails. https://kb.splitwise.com/getting-started/can-i-add-a-friend-without-adding-their-email-address-or-phone-number
- Claiming: contact info is editable "as long as they have not yet claimed the account by logging in". After that, "only the owner" can change it. https://kb.splitwise.com/groups/how-do-i-edit-my-friends-email-or-phone-number
- Joining by link (example: https://www.splitwise.com/join/abQwErTyuI+12): open the link, log in, and the group is added to your account. If you were invited under a different email, open the link and log into your existing account. https://raw.githubusercontent.com/splitwise/api-docs/main/schemas/group.yaml , https://kb.splitwise.com/groups/how-do-i-join-an-existing-group
- Duplicates appear when someone is added by email and by phone separately. Merging needs both passwords and no shared expenses, and merges are "not reversible". https://kb.splitwise.com/groups/someone-was-added-to-the-group-twice-how-can-i-fix-this , https://kb.splitwise.com/account-issues/what-can-i-do-if-i-have-two-splitwise-accounts
- Build (derived): members are rows in each group. The invite link opens the list of unclaimed names (the Section 3 pattern), so joining never creates a duplicate.

### 2.8 Delete and restore
- Expenses: soft delete with deleted_at and deleted_by. "Anyone who was originally included on the expense has the option to undelete it", and balances recalculate. No time limit is stated. https://kb.splitwise.com/balances-and-expenses/how-can-i-restore-a-deleted-expense , https://raw.githubusercontent.com/splitwise/api-docs/main/schemas/expense.yaml
- Groups: deleting "removes it for all group members". Undelete "restores the group and all of the expenses and payments", from Recent activity or account settings. No time limit is stated. https://kb.splitwise.com/groups/how-do-i-delete-or-undelete-a-group
- Removing a member fails while they have a non-zero balance. Clear it with a cash payment or by taking them off expenses. A 2012 user saw removed members shown as "[removed]". https://kb.splitwise.com/groups/how-do-i-remove-a-person-from-a-group , https://feedback.splitwise.com/forums/162446-general/suggestions/3120023-keep-former-group-members-in-the-transaction-histo
- Cancelled trip guidance:
  - Delete fully refunded expenses.
  - Edit partly refunded ones down; $150 with a $50 refund becomes $100.
  - Leave recorded payments alone.

  Source: https://feedback.splitwise.com/knowledgebase/articles/1939972-my-trip-was-canceled-how-to-handle-refunded-expen
- Spliit keeps deleted groups restorable for 30 days. https://raw.githubusercontent.com/spliit-app/spliit/main/README.md , https://raw.githubusercontent.com/spliit-app/spliit/main/messages/en-US.json

### 2.9 History
- Recent activity "cannot be cleared, as it serves as a record of changes". The mobile app loads the "most recent 100" items. https://kb.splitwise.com/account-issues/where-can-i-view-a-history-of-recent-changes-to-my-account
- Edits appear as System comments in the expense thread (blog post 2014-03-31). The API sample reads "John D. updated this transaction: - The cost changed from $6.99 to $8.99". https://blog.splitwise.com/2014/03/31/splitwise-notifications-now-on-steroids/ , https://dev.splitwise.com/
- Event list (API notification types): 0 expense added, 1 updated, 2 deleted, 3 comment added, 4 added to group, 5 removed from group, 6 group deleted, 7 group settings changed, 8 added as friend, 9 removed as friend, 10 news, 11 debt simplification, 12 group undeleted, 13 expense undeleted, 14 group currency conversion, 15 friend currency conversion. https://dev.splitwise.com/
- Notifications wait 60 seconds "in case you need to correct any errors", and are never sent for your own changes. https://kb.splitwise.com/account-issues/why-am-i-not-receiving-email-notifications
- Updating an expense with any share field overwrites all of its shares. https://dev.splitwise.com/

### 2.10 Not documented anywhere (decide these yourself and write the decision down)
1. Whether Simplify Debts is on or off for new groups today.
2. The in-group simplification algorithm, its tie-break order, and whether it uses only nets.
3. How a multi-payer expense turns into person-to-person debts (the API's "repayments").
4. The adjustment formula (the KB wording conflicts with the blog), its rounding, and whether negative adjustments are allowed now.
5. How itemized tax, tip and discounts are shared out. The only fact: the box takes an amount or a percent (staff, 2015-08-06). https://feedback.splitwise.com/forums/162446-general/suggestions/9165838-fix-the-tax-tip-section
6. Any time limit on undeleting expenses or groups.
7. Resetting or revoking a group invite link.
8. Maximum group size.
9. How the daily cap counts (edits, deletes, payments, reset time, timezone, per user or per group), and the countdown itself.
10. The sign convention of API balance amounts, and how a payment is encoded in paid and owed shares.
11. How a removed member shows on old expenses today, and the rules for leaving a group beyond a zero balance.
12. How often Splitwise refreshes Open Exchange Rates.
13. The exact CSV export header. Third-party guides and Cospend's importer code expect Date, Description, Category, Cost, Currency, then one column per member, plus a "Total balance" row (https://raw.githubusercontent.com/julien-nc/cospend-nc/main/lib/Service/CospendService.php). Check one real export from Gino's account before writing the importer.
14. The full list of notification settings.
15. Whether free users can attach receipts today and at what resolution, and whether manual itemizing is Pro.
16. Whether Itemize guests who scan the QR code use a web browser.
17. The exact activity-feed wording and colors. Only user reports exist ("You borrowed", "You lent", orange and green), plus color #5bc5a7 in the API sample.

## 3. Ideas from competitors (filtered for Gino's use)

Cospend is AGPL-3.0, so take its ideas, not its code. Spliit and SplitPro are MIT (https://raw.githubusercontent.com/spliit-app/spliit/main/README.md , https://github.com/oss-apps/split-pro).

| Idea | App | Fits | Source |
|---|---|---|---|
| Join by link or QR, then a "Who are you?" picker saved on the device (localStorage key `${groupId}-activeUser`). Includes "I don't want to select anyone". | Spliit | Many-person trips, friends without accounts | https://raw.githubusercontent.com/spliit-app/spliit/main/messages/en-US.json , https://raw.githubusercontent.com/spliit-app/spliit/main/src/lib/hooks.ts |
| The identity you pick on first join becomes your default payer | Tricount | Fast entry | https://help.tricount.com/articles/tricount-faqs |
| Green tick for members who have identified themselves, grey cross for the rest | Kittysplit | 10-person trips: see who hasn't opened the link | https://www.kittysplit.com/en/help |
| Members are names without accounts; a user claims one with "This is me"; several users can claim the same member | Settle Up | Couples, mixed accounts | https://api.settleup.io/entities/ |
| A short group code you can read out loud (9 characters since v1.8.1, 2023-03-25) | Splid | Trip dinners | https://apps.apple.com/us/app/splid-split-group-bills/id991473495 |
| Each share link has a role (Viewer, Participant, Maintainer, Admin) and an optional password; brute-force protection on public endpoints (1.6.0, 2024-01-28) | Cospend | Read-only link for parents or observers | https://raw.githubusercontent.com/julien-nc/cospend-nc/main/docs/user.md , https://raw.githubusercontent.com/julien-nc/cospend-nc/main/CHANGELOG.md |
| The invite link can be switched off (inviteLinkActive); there is a read-only permission level (10) | Settle Up | Leaked links | https://api.settleup.io/entities/ |
| "Center settlement on one member", so everyone pays the person who fronted (0.5.2, 2020-05-09) | Cospend | Gino fronts lodging and lift tickets | https://raw.githubusercontent.com/julien-nc/cospend-nc/main/CHANGELOG.md |
| A default weight per member (a couple = 2); Kittysplit allows decimals like 2.5 (paid tier) | Settle Up, Cospend, Kittysplit | Couples within trips | https://settleup.io/tips.html , https://raw.githubusercontent.com/julien-nc/cospend-nc/main/docs/user.md , https://www.kittysplit.com/en/help |
| Shares by nights (5 vs 3); Splitwise's own travel calculator uses a grid of which days people were present | Kittysplit; Splitwise calculator | Ski-house lodging | https://www.kittysplit.com/en/help , https://www.splitwise.com/calculators/travel |
| Turn off "Include this member in new transactions" for people who left; deactivated members stay until their balance is 0 | Settle Up; Cospend | People dropping out of a trip | https://settleup.io/tips.html , https://raw.githubusercontent.com/julien-nc/cospend-nc/main/docs/user.md |
| Tap a member to add an expense they paid; long-press to duplicate; circle size shows debt; a "who pays next" hint | Settle Up | Daily trip logging | https://settleup.io/tips.html |
| Payers stored as a weighted list (whoPaid); tip and tax as line items with their own weights | Settle Up | Deposits on two cards, group dinners | https://api.settleup.io/entities/ |
| Expense list grouped by date | Splid (1.9) | Trip days | https://apps.apple.com/us/app/splid-split-group-bills/id991473495 |
| A who-paid-for-whom table; statistics by category and by member | Cospend | End-of-trip review | https://raw.githubusercontent.com/julien-nc/cospend-nc/main/CHANGELOG.md |
| Spending totals ("Your spending", "Your share") leave out settle-up payments | Spliit | Trip summary | https://raw.githubusercontent.com/spliit-app/spliit/main/src/lib/totals.ts |
| XLSX export with the calculations and final balances | Kittysplit | Answers "why do I owe this" | https://www.kittysplit.com/en/help |
| Participant caps to beat: Kittysplit free allows 9, Tricount 50 | Kittysplit, Tricount | 10-person trips | https://www.kittysplit.com/pricing , https://help.tricount.com/articles/tricount-effortlessly-share-expenses-with-friends |
| One base currency per group; each expense stores its original amount, original currency and rate. The rate comes from Frankfurter for the expense date or is typed in ("Use custom rate"), with clear error text when no rate exists. | Spliit | Yen trips | https://raw.githubusercontent.com/spliit-app/spliit/main/src/lib/currency-conversion.ts , https://raw.githubusercontent.com/spliit-app/spliit/main/messages/en-US.json |
| A hand-edited rate carries forward to later entries until reset (fixedExchangeRate) | Settle Up | Enter the card's real rate once per trip | https://settleup.io/tips.html , https://api.settleup.io/entities/ |
| The rate is fixed when the expense is entered and re-fetched only if its date changes | Kittysplit | Stable history | https://www.kittysplit.com/en/help |
| A cache table of rates (from, to, date, rate) | SplitPro | Worker plus D1 rate cache | https://raw.githubusercontent.com/oss-apps/split-pro/main/prisma/schema.prisma |
| Show balances in one currency without rewriting the expenses | SplitPro | A conversion that can be undone | https://raw.githubusercontent.com/oss-apps/split-pro/main/docs/CURRENCY_CONVERSIONS.md |
| Things to avoid: Spliit's 35-currency list has no TWD, PEN or CRC; Cospend stores one float rate per project | Spliit, Cospend | Bad patterns | https://raw.githubusercontent.com/spliit-app/spliit/main/src/lib/currency.ts , https://raw.githubusercontent.com/julien-nc/cospend-nc/main/lib/Db/Currency.php |
| A saved default split per group and per friend (split type plus shares); "Save as default splitting options" | SplitPro; Spliit | Groceries: equal split, Gino pays | https://raw.githubusercontent.com/oss-apps/split-pro/main/prisma/schema.prisma , https://raw.githubusercontent.com/spliit-app/spliit/main/messages/en-US.json |
| Three entry types: expense, transfer, income. The couples page advises recording repayments "as a transfer rather than another expense" | Tricount | Partner ledger | https://help.tricount.com/articles/tricount-faqs , https://tricount.com/use-cases/couples |
| Recurring entries with an end date or count, "last day of month", and the creator's time zone | Settle Up | Rent and utilities | https://api.settleup.io/entities/ |
| Balances come from a database view built from the expenses and are never stored; soft delete records deletedBy | SplitPro | A years-long grocery ledger stays consistent | https://raw.githubusercontent.com/oss-apps/split-pro/main/README.md , https://raw.githubusercontent.com/oss-apps/split-pro/main/prisma/schema.prisma |
| Calculator in the amount keyboard (iOS only); archive with restore; an emoji for each group | Tricount | Receipts; scanning 40 groups | https://help.tricount.com/articles/how-can-i-manage-my-tricounts-and-expenses |
| A zh-TW translation with ready terms: 群組, 支出/消費, 收入, 支付人, 應支付人, 平均分配, 自訂份額/自訂百分比/自訂金額, 總覽, 建議核銷, 標記為已支付, 你是誰？, 分享連結, 類別, 週期性支出, 匯率, 主要幣別, 匯出, 統計, 封存. It mixes 消費 and 支出 and has one Simplified string, so pick one term per concept. | Spliit | Taiwanese friends | https://raw.githubusercontent.com/spliit-app/spliit/main/messages/zh-TW.json |
| An optional free account only to collect your groups across devices; the link alone is enough to take part | Kittysplit; SplitPro "Quick split" | Friends without accounts; new phones | https://www.kittysplit.com/en/help , https://splitpro.app |
| Payment handles stored per member (e.g. revolut, cashapp), plus bankAccount; a user's default handles are copied onto members they claim | Settle Up | Gets handles out of display names | https://api.settleup.io/entities/ |
| Offline lessons. Spliit's offline app cannot save (API calls always need the network). A Tricount update erased a week-long trip that hadn't synced (App Store review 10/12/2024). So: keep an outbox on the device, never clear it on update, and offer an export of unsynced entries. | Spliit, Tricount | Niseko, Peru, Costa Rica | https://raw.githubusercontent.com/spliit-app/spliit/main/public/sw.js , https://apps.apple.com/us/app/tricount-split-settle-bills/id349866256 |

## 4. Splitwise pain points our free app can fix

| Pain point | Evidence | Our fix | Source |
|---|---|---|---|
| Daily cap and slow entry | "up to 4 expenses each day"; reviews of a "10-second countdown" (2026-02-26) and "constant upselling modals" (2025-07-11); Trustpilot 2.0/5 from 72 reviews | No cap, no interstitials; under 5 seconds from opening the app to saved | https://kb.splitwise.com/pro/what-is-splitwise-pro , https://www.trustpilot.com/review/splitwise.com |
| Yen saved as "$" (brief) | New expenses default to the last currency used; changing the currency only relabels; "$" and "¥" are shared symbols | Base currency set per group; ISO code shown beside every amount; warn on implausible amounts (derived) | https://kb.splitwise.com/balances-and-expenses/how-can-i-manage-a-friendship-or-group-with-multiple-currencies , https://secure.splitwise.com/api/v3.0/get_currencies |
| No default currency per group | Requested since 2012-12-27 (309 votes); the 2015-06-19 workaround is to change your profile currency | A group setting | https://feedback.splitwise.com/forums/162446-general/suggestions/3495208-set-default-currency-for-groups-instead-of-profile |
| Conversion is Pro, rewrites the whole ledger at today's rate, and may not be reversible | KB. A custom rate was requested on 2016-07-17 (203 votes); comments ask for a rate per expense and for the expense date's rate | A stored rate on each expense (expense-date default, editable), free | https://kb.splitwise.com/pro/how-are-exchange-rates-calculated-for-currency-conversion , https://feedback.splitwise.com/forums/162446-general/suggestions/15248577-currency-rate |
| Search, charts, default split and JSON backup are paid | Pro pages | All free | https://www.splitwise.com/subscriptions/new , https://kb.splitwise.com/account-issues/how-do-i-export-my-splitwise-data |
| Refunds are web-only | KB; 283 votes | Refunds on the phone | https://kb.splitwise.com/balances-and-expenses/how-do-i-add-a-refund-or-reimbursement |
| No negative adjustments | 154 votes; under review since 2017-01-19 | Plus or minus adjustments | https://feedback.splitwise.com/forums/162446-general/suggestions/17780110-allow-negative-adjustments-in-split-by-adjustment |
| Editing forgets the shares or percentages you typed | 133 votes; reply on 2016-04-05: "a bunch of difficult work" | Store the split inputs | https://feedback.splitwise.com/forums/162446-general/suggestions/3465674-when-editing-an-unequal-split-load-the-entered |
| Extra pennies move on every re-save | Random re-pick on each save | Deterministic remainder rule | https://feedback.splitwise.com/forums/162446-general/suggestions/13356690-payment-split |
| Name-only friends only on the web; friends can't be renamed | KB; 625 votes and 463 votes | Name-only members anywhere; nickname per group | https://kb.splitwise.com/getting-started/can-i-add-a-friend-without-adding-their-email-address-or-phone-number , https://feedback.splitwise.com/forums/162446-general |
| Payment handles end up in display names (brief) | Storing bank details is "not on our roadmap" for security reasons (2014-10-16, 419 votes); Venmo or Zelle ID on profile requested 2022-05-30 | Proper handle fields; never full bank account numbers | https://feedback.splitwise.com/forums/162446-general/suggestions/4153517-bank-account-details-somewhere-anywhere , https://feedback.splitwise.com/forums/162446-general/suggestions/45237751-add-venmo-id-zelle-id-on-account-profile |
| Pay links are US and USD only, and they break | Venmo stopped working on Android "As of 7/2/26" | Handles with copy buttons; deep links as best effort | https://kb.splitwise.com/payment-integrations/how-do-i-send-money-via-paypal-or-venmo |
| Reminders go one person at a time | "Planned" since 2012-09-12; sharing a balance via WhatsApp has 172 votes | One summary shared to LINE, WhatsApp or iMessage via the share sheet | https://feedback.splitwise.com/forums/162446-general/suggestions/3108868-send-reminder-to-all-people-in-a-group , https://feedback.splitwise.com/forums/162446-general?page=2 |
| No archive | 168 votes | Archive finished trips | https://feedback.splitwise.com/forums/162446-general/suggestions/7172089-allow-manual-archiving-of-group |
| Simplify confuses people | People who never shared an expense get paired; amounts can't be traced (2014-05-16) | A "why" breakdown for each person; settle-through-one-person mode | https://feedback.splitwise.com/forums/162446-general/suggestions/6304775-relationships-for-debt-calculation , https://feedback.splitwise.com/forums/162446-general/suggestions/5933386-track-a-bill-when-simplify-debts-in-on |
| No Chinese UI | App Store language list | zh-TW and English | https://apps.apple.com/us/app/splitwise/id458023433 |
| No custom categories; lodging sits under Transportation > Hotel | 669 votes; "not ... in the near future" | Custom categories plus trip categories | https://feedback.splitwise.com/forums/162446-general/suggestions/2900634-allow-custom-categories , https://secure.splitwise.com/api/v3.0/get_categories |
| Calculator only on the web; the website rejects comma decimals | 955 votes and 270 votes | Calculator in the amount field; accept "." or "," | https://feedback.splitwise.com/forums/162446-general/suggestions/4963941-ability-to-use-a-calculator-when-entering-bill , https://feedback.splitwise.com/forums/162446-general?page=2 |
| Recurring expenses are hard to manage | No list on mobile; 359 votes; varying amounts have 153 votes | A recurring-expenses page | https://kb.splitwise.com/balances-and-expenses/how-can-i-manage-recurring-expenses , https://feedback.splitwise.com/forums/162446-general/suggestions/3625914-managing-recurring-expenses |
| No "copy bill"; no way to mark "all expenses entered" | 324 votes and 164 votes | Duplicate expense; a "ready to settle" flag | https://feedback.splitwise.com/forums/162446-general?page=2 |
| A subscription doesn't pay off for occasional trips, and switching apps is painful | HN comment 2024-09-06; Spliit blog 2024-02-04 | Free app plus an importer | https://hacker-news.firebaseio.com/v0/item/41468132.json , https://spliit.app/blog/we-need-an-open-source-alternative-to-splitwise |
| Mobile history shows only 100 items; totals are calculated on the phone | KB | Full history in pages; totals calculated on the server | https://kb.splitwise.com/account-issues/where-can-i-view-a-history-of-recent-changes-to-my-account , https://kb.splitwise.com/balances-and-expenses/can-you-explain-the-totals-screen |

## 5. Technical facts

### 5.1 Exchange-rate API (TWD support verified)

| Source | TWD | History | Terms and limits | Role |
|---|---|---|---|---|
| Frankfurter v2, `https://api.frankfurter.dev/v2/rates` | Yes, re-fetched 2026-10-16. Per 1 USD: TWD 32.275, JPY 158.21, IDR 17923, MXN 18.471, EUR 0.89272, CAD 1.4203 (all dated 2026-10-16); CRC 453.24 and PEN 3.4354 are dated 2026-10-15 | Back to 1948. `?date=` also works on weekends, returning a row for that calendar day | "You don't need an API key"; "There are no quotas"; "rate-limited to prevent abuse" (no number given); "Rates update daily" | Primary |
| fawazahmed0 currency-api (jsDelivr; fallback host `{date}.currency-api.pages.dev`) | Yes: 32.44594953 on 2026-10-16 | From 2024-03-02 only (2024-03-01 returns 404) | "No Rate limits"; CC0. @latest can be cached by the CDN for up to 7 days. The list includes crypto and metals codes | Fallback |
| open.er-api.com v6 | Yes: 32.360287 | None on the free tier | Must show an attribution link; no redistribution; HTTP 429 for 20 minutes when limited | Last resort, today's rate only |
| Frankfurter v1 and api.frankfurter.app | No. ECB data only, 29 quotes, missing TWD, VND, CRC and PEN | | v1 is "deprecated in favor of v2"; the .app host redirects (301) to .dev/v1 | Do not use |

Sources: https://api.frankfurter.dev/v2/rates?base=USD&quotes=TWD,JPY,IDR,CRC,PEN,MXN,EUR,CAD (re-fetched), https://frankfurter.dev/ (re-fetched), https://api.frankfurter.dev/v2/rates?base=USD&quotes=TWD,JPY,EUR&date=2026-10-11 , https://github.com/fawazahmed0/exchange-api , https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json , https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@2024-03-01/v1/currencies/usd.json , https://github.com/jsdelivr/jsdelivr , https://open.er-api.com/v6/latest/USD , https://www.exchangerate-api.com/docs/free , https://api.frankfurter.dev/v1/latest?from=USD , https://frankfurter.dev/v1/

- Conflict on coverage: frankfurter.dev claims "223 currencies" (re-fetched; it doesn't say whether old codes count). The researcher's fetches of /v2/currencies returned 165 and /v2/rates?base=USD returned 164 rows. The site documents that `scope=all` will "Include legacy currencies", so the 223 probably counts legacy codes (derived). Trust what the API returns. https://api.frankfurter.dev/v2/currencies
- Each row carries its own date, and CRC and PEN run a day behind. Store the date the API returns, not the date you asked for.
- Rates are rounded to about 5 significant digits; for example, base=TWD gives USD as 0.03098. Fetch with base=USD and calculate cross rates yourself (derived). https://api.frankfurter.dev/v2/rates?base=TWD&quotes=USD,JPY,KRW,EUR
- There is no conversion endpoint; multiply the rate yourself. https://frankfurter.dev/
- CORS headers on api.frankfurter.dev could not be checked, because WebFetch doesn't show response headers. A third-party pull request (2026-10-10) says the old .app host sends none. Fetch rates in the Worker and cache each (base, quote, date) in D1; the docs encourage storing rates locally. https://github.com/digitaltoolshub/digitaltoolshub.github.io/pull/4
- Today the three sources differ by about 0.5% on TWD (32.275, 32.360, 32.446). Store the rate, its source and its date on each expense, and allow an override such as the amount the card actually charged.

### 5.2 Currency decimals (our recommendation, derived from the ISO and CLDR values below)

| Currency | ISO 4217 decimals (SIX list one, published 2026-09-17) | CLDR 48 decimals / cash decimals | App decimals |
|---|---|---|---|
| JPY, KRW, VND, ISK, CLP | 0 | 0 | 0 |
| TWD | 2 | 2 / 0 | 0 |
| CRC | 2 | 2 / 0 | 0 |
| IDR | 2 | 0 | 0 |
| HUF | 2 | 0 (cash rounds to 5) | 0 |
| IQD | 3 | 0 | 0 |
| USD, EUR, CNY, MXN, PEN, THB | 2 | 2 (CLDR default) | 2 |
| CAD, CHF | 2 | 2 (cash rounds to 5) | 2 |
| DKK | 2 | 2 (cash rounds to 50) | 2 |
| SEK, NOK | 2 | 2 / 0 | 2 (derived reason: card receipts show ore) |
| HKD | 2 (Wikipedia ISO table) | 2 (CLDR default) | 2 |
| BHD, KWD, OMR, JOD, TND, LYD | 3 | 3 | 3 |
| Any other code | | CLDR value, else the CLDR default of 2 | Same |

Sources: https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml , https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-core/supplemental/currencyData.json , https://cldr.unicode.org/downloads/cldr-48 (released 2025-10-29), https://en.wikipedia.org/wiki/ISO_4217

- Store amounts as integers in the smallest unit for these decimals. Frankfurter's currency list has no decimals field, and gives TWD's symbol as "$". In JavaScript, the browser's default decimals per currency are up to each implementation and fall back to 2, so always pass minimumFractionDigits and maximumFractionDigits from this table to Intl.NumberFormat. https://api.frankfurter.dev/v2/currencies , https://tc39.es/ecma402/#sec-currencydigits (draft dated 2026-10-12)
- Splitwise data arrives with 2 decimals in every currency. Re-round imported TWD, IDR and CRC rows one expense at a time with the 2.3 rule, and flag rows whose cost had cents (derived). https://raw.githubusercontent.com/splitwise/api-docs/main/schemas/expense/common.yaml
- For foreign-currency expenses, convert the total once, round it to the base currency's decimals, then split in the base currency. This is Spliit's approach. https://raw.githubusercontent.com/spliit-app/spliit/main/src/lib/currency-conversion.ts

### 5.3 Safari storage and tracking prevention: what it means for the login token

**Facts**
- After "seven days of Safari use without user interaction on the site", Safari deletes all storage that page scripts can write: localStorage, IndexedDB, sessionStorage, service workers and their caches, and cookies set by JavaScript. Interaction means a click, tap or keypress; "Scrolling is not considered user interaction". https://webkit.org/tracking-prevention/ , https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ (2020-03-24)
- Home Screen web apps have "their own counter of days of use" and are exempt from that deletion. Their data "is kept isolated from Safari", with "separate cookies and storage from the browser" (WWDC23). https://webkit.org/tracking-prevention/ , https://developer.apple.com/videos/play/wwdc2023/10120/
- Safari blocks cross-site cookies by default. WebKit recommends a "Secure and HttpOnly" session cookie set by the site's own server. https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- Cookies set by a server are capped at 7 days when that server's IP address doesn't match the page's (IP cloaking) or a subdomain is CNAME'd to someone else (CNAME cloaking).
  - WebKit's source code applies the cap when the API server's IPv4 address shares fewer than its first 16 bits with the page's server.
  - GitHub Pages uses 185.199.108.153 to 185.199.111.153. Cloudflare's IPv4 ranges (e.g. 104.16.0.0/13, 172.64.0.0/13) are elsewhere.
  - Which Safari version shipped this is unconfirmed.

  Sources: https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebKit/NetworkProcess/cocoa/NetworkTaskCocoa.mm , https://www.cloudflare.com/ips-v4 , https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site
- In-app browsers:
  - Each iOS app has its own cookie store.
  - Tracking prevention is on by default for in-app web views from iOS 14 (2020-06-26).
  - Instagram and Facebook open links in their own browser (2022-08-10).
  - LINE opens a link in the external browser when it carries `?openExternalBrowser=1`.

  Sources: https://developer.apple.com/tutorials/data/documentation/foundation/httpcookiestorage.json , https://webkit.org/blog/10882/app-bound-domains/ , https://krausefx.com/blog/ios-privacy-instagram-and-facebook-can-track-anything-you-do-on-any-website-in-their-in-app-browser , https://developers.line.biz/en/docs/line-login/using-line-url-scheme/
- Storage limits (Safari 17 and later):
  - A site may use up to 60% of disk in the browser, and the same in a Home Screen app.
  - Data is evicted least-recently-used first, including for sites the user hasn't interacted with for some time.
  - `navigator.storage.persist()` is granted by heuristics, such as the site being a Home Screen web app.

  Source: https://webkit.org/blog/14403/updates-to-storage-policy/ (2023-08-10)

**What this means for the token (derived)**
- **Current plan is cross-site.** The app on GitHub Pages (richlovegod.github.io) calling a Worker on *.workers.dev is cross-site, so a cookie session won't work. The app must keep a token in localStorage, and anyone using a Safari tab loses it after about 7 Safari-days without opening the app.
- **Later custom domain still caps cookies.** With the app at x.ginochang.com on GitHub Pages and the API at api.ginochang.com on a Worker, cookies work but expire after 7 days because the IPs don't match. That holds unless both hostnames resolve to addresses sharing the first 16 bits, which is unverified for Cloudflare-proxied hostnames.
- **Only one origin avoids the cap.** A Worker that serves both the app and /api is the only setup with an uncapped HttpOnly cookie. GitHub's own docs say Pages "shouldn't be used for sensitive transactions like sending passwords". https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- **v1: make the credential cheap to lose.**
  - The group link is the key, and it lives in the LINE or WhatsApp chat.
  - "Who am I" is a non-secret choice stored on each device. Reopening the link restores both.
  - Ask friends to Add to Home Screen, and expect them to pick their name again inside the installed app, since its storage is separate.
  - Any later login must finish inside the installed app (for example a typed code), because a link in Mail opens Safari, not the Home Screen app (inference).
  - Anyone with the link can edit, and the name a person picks is not verified; Spliit accepts the same trade-off. https://spliit.app/blog/why-spliit-doesnt-ask-you-to-create-an-account (2026-08-29)
- **Keep the group key after the "#".** The part after "#" "is not sent to the server" (MDN, last modified 2026-06-22), so GitHub, which logs visitor IP addresses, never sees the key. Send the key to the Worker in a request header. https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment , https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- **LINE share links.** Put the flag in the real query string, before the "#": `https://richlovegod.github.io/<repo>/?openExternalBrowser=1#/g/<key>` (inference; LINE's docs only show `https://example.com/?openExternalBrowser=1`).

### 5.4 Cloudflare free-plan limits

**Workers Free** (limits page updated 2026-10-12; pricing page updated 2026-10-02):
- 100,000 requests a day, resetting at 00:00 UTC; after that, requests fail with Error 1027.
- 10 ms of CPU per request and per scheduled (Cron) run. Time spent waiting on fetch, KV or D1 doesn't count. Occasional overruns are tolerated; consistent ones are killed with Error 1102.
- 128 MB memory, 50 outgoing requests per request, 6 open connections at once, 5 Cron Triggers per account, 100 Workers per account.
- Static file requests are "free and unlimited", up to 20,000 files per version and 25 MiB per file.
- The paid plan costs at least $5 a month and includes 10 million requests and 30 million CPU ms.

Sources: https://developers.cloudflare.com/workers/platform/limits/ , https://developers.cloudflare.com/workers/platform/pricing/ , https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/

**D1 Free** (limits and pricing pages updated 2026-04-21; Worker API page updated 2026-06-22):
- 10 databases, 500 MB each, 5 GB per account.
- 5 million rows read and 100,000 rows written per day, resetting at 00:00 UTC. Past that, "you will not be able to run queries against D1".
- 50 queries per Worker invocation, 100 bound parameters per query, 100 KB per SQL statement, 2 MB per row, 30 seconds per query. Time Travel keeps 7 days.
- "Rows read" counts every row a query scans, so indexes reduce it. "Each indexed-column write adds one row written". Queries run from the dashboard or Wrangler are billed too.
- `batch()` runs several statements in one call, one after another, and rolls back all of them if any fails. Whether a batch counts as 1 or several of the 50 queries is undocumented.

Sources: https://developers.cloudflare.com/d1/platform/limits/ , https://developers.cloudflare.com/d1/platform/pricing/ , https://developers.cloudflare.com/d1/worker-api/d1-database/

**KV Free** (updated 2026-10-08): 100,000 reads and 1,000 writes a day, and 1 write per second to the same key. That is too few writes for sessions or logs. https://developers.cloudflare.com/kv/platform/limits/

**Cron Triggers** (updated 2026-09-04): five-field cron expressions plus the Quartz extras L, W and #. They run in UTC. Weekday 1 is Sunday, unlike many cron systems. Changes take up to 15 minutes to apply. Test locally with `/cdn-cgi/local/scheduled` under `wrangler dev`. https://developers.cloudflare.com/workers/configuration/cron-triggers/

**Password hashing:**
- Workers cap PBKDF2 at 100,000 iterations; deployed Workers throw an error above that. A pull request to raise the cap to 1 million has been open since 2026-09-26.
- One blog (2026-09-25) measured 100,000 iterations at 23 ms of CPU on a deployed Free Worker, and bursts of sign-ins hit Error 1102.

Sources: https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/io/limit-enforcer.h , https://dxdev.com/blog/cf-pbkdf2-workers-limit/ , https://github.com/cloudflare/workerd/pull/7550 , https://nilaykabariya.blog/deploy/worker-exceeded-cpu-time-limit-error-1102

**What this means (derived)**
- Don't hash passwords on the server on the Free plan.
- Make each save one `batch()`: the expense, its shares and its activity row.
- Importing N rows into a table with k indexes costs about N x (1 + k) rows written. A long Splitwise history can use up the 100,000-a-day allowance, so import a few groups per day. Split multi-row inserts so each statement stays under 100 bound parameters.
- A 40-group home screen that rescans every share row on each load burns through reads. Keep a cache of each group's balances, recomputed inside the same save batch; it is still derived data, not the source of truth.
- One daily Cron Trigger can cover both exchange-rate prefetching and posting recurring expenses.

### 5.5 Installable web app (PWA) on iOS
- In iOS 26, "every website added to the Home Screen opens as a web app", and users can turn off "Open as Web App". Icons declared in the manifest are used. https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/ (2025-06-09)
- If both are present, "apple-touch-icon will take precedence over the Manifest-declared icons". https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ (2023-02-16)
- In a Home Screen app, links outside the manifest's scope open in Safari View Controller, a browser sheet inside the app. https://developer.apple.com/videos/play/wwdc2023/10120/
- Web Push:
  - Works from iOS 16.4, for Home Screen web apps only.
  - Permission may be asked only "in response to direct user interaction".
  - No Apple Developer Program membership is needed. Allow `*.push.apple.com` push endpoints.
  - Icon badges are granted automatically to Home Screen apps.
  - Declarative Web Push works from iOS 18.4.

  Sources: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ , https://webkit.org/blog/13966/webkit-features-in-safari-16-4/ (2023-03-27), https://webkit.org/blog/16535/meet-declarative-web-push/ (2025-03-27)
- Add to Home Screen also works from third-party browsers (iOS 16.4), and from Safari View Controller and many in-app browsers (iOS 17). https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ , https://developer.apple.com/videos/play/wwdc2023/10120/
- To clear the notch and home indicator, use `viewport-fit=cover` with `env(safe-area-inset-*)` padding, e.g. `max(12px, env(safe-area-inset-bottom))`. https://webkit.org/blog/7929/designing-websites-for-iphone-x/ (2017-09-22)
- Safari 27.0 (2026-09-17) lists no changes to tracking prevention or the manifest. https://webkit.org/blog/18325/webkit-features-for-safari-27-0/

### 5.6 GitHub Pages
- On a free account the repo must be public, and the site is public. https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site
- A project site lives at `https://richlovegod.github.io/<repo>/`. You publish from a branch (its root or /docs) or a GitHub Actions workflow, and a deploy can take up to 10 minutes. https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
- Limits: the site can be at most 1 GB, with a soft limit of 100 GB of traffic a month and a soft limit of 10 builds an hour (not applied to custom Actions workflows). Throttled requests get HTTP 429. Pages is not for commercial SaaS and not for "sending passwords". https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- Pages doesn't support single-page-app routing. A 404.html redirect trick exists, but Google stopped following it around 2019. Hash routes (#/group/123) avoid the problem. https://github.com/rafgraph/spa-github-pages
- Custom domain, for later:
  1. Verify ginochang.com with a TXT record at `_github-pages-challenge-richlovegod`.
  2. Point a CNAME for the subdomain at `richlovegod.github.io`.
  3. Tick "Enforce HTTPS" once the Let's Encrypt certificate is issued.

  Extra A, AAAA, ALIAS or CNAME records can block the certificate. A custom Actions workflow ignores the CNAME file. DNS changes can take up to 24 hours. Whether a Cloudflare record with proxying on blocks the certificate was not checked. https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages , https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site , https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https
- An alternative that still keeps the code on GitHub: let the Worker serve the app's files, with `not_found_handling = "single-page-application"` and `run_worker_first = ["/api/*"]` (needs Wrangler 4.20.0 or later). https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/ (updated 2026-10-12)

## 6. Recommended v1 scope

**Must (usable tomorrow)**
1. **Groups:** name, emoji, type (trip, home, couple, other), base currency (ISO code), and members typed in as names. Why: this covers all 40 of his groups, and a base currency stops yen being saved as "$".
2. **Joining:** share link and QR code, a "Who are you?" picker saved on each device, and the chosen member becomes the default payer. The 128-bit key goes after "#", and LINE links use the format in 5.3. Why: friends join in one tap with no account, and it survives Safari's 7-day wipe.
3. **Add expense:** amount, currency chip (group base by default), description, category, date, payer and split, with a default payer and split saved per group. Categories: Splitwise's IDs with zh-TW labels, plus lodging, lift tickets and activities. Why: slow entry is the main complaint, and daily groceries become two taps.
4. **Split methods:** equal (untick people), exact, percent and shares. Save the inputs and show a live "remaining" line. Why: Splitwise's free set, and edits keep what was typed.
5. **Multiple payers:** in both the data model and the form. Why: villa deposits go on two cards, and this is painful to add later.
6. **Money math:** integers in each currency's smallest unit (table in 5.2), largest-remainder rounding with a fixed tie-break, and unit tests for the sum rules. Why: trust, and JPY has no cents.
7. **Exchange rate per expense:** original amount and currency, rate, rate date and source. Default from Frankfurter v2 by expense date through the Worker with a D1 cache, with a manual override. Why: free multi-currency that can be explained; TWD is verified.
8. **Balances:** suggested transfers (greedy, deterministic) plus a paid, share and net breakdown for each person. Why: the core trip screen, and it answers "why do I owe this".
9. **Settle up:** record a payment with a method label; anyone may record or delete one. Why: closes the loop without moving money.
10. **Safety net:** soft delete, restore, and an append-only activity feed with before and after values. Why: it makes "anyone with the link can edit" safe.
11. **Languages:** zh-TW and English from one glossary, with a check that both files have the same keys. Show the ISO code beside every amount. Why: Splitwise has no Chinese UI.
12. **App shell:** iPhone-first layout with bottom tabs and safe areas, a manifest, a 180 px apple-touch-icon, and hash routes under /<repo>/. Every save is one D1 `batch()`, and there are no passwords. Why: fits GitHub Pages and the 10 ms CPU limit.

**Should (next, or tonight if time allows)**
- **Adjustment split (plus or minus) and refunds on the phone.** Why: two gaps Splitwise never closed.
- **Calculator and comma decimals in the amount field.** Why: 955 votes and 270 votes.
- **Payment handles per member** (Venmo, Zelle, PayPal, LINE Pay, JKoPay, a bank note), shown with copy buttons. Add a pre-filled Venmo link only as a best effort, since its format is undocumented and may change (https://goleary.com/posts/2020-07-29-venmo-deeplinking-including-from-web-apps , 2020-07-29). PayPal.me links with an amount were not verified in this run. Why: gets handles out of display names.
- **Settlement mode "everyone settles with one person".** Why: Gino often fronts lodging and lift tickets.
- **Member weights (a couple counts x2) and a grid of nights that produces shares.** Why: lodging split by shares without manual math.
- **Trip summary** (total, each person's share, paid vs share, by category and by day, payments excluded), plus CSV and JSON export. Why: Splitwise charges for charts and JSON export.
- **One settle-up summary sent through the phone's share sheet.** Why: one message to the LINE or WhatsApp group instead of individual reminders.
- **Duplicate expense, a list grouped by day, and search.** Why: the same lift ticket every day, and search is paid in Splitwise.
- **Archive, star, and hide settled groups.** Why: he has 40 groups.
- **Offline outbox:** IndexedDB, IDs created on the phone, a request key so retries don't save twice, and a "not synced" badge. Never clear it automatically, and offer an export of unsynced entries. Why: poor signal at ski resorts and in Peru.
- **Rotate the group link, and a read-only link.** Why: otherwise a leaked link can't be fixed.
- **Comments on expenses and a notes field per group.** Why: Airbnb codes and payment handles.
- **Splitwise CSV importer**, built after checking one real export, with a step to fix "$" rows that were really yen. Why: brings his 40 groups over, and the terms rule out the API.
- **Recurring expenses from one daily Cron** (anchor day, time zone, end). Why: rent and utilities.
- **Read-only "net with this friend across all groups".** Why: a Splitwise-style dashboard without the cross-group settle-up edge cases.

**Later**
- **Optional sign-in** (a typed email code or a passkey) to sync your group list across devices and enable push. Why: helps with Safari's wipe and new phones, but v1 works without it.
- **Web Push for Home Screen installs**, held 60 seconds and never sent to the person who made the change. Why: it needs an install and a tap to enable.
- **A receipt photo per expense.** Which storage service to use was not researched; keep images out of D1 because of the 2 MB row limit.
- **Itemized split with proportional tax and tip, and claiming items by QR.** Why: Splitwise's newest feature (free in the US and UK) and a heavy UI.
- **Receipt OCR.** Why: needs a paid AI model key.
- **Person-to-person view (simplify off), an "only between people who shared an expense" mode, and cross-group settle-up with balancing entries.** Why: edge cases that Splitwise itself only half solves.
- **Move to a ginochang.com subdomain**, and at that point consider having the Worker serve the app for cookie sessions. Why: it's Gino's plan, and split hosting caps cookies at 7 days.
- **Never:** moving money, or storing full bank account numbers. Splitwise Pay needs a partner bank, approval and an SSN (https://kb.splitwise.com/splitwise-pay/how-do-i-set-up-splitwise-pay), and Splitwise declined to store bank numbers for security reasons (https://feedback.splitwise.com/forums/162446-general/suggestions/4153517-bank-account-details-somewhere-anywhere).

**Suggested data model (derived from the sources above; D1/SQLite)**
```
groups(id, share_key /* random 128-bit, rotatable */, name, emoji, type, base_currency,
       settle_mode /* fewest|hub */, hub_member_id, default_payer_id, default_split_json,
       notes, archived_at, deleted_at, deleted_by, created_at)
members(id, group_id, name, handles_json, weight, claimed_at, joined_at, left_at)
expenses(id /* client UUID = idempotency key */, group_id, kind /* expense|payment */,
         description, category_id, date, orig_amount_minor, orig_currency, rate, rate_date,
         rate_source, amount_minor /* group base currency, may be negative for refunds */,
         split_type, split_inputs_json, notes, created_by, updated_by, created_at, updated_at,
         deleted_at, deleted_by, recurrence_id)
expense_shares(expense_id, member_id, paid_minor, owed_minor, PRIMARY KEY (expense_id, member_id))
activity(id, group_id, actor_member_id, verb /* Splitwise event list 0-15 */, target_id,
         before_json, after_json, created_at)
fx_rates(base, quote, date, rate, source, PRIMARY KEY (base, quote, date))
recurrences(id, group_id, template_json, interval, anchor_day, tz, next_run_at, ends_at,
            end_count, run_count)
```

## Completeness critique

# Completeness critique of the Splitwise research brief (checked 2026-10-16)

All checks used WebFetch only. "Derived" means my own inference, with no source behind it. "(brief x.y)" points back to a section of the report. Each page's date is given as shown on the page; "no date" means the page shows none.

## Top changes to the v1 Must list
1. **Join inside the installed app.** Add a "paste a link or code" join and decide what `start_url` should be. Without these, a friend who adds the app to the Home Screen gets an empty app (b6).
2. **Payments in any currency.** A payment needs a currency, rate and rate date, like an expense. Also define what happens when a group's base currency changes, and what rate to use for future dates or when there is no signal (a4, a5).
3. **Move five Should items to Must:**
   - the settle-up summary sent through the share sheet
   - a free-text "how to pay me" note per member
   - hub settlement ("everyone pays Gino")
   - comma decimals in the amount field
   - a refund or minus toggle (a11, c1, c5)
4. **Member changes after setup.** Add later, rename, merge a duplicate, and mark someone as "not on this part of the trip" (a8).
5. **Two-person presets.** Add "owes the full amount" options, and make the default payer this device's identity (a2, a9).
6. **Money display.** Show ISO codes or use one fixed set of symbols. Never use the browser's language-based symbol (b9).
7. **Edits and double entry.** Add a version number on expenses so a stale edit returns 409, plus a "possible duplicate" warning (a6).
8. **Categories.** Use our own category IDs, plus automatic categories from keywords in both languages (a1, b8).
9. **CORS.** Avoid a preflight request on every call, or serve the app and the API from one Worker (a14).
10. **People across groups.** Add `person_id` to members now (a3).

## (a) Missing, or too vague to implement

**a1. Automatic category from the description (missing).**
- Splitwise picks the category from keywords in the description:
  - Staff, 2014-11-03: "I'll see if we can add "Utilities" to our list of auto-categorization words".
  - Staff, 2016-03-25: "the category detection should now correctly handle utility".
- A user report (2017-03-13) says that editing the description resets the icon "to the one automatically selected by Splitwise based on description". Staff (2017-03-16) said this is intended.
- Build: a zh-TW and English keyword map, applied only until the user picks a category. Never overwrite a category the user chose.
- Sources: https://feedback.splitwise.com/forums/162446-general/suggestions/6631476-add-an-expense-category-utility , https://feedback.splitwise.com/forums/162446-general/suggestions/18599761-bug-report-edit-expense

**a2. Two-person "full amount" options (missing).**
- An iPhone bug report (2015-04-30) names the split options "I owe (person)" and "(person) owes me". Staff said it was fixed (2015-06-23: "This should be fixed now").
- An idea asking for "one button for when one person owes another" is marked completed. Staff wrote (2013-11-12): "We've streamlined this a bit in the new version."
- No KB page lists these options, so today's labels are unverified.
- Needed for groceries bought for only one person, and for cash loans.
- Sources: https://feedback.splitwise.com/forums/162446-general/suggestions/7773291--bug-splitting-the-bill , https://feedback.splitwise.com/forums/162446-general/suggestions/3849011-have-one-button-for-when-one-person-owes-another

**a3. Non-group expenses, and the same person across groups (vague).**
- The KB article "How do I use Splitwise?" (no date) describes non-group expenses for one-off cases, such as dinner with a couple of friends (my paraphrase).
- v1 has groups only, and members exist only inside each group. So the Should item "net with this friend across all groups" cannot be built, and the importer cannot tell that "Amy" in two groups is one person.
- Fix (derived): add a nullable `person_id` now.
- Source: https://kb.splitwise.com/getting-started/how-do-i-use-splitwise

**a4. Payment currency, and changing the base currency (missing).**
- The KB (no date) says payments carry a currency: "When adding or editing an expense or payment, tap the currency symbol next to the amount". It also says "Splitwise keeps balances in each currency separate by default".
- v1 does not say how a TWD bank transfer settles a group whose base is JPY.
- v1 also does not say what happens when a group's base currency changes after expenses exist.
- Fix (derived): payments store the original amount, currency, rate and rate date, like expenses. Then either lock the base currency after the first expense, or re-convert each expense at its own date.
- Source: https://kb.splitwise.com/balances-and-expenses/how-can-i-manage-a-friendship-or-group-with-multiple-currencies

**a5. Exchange-rate edge cases (missing). Checked on Frankfurter v2:**
- **Future dates return nothing.** `https://api.frankfurter.dev/v2/rates?base=USD&quotes=TWD,JPY&date=2026-12-20` returns `[]`. Lodging dated at the stay date gets no rate. Fall back to the latest rate and mark it provisional (derived).
- **Today's rates change during the day.** I re-fetched the brief's exact URL. The rows are still dated 2026-10-16, but the values have moved:

  | Currency | Brief's value | My fetch |
  |---|---|---|
  | JPY | 158.21 | 158.19 |
  | EUR | 0.89272 | 0.89256 |
  | CAD | 1.4203 | 1.4201 |
  | MXN | 18.471 | 18.4764 |
  | TWD | 32.275 | 32.275 |

  frankfurter.dev (no date) says "the last decimal places may shift as new data comes in" and "rates are blended across all providers". So keep freezing the rate on each expense, as the brief says, but give today's row in `fx_rates` an expiry, and record the source as "Frankfurter blend" rather than one bank.
- **Weekends work as the brief says.** 2026-10-11 (a Sunday) returns a row dated 2026-10-11: TWD 31.91, between Friday's 31.907 and Monday's 31.916.
- **No signal means no save.** The offline outbox is only a Should. Minimum for v1 (derived): keep the unsaved form on the device, and allow a typed rate.
- Sources: https://api.frankfurter.dev/v2/rates?base=USD&quotes=TWD,JPY,IDR,CRC,PEN,MXN,EUR,CAD , https://frankfurter.dev/ , https://api.frankfurter.dev/v2/rates?base=USD&quotes=TWD,JPY&date=2026-10-11

**a6. Two people editing at once, and double entry (missing; derived).**
- "Anyone with the link can edit", trips have 10 people, and the later offline outbox replays saves. Together these let the last save silently undo someone else's edit.
- Fix: an `expenses.version` column, with `UPDATE ... WHERE id=? AND version=?`. On a 409, show both versions.
- Also warn when the same amount and date were already entered in the group a few minutes ago.

**a7. How other members' changes appear (missing; derived).** Reloading when the app comes back into view (`visibilitychange`), plus pull-to-refresh, is enough for v1.

**a8. Changing members after setup (vague).**
- v1 says only "members typed in as names".
- The KB groups section (no date) has articles on adding a new person and on fixing someone who was added twice.
- Needed:
  - add a member later
  - rename
  - merge a duplicate (move their shares, then soft-delete the duplicate)
  - an "active" flag, so people who left drop out of new equal splits (the Settle Up idea in brief 3)
- Source: https://kb.splitwise.com/groups

**a9. The default payer rule contradicts itself.**
- v1 item 2 says "the chosen member becomes the default payer". v1 item 3 says "a default payer and split saved per group".
- In the grocery group, the partner's own entries would then default to Gino as payer.
- Rule (derived): use this device's identity first, then the last payer used on this device. Use the group default only when no identity is picked.

**a10. Shares format (vague).**
- The KB (no date) says shares are a number per person, but not whether decimals are allowed.
- Lodging by shares needs values like 1.5 and nights times weight.
- Fix: allow shares with 2 decimals, store them as typed, and round the money with largest remainder.
- Source: https://kb.splitwise.com/balances-and-expenses/what-are-different-ways-i-can-split-an-expense

**a11. Minus sign and comma on iPhone (vague).**
- MDN (last modified 2026-04-17) says `inputmode="decimal"` shows "the digits and decimal separator for the user's locale (typically . or ,)", and that "Devices may or may not show a minus key".
- So refunds and negative adjustments need an explicit toggle.
- Comma parsing is needed from day one, not as a Should.
- Source: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inputmode

**a12. Deleting a whole group (vague).** v1 item 10 covers only expenses. Define who can delete a group, and show a restore banner on the same link for 30 days (Spliit's rule, brief 2.8).

**a13. Backups (vague).** On the D1 free plan, Time Travel keeps "7 days (Free)" (limits page updated 2026-04-21). A JSON export per group in v1 is cheap insurance for a grocery ledger that will run for years. Source: https://developers.cloudflare.com/d1/platform/limits/

**a14. CORS preflight on every call (missing).**
- MDN (2026-09-04): a request skips the preflight only if all of these hold:
  - the method is GET, HEAD or POST
  - only safelisted headers are set
  - the Content-Type is form-urlencoded, multipart/form-data or text/plain
- The brief's "send the key to the Worker in a request header", plus JSON bodies, therefore adds an OPTIONS round trip to every call.
- Each OPTIONS request also counts against the 100,000 requests a day (derived).
- If the server doesn't set Access-Control-Max-Age, the browser keeps the preflight result for "5 seconds" (MDN, 2025-11-21). Chromium caps it at 2 hours; MDN gives no WebKit value.
- Two fixes (derived):
  - put the key in the Worker URL path (GitHub never sees it) and send JSON as `text/plain`, or
  - serve the app and `/api` from one Worker (brief 5.6). This also removes the cookie cap.
- Sources: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS , https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Max-Age

**a15. Several "undocumented" items can simply be tested.** These items from brief 2.10 take a few minutes to test in Gino's own Splitwise account, which the user offered for inspection:
- whether simplify is on by default for new groups
- the adjustment formula (100 among 4 people, Sam +5)
- whether shares accept decimals
- the person-to-person lines on a multi-payer expense

The free plan allows 4 expenses a day. I did not run these tests, because browser tools were off-limits.

## (b) Unsourced, contradictory or outdated claims

**b1. The daily cap number.**
- The KB still says "free users can add up to 4 expenses each day" (no date).
- The official limit article gives no number, no reset time and no counting rule.
- Android Central via Yahoo (2026-04-28): "limited to just five right now".
- Trustpilot confirms a score of 2.0 from "72 reviews". The reviews give these numbers:

  | Number | Review dates |
  |---|---|
  | 2 | 2026-08-27 |
  | "2 or 3" | 2026-05-15 |
  | 3 | 2026-02-26, 2025-03-30, 2023-11-19 |
  | 4 | 2025-07-11, 2025-03-24 |

- The brief's "2 to 5" is right, but it leaves out 3, the most common number. Don't print a number in our own copy.
- Sources: https://kb.splitwise.com/pro/what-is-splitwise-pro , https://feedback.splitwise.com/knowledgebase/articles/2010350-why-am-i-seeing-an-expense-limit , https://tech.yahoo.com/apps/articles/app-splitwise-best-hack-split-191737811.html , https://www.trustpilot.com/review/splitwise.com

**b2. The Pro list.**
- The KB Pro page (no date) lists "Transaction import (select countries only)", not "US only" as the brief says.
- The same page lists "Receipt scanning and itemization" as Pro.
- The split-methods KB lists itemizing as a split method and says only that on mobile "Pro subscribers can itemize by scanning a receipt".
- The press release dated 2026-10-14 makes Itemize "available for free to all Splitwise users in the United States and the United Kingdom". It does not say whether guests join in a browser, so brief 2.10 item 16 stays open.
- Source: https://www.splitwise.com/press/splitwise-launches-new-feature-that-takes-the-awkwardness-out-of-splitting-the-check

**b3. The simplify default is still undocumented.**
- The current KB says nothing about it.
- In the API schema, `simplify_by_default` is a boolean with no default.
- The brief's "default off later" rests on an undated legacy article. Make our own call (derived: on for trips, with hub mode).
- Sources: https://kb.splitwise.com/balances-and-expenses/what-is-simplify-debts , https://raw.githubusercontent.com/splitwise/api-docs/main/schemas/group.yaml

**b4. The adjustment "conflict" depends on how you read one sentence.** The brief quotes the KB exactly. If "the rest" means (total minus adjustments) / n, the KB and the blog agree. Keep the brief's formula and test it once (a15).

**b5. The IP-address cookie cap can now be dated.**
- WebKit pull request #5347, "Cap cookie lifetimes to 7 days for responses from third party IP addresses", was merged 2022-10-21.
- It applies only when the response has no CNAME.
- Two addresses count as the same party only if they share "half the IP address length (i.e. 16 for IPv4, and 64 for IPv6)".
- It also says: "If the two IP addresses are of different families (i.e. v4 and v6), this method returns 0". So a page loaded over IPv6 that calls an API over IPv4 gets capped, even if both are on Cloudflare (derived).
- Simo Ahava (2022-11-14) places the change in Safari Technology Preview 157.
- The Safari 16.4 post (2023-03-27) does not mention it, so the first stable Safari version is still unconfirmed.
- WebKit's tracking-prevention page (no date) describes it as current behavior: it "caps the expiry of any cookies set in the HTTP response to 7 days".
- This supports the brief's point that only one shared origin avoids the cap.
- Sources: https://github.com/WebKit/WebKit/pull/5347 , https://www.simoahava.com/privacy/first-party-cookies-webkit-revisited/ , https://webkit.org/blog/13966/webkit-features-in-safari-16-4/ , https://webkit.org/tracking-prevention/

**b6. "Survives Safari's 7-day wipe" plus "Add to Home Screen" breaks joining.**
- WWDC23 (2023): Home Screen web apps on iOS have "separate cookies and storage from the browser", and "The start_url is the URL that is loaded when the web app is first opened".
- A link tapped in another app opens in Safari, not in the installed app. Source: pwa-install issue #174 (2026-09-08), where the maintainer calls it "a known limitation and sadly probably intentional from Apple". This is a community report, not an Apple statement.
- So the installed app opens without `#/g/<key>`, and later group links never reach it.
- The W3C manifest draft (2026-10-13) says a missing `start_url` defaults to the "document URL". Whether iOS keeps the `#` part in that case is untested.
- v1 needs "join with a link or code" inside the app. Consider leaving `start_url` out of the manifest.
- These sources also back the brief's "(inference)" that any later login must finish inside the installed app.
- Sources: https://developer.apple.com/videos/play/wwdc2023/10120/ , https://github.com/khmyznikov/pwa-install/issues/174 , https://www.w3.org/TR/appmanifest/

**b7. The 40-group home screen (brief 5.4) has nowhere to live.** With no accounts, the group list exists only in one browser or one installed app, and the two are kept apart (b6). A new phone, or moving from a Safari tab to the installed app, loses the list. v1 needs an export and import of "my group links", or a personal key that lists them (derived).

**b8. Category IDs and the API terms.** v1 item 3 reuses "Splitwise's IDs" from `api/v3.0/get_categories`. But brief 1.8 says the terms forbid using Splitwise Materials to build an app that copies Splitwise. Use our own IDs, and map Splitwise's category names from the CSV export (derived; I did not re-fetch the terms).

**b9. Browser currency symbols change meaning with the UI language.**
- CLDR zh-Hant (Traditional Chinese): TWD is "$" and USD is "US$". CLDR en (English): TWD is "NT$" and USD is "$".
- The narrow symbols turn CAD, HKD, MXN, TWD and USD all into "$", in both languages.
- So "$1,000" means TWD in the Chinese UI and USD in the English UI. This is the "yen saved as $" problem again.
- Fix: `currencyDisplay: "code"` or one fixed set of symbols for the whole app. Test in Safari, whose built-in data may lag CLDR 48.
- Sources: https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-numbers-full/main/zh-Hant/currencies.json , https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-numbers-full/main/en/currencies.json

**b10. Smaller corrections.**
- "Rates update daily" (brief 5.1) is incomplete; see a5.
- The Venmo note "As of 7/2/26" is quoted correctly, but it could mean 2 July or 7 February.
- The /pay page ("rolling out ... over the next few months") and the /card page ("currently in the process of launching") are undated launch copy. They are probably stale, and moving money is out of scope anyway.
- Sources: https://kb.splitwise.com/payment-integrations/how-do-i-send-money-via-paypal-or-venmo , https://www.splitwise.com/pay , https://www.splitwise.com/card

**b11. Confirmed, no change needed.**
- CLDR 48 decimals, as the brief has them:

  | Currency | Decimals | Cash |
  |---|---|---|
  | IDR | 0 | |
  | HUF | 0 | rounds to 5 |
  | TWD, CRC | 2 | 0 decimals |
  | IQD | 0 | |
  | SEK, NOK | 2 | 0 decimals |
  | CAD, CHF | 2 | rounds to 5 |
  | DKK | 2 | rounds to 50 |

- Spliit's list has 35 currencies, without TWD, PEN or CRC.
- The App Store language list has no Chinese (version 26.9.2, rated 4.0 from 29K ratings).
- Cron Triggers: "1 = Sunday to 7 = Saturday", run in UTC, changes take up to 15 minutes (page updated 2026-09-04).
- Workers Free: 10 ms of CPU, with "some built-in flexibility"; 100,000 requests a day, resetting at midnight UTC; 50 subrequests (page updated 2026-10-12).
- D1 Free: every limit in the brief matches. For `batch()`, the per-query limits apply to each statement in the batch; how many queries a batch counts as is not stated.
- The KB still says refunds and name-only friends are web-only.
- The KB groups section has 10 articles. None covers archiving, resetting the invite link, a maximum group size or leaving a group, so those stay undocumented.
- Sources: https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-core/supplemental/currencyData.json , https://raw.githubusercontent.com/spliit-app/spliit/main/src/lib/currency.ts , https://apps.apple.com/us/app/splitwise/id458023433 , https://developers.cloudflare.com/workers/configuration/cron-triggers/ , https://developers.cloudflare.com/workers/platform/limits/ , https://kb.splitwise.com/balances-and-expenses/how-do-i-add-a-refund-or-reimbursement , https://kb.splitwise.com/getting-started/can-i-add-a-friend-without-adding-their-email-address-or-phone-number

## (c) Gino's real scenarios that v1 handles badly

**c1. 10-person ski trip, lodging split by shares.**
- People who arrive late or leave early stay in every default split (a8).
- Couples need hand-typed shares on every expense, or one combined member such as "Amy & Bob", because member weights are only a Should.
- The nights grid is a Should, and decimal shares are not specified (a10).
- Deposit refunds need the refund toggle (a11).
- Gino fronts lodging and lift tickets, but hub settlement is only a Should. Meanwhile:
  - the default settlement pairs people who never shared an expense (brief 2.1)
  - it is "re-simplified automatically whenever a new expense or payment is added" (KB), so who-pays-whom changes during the trip

  Make hub settlement a Must toggle.
- With 10 people logging, expect duplicates and edit clashes (a6).
- Two cheap additions (derived): a "claimed" mark on the "Who are you?" list so a wrong pick shows, and "copy members from a previous group" for repeat crews.

**c2. Yen trips.**
- No rate for future dates, and no saving without signal (a5).
- Settling in TWD or USD is not defined (a4).
- Mixed-nationality groups see only the base currency. The SplitPro idea in brief 3 (show balances in another currency without rewriting the expenses) is not in v1; add a read-only display currency per viewer.
- The "$" ambiguity (b9).
- The fix for yen saved as "$" waits on the importer, which is a Should.

**c3. 2-person daily groceries.**
- No "owes the full amount" preset (a2), and the default payer clash (a9).
- "Two taps" needs the installed app to open the last-used group, not `start_url` (b6).
- Splitwise's monthly Totals screen is free (brief 1.6) and v1 has nothing like it. Add a simple "this month: total, you paid, your share".
- Recurring rent and utilities are a Should.
- If their history is a non-group friendship, the importer must read friend exports. The KB (no date) says you "can export expense data by friend or group on web and mobile", but not whether a friend export includes group expenses. Source: https://kb.splitwise.com/account-issues/how-do-i-export-my-splitwise-data

**c4. Bilingual friends.**
- The "$" ambiguity (b9).
- European-locale iPhones show a comma on the decimal keypad (a11).
- Automatic-category keywords are needed in both languages (a1).
- The settle-up summary text should be bilingual (derived).
- A per-group nickname appears in the brief's pain-point table but not in v1. It would help map names like "王小明" to "Ming" when importing.

**c5. Friends who never install anything.**
- v1 can't reach them. There is no email, push is in Later, and the share-sheet summary is only a Should. Make the summary a Must.
- Payment handles are a Should, so the summary can't say where to pay. Add at least a free-text "how to pay me" note per member.
- Open question for Gino (no source): Taiwanese friends may expect to repay by bank transfer to an account number, but the brief says never store full account numbers. Decide what that note may contain.
- LINE's docs (no date) show only `https://example.com/?openExternalBrowser=1` and say nothing about the `#` part of a link. Test on an iPhone that LINE, WhatsApp and Messenger keep `#/g/<key>`.
- A friend who later adds the app to the Home Screen gets an empty app (b6).
- Splitwise's new Itemize (US and UK, 2026-10-14) lets guests join "without downloading the app or signing up". There, "nothing to install" is no longer unique to us.
- Source: https://developers.line.biz/en/docs/line-login/using-line-url-scheme/

**c6. Gino's own 40 groups and 120+ friends.**
- The group list lives on one device (b7).
- There is no way to link the same person across groups (a3).
- He has to type about 10 names for every new trip, with no suggestions from past groups (derived).
- The importer is only a Should, but the data model should already fit it:
  - `person_id`
  - original currency on payments
  - stored split inputs
  - mapping from Splitwise category names
  - payment handles split out of display names

## Not verified in this run
- Whether iOS keeps the `#` part of the URL when `start_url` is missing, and whether messaging apps keep it.
- How long Safari caches a preflight result.
- Splitwise's current labels for the two-person options, the simplify default, the adjustment formula, decimal shares, any group size cap, and invite-link reset.
- Whether Itemize guests use a browser. Digital Trends returned an empty page. A 2018 joyfulfrugalista.com post naming "You owe the full amount" appeared in a search snippet, but the page returned HTTP 500, so I did not use it.
