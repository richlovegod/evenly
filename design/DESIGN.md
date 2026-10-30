# Evenly 分帳: design system (v1, 2026-10-16)

The React app follows this file and `design/tokens.css`. The fixed-up reference screens are in
`design/reference/` (HTML plus PNGs rendered in WebKit, iPhone 14). Where this file and a mockup
disagree, this file wins. Where this file and `docs/SPEC.md` disagree about what the user sees
(words, layout, motion), this file wins; data rules stay in SPEC.md. Section 13.4 lists every
wording change against SPEC.md.

Writing rule for this repo: never type the em dash or en dash characters (a hook rejects them).
Use commas, colons, parentheses or 「」. Ranges in English use "to".

---

## 1. Decision

### 1.1 Winner: 收據 Receipt (overruling a tie)

The judges' totals tied: native 22.5, receipt 22.5, picturebook 20. Receipt is the base because:

1. **It wins two of the three panels head to head.** Money clarity and accessibility: receipt 8.5,
   native 7.5. Identity and robustness: receipt 7.5, native 7. Native wins only entry speed
   (8 against 6.5).
2. **Native's lead is one component, and every panel listed it as a graft.** The 記帳 keypad
   (000, + and minus, a two-row 儲存 key) moves onto the receipt base whole. With it, receipt's
   entry problems go away: the iOS decimal pad, the invisible input, the print animation on the
   add sheet, the currency chip out of reach, the unnamed target group.
3. **Native's main weakness cannot be grafted away.** The judges called it "a well-made iOS
   template". That is the concept itself. Receipt's object system is the product's job made
   visible: the slip holds the one number a screen is for, the stub is your share of a bill, the
   ticket is a group, and the stamp only ever says 已結清.

Picturebook (lowest total) is not the base, but its warmth comes over through the ticket art, the
tinted category tiles, the one-sentence payer and split, and the warm dark mode.

### 1.2 What was grafted

| From | Idea | Where it lives now |
|---|---|---|
| native | Register keypad: 000, + and minus, tall 儲存 key at bottom right, no system keyboard | 9.1, `reference/add.png` |
| native | 新增費用 opens on the last-used group; receipt's save key names it: 「儲存 / 到 Niseko 滑雪 2026」 | 9.4 |
| native + picturebook | Tap a face to leave someone out, with check badges, 50 x 58 targets, `aria-pressed` | 8.13 |
| native | Names next to the totals (on receipt leaders: 「Abbie ······ US$1,192.46」) | 8.4 |
| native + picturebook | Day number once per day; full rule between days, inset rule within a day | 8.5 |
| native | English string table, aria labels that spell out the currency | 13.3, 12.3 |
| native | Running expression line with 「= ¥12,600」 | 9.1, `reference/add-start.png` |
| picturebook | 「Tiffany 欠你 ¥86,400 [結清]」 as one tap target on the group slip | 8.4 |
| picturebook | Payer and split as one sentence: 「由 [你] 付款，[平均分給 6 人]」 | 8.13 |
| picturebook | A drawn cover for each group, printed on its ticket | 6.3 |
| picturebook | Counterparty for a group (meta line 「來自 Tiffany」 / 「付給 Kevin」) | 8.6 |
| picturebook | Warm "night" dark mode | 11 |
| receipt (kept) | Slip, stub, ticket, stamp, ※ footnotes, words carry direction, blue against red | throughout |
| receipt + native | Converted row pattern, 44 px 改匯率 | 8.5, 9.6 |
| receipt | Description autocomplete, 「自動分類：餐廳」, save bar riding on the system keyboard | 9.2, 9.5 |

Every problem the judges raised for receipt, and the cross-cutting ones from the other two, is in
the fix log, section 14.

---

## 2. Concept

**A receipt printer on a café counter.** Reading screens have a graphite printer band at the top.
The number the screen exists for prints out of its slot on a strip of thermal paper with a torn,
serrated edge. Everything else is quiet rows lying on a warm stone counter. On the add sheet the
printer becomes the register you type on: the receipt you are writing rises out of the register's
slot, right above the keys, so the amount and what it means for you sit next to 儲存.

Three small paper objects carry meaning, and nothing else is decorated:

| Object | Means | Rule |
|---|---|---|
| Ticket | A group | Prints the group's cover glyph and its currency code |
| Stub | Your share of one expense | No share, no stub (你沒參與). Not synced yet: still attached, dashed, no perforation |
| Stamp | 已結清 | The only word a stamp ever says |

### 2.1 The memorable element

**The slip.** Thermal numerals (Chivo Mono), a serrated tear edge, ※ footnotes, dotted leaders,
and a stepped line feed (6 steps, 240 ms) when it prints. It prints only when a number on it
changed since you last saw it, never on plain navigation, never on the add sheet (section 10).
Every screen has exactly one slip and it always holds that screen's number:

| Screen | Slip |
|---|---|
| 總覽 | 別人欠你 / 你欠別人, one line per currency, with names |
| Group | 你可以拿回 ¥86,400, who it comes from (one tap to settle), who is settled with you |
| Group, scrolled | A one-line strip that stays: 「你可以拿回 ······ ¥86,400 ›」 |
| Friend | 「Abbie 欠你」 per currency, per group |
| 新增費用 | The receipt you are writing: date, item, amount, 每人, 你借出 |
| Empty screens | A blank slip that asks for the first entry |

### 2.2 Principles

1. **Words carry money; color repeats them.** Every directional amount has a word next to it
   (欠你, 你欠, 你借出, 你借入, 你收到, 你付出, 你可以拿回, 你沒參與, 已結清). No minus signs for
   direction, ever. Blue means money toward you, red means money from you, ink is neutral.
2. **Currencies are never added together.** One line per currency. The footnote says so:
   「※ 各幣別分開計算，不會自動換匯」.
3. **The amount is the most legible thing on every screen.** 56, 40 or 34 px, tabular, plain zero.
4. **Thumb first.** 新增費用 is bottom center on every main screen. On the add sheet, keys, amount,
   description and 儲存 all sit in the lower half.
5. **One primary action per surface.** It is the highest-contrast object there: the graphite key
   on light surfaces, the paper 儲存 key on the graphite register.
6. **Every drawn control is a real control.** If it looks tappable (a check badge, a chip, a
   pill), it is a button with a 44 px target.

---

## 3. Color

All values are custom properties in `tokens.css`. Components use the role tokens
(`--money-pos`, `--money-neg`, `--money-neutral`), never the raw names, so the meaning lives in
one place. No hex values in components.

### 3.1 The six named colors

| Token | Light | Dark | Role |
|---|---|---|---|
| `--paper` 感熱紙 | `#FFFFFF` | `#22201E` | Slips, stubs, tickets, panels, bottom bar, chips |
| `--counter` 櫃台 | `#EAE8E3` | `#161514` | Page background: warm stone the paper lies on |
| `--ink` 墨 | `#1F2328` | `#EDEBE6` | Text, neutral amounts, the printer and register body |
| `--ink-2` 褪色 | `#575E66` | `#A9A49B` | Secondary text, leaders, 你沒參與, the stamp |
| `--carbon` 複寫藍 | `#2247C2` | `#8EA8FF` | Money coming to you: 欠你, 你借出, 你可以拿回 |
| `--red` 收銀紅 | `#B0321B` | `#FF8A73` | Money you owe: 你欠, 你借入; sync failed; danger |

Why: thermal paper is a cool white, so the base is not cream; the counter was warmed (judge 3)
from the cool grey-green `#E9EDEB` to a stone grey, still far from the generic cream tell. Carbon
blue is the duplicate copy of a handwritten 收據 book. Two-color receipt printers print refunds in
red. Blue against red stays apart for red-green color blindness (deuteranopia ΔE 117,
protanopia ΔE 98, judge 2) and avoids the Taiwan stock-screen convention where red means up.

### 3.2 Derived tokens (not new colors)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--printer` | `#1F2328` | `#0C0B0A` | Printer band, register, toast |
| `--printer-key` / `--printer-key-2` | `#2C3137` / `#3A4047` | `#24272B` / `#31353A` | Digit keys / operator and delete keys |
| `--slot` | `#0A0C0E` | `#000000` | The paper slot |
| `--on-printer` / `-2` | `#F2F1EE` / `#AEB4BA` | `#EDEBE6` / `#A3A7AC` | Text on graphite |
| `--on-printer-pos` / `-neg` | `#9DB4FF` / `#FF9A85` | `#8EA8FF` / `#FF8A73` | Money words on graphite (compact band, toast action) |
| `--hair` / `--hair-2` | ink 12% / 24% | ink 10% / 20% | Hairlines, rings |
| `--track` / `--press` | ink 7% / 6% | ink 7% / 6% | Segmented track / press and hover |
| `--leader` | faded at 75% | faded at 70% | Dotted leaders |
| `--key` / `--on-key` / `--key-press` | ink / `#F2F1EE` / `#353A40` | `#EDEBE6` / `#161514` / `#D6D3CC` | Primary key on light surfaces |
| `--key-inv` / `--on-key-inv` / `--on-key-inv-2` | paper / ink / `#575E66` | `#EDEBE6` / `#161514` / `#57534D` | 儲存 on the register |
| `--danger` / `--on-danger` | red / `#FFFFFF` | red / `#161514` | Destructive confirm |
| `--seg-on` | paper | `#34312D` | Selected segment |
| `--scrim` | `rgb(12 13 15 / .45)` | `rgb(0 0 0 / .6)` | Behind sheets and dialogs |
| `--desk` | `#DEDBD4` | `#0C0B0A` | Outside the phone column on 600 to 899 px |
| `--chart-1` / `--chart-2` | `#1F2328` / `#8A929B` | `#E3E6EA` / `#7E8792` | Stats: paid / share (validated ordinal ramp) |

### 3.3 Tints for people, groups and categories

Carbonless copy paper: the stored identity color (`src/shared/colors.ts`) mixed into paper,
`color-mix(in srgb, <color> var(--tint-mix), var(--paper))`, with `--tint-mix` 24% light and 30%
dark. Initials and glyphs on tints are always ink. Tints never carry money meaning. You are the
white original: paper with a 1.5 px ink ring.

Category tiles use the parent group's hue the same way: `--hue-food #D4A017`,
`--hue-transport #2F8F7F`, `--hue-travel #7B6BC9`, `--hue-entertainment #CC5F8A`,
`--hue-home #CF7F3E`, `--hue-utilities #6F7C8A`, `--hue-life #4E9A5D`, `--hue-other #8A8F96`.
Blue and red hues are deliberately absent so a tile never reads as money.

### 3.4 Contrast (WCAG 2, computed)

| Text | On paper | On counter | Notes |
|---|---|---|---|
| Ink | 15.80 | 12.90 | |
| Faded print (also the stamp) | 6.57 | 5.36 | |
| Carbon blue | 7.64 | 6.24 | |
| Register red | 6.33 | 5.17 | White on red (danger fill) 6.33 |
| On printer / -2 | 13.99 / 7.55 on graphite | | |
| On printer pos / neg | 7.83 / 7.68 on graphite | | |
| Digits on keys | 11.78 | | Operator glyphs 9.28 |
| 儲存 group line | 6.57 (light), 6.41 (dark) | | |
| Dark: ink / faded / carbon / red | 13.63 / 6.55 / 7.11 / 7.06 | 15.31 / 7.36 / 7.99 / 7.93 | |

Every text pair is AA or better. Non-text: stubs, tickets and slips separate from the counter by
paper value plus a contact shadow (light) or a 0.5 px light edge (dark).

---

## 4. Typography

### 4.1 Families

| Role | Family | Why |
|---|---|---|
| Money, dates, times, currency codes, keypad, the wordmark | **Chivo Mono** 500, 600, 700 | Thermal numerals. Chosen from 23 monospace faces because its zero is plain (no slash, no dot), so ¥86,400 never reads like Ø. Fixed advance gives tabular columns for free |
| Latin text (names, Whole Foods, Niseko) | **Hanken Grotesk** 400 to 700 | Its x-height and open shapes sit level with PingFang TC, and its ampersand is a plain & (「家用 Gino & Abbie」) |
| Chinese | **System only**: PingFang TC, Heiti TC, Microsoft JhengHei, then Noto Sans TC if installed | Never downloaded, so nothing blocks rendering and user-typed group names never fall back mid-word offline |

Stacks (`--font-text`, `--font-num` in tokens.css) put the Latin family first and the CJK system
fonts after it, so mixed strings take Latin glyphs from Hanken or Chivo and Han glyphs from
PingFang. No CJK web font anywhere (this is the picturebook judge's font-rule problem, avoided).

### 4.2 Font loading

`tokens.css` declares static per-weight woff2 files from fonts.gstatic.com (some WebKit builds
ignore variable-font axes): latin and latin-ext subsets for each weight (latin-ext carries
₩ ₫ ₹ ₱ ₺ ₡), plus a one-glyph Chivo Mono file for ≈ (U+2248). `font-display: swap`. ₪ and ฿
are not in Chivo Mono and fall back to the system font; they are prefixes, so digit columns still
line up. Production details:

- Add `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` to `index.html`.
- `public/sw.js`: cache-first for requests to `fonts.gstatic.com` (they send
  `Access-Control-Allow-Origin: *`), so fonts work offline after the first visit.
- To self-host later: download the same files to `public/fonts/` and swap the URLs. Nothing else
  changes.

### 4.3 Scale

| px | Token | Use |
|---|---|---|
| 11 | `--fs-11` | Weekday under a day number |
| 12 | `--fs-12` | Tab labels, sync chip, bead names, hints (10 px only for the ticket's currency code) |
| 13 | `--fs-13` | Row subtitles, stub labels, footnotes, meta, small links |
| 15 | `--fs-15` | Slip labels, segmented control, section links, secondary buttons, leaders |
| 16 | `--fs-16` | Expense titles, stub amounts, slip leader amounts, chips |
| 17 | `--fs-17` | Body, row titles, list amounts, every text input |
| 20 | `--fs-20` | Converted amount on the add slip, section titles on desktop |
| 24 | `--fs-24` | Keypad digits |
| 34 | `--fs-34` | 總覽 totals (scales with the slip, floor 26) |
| 40 | `--fs-40` | A group's status (floor 30) |
| 56 | `--fs-56` | The amount being entered (fits the slip, floor 32) |

Line height 1.45 for text, 1.3 for one-line rows, about 1.1 for display numerals. Headings 700,
body 400 to 600. Inputs 17 px (never under 16, so iOS never zooms).

### 4.4 Numerals and money typesetting

- Money is Chivo Mono 600, `tabular-nums`, `white-space: nowrap`, `word-spacing: -0.25em` (a mono
  space is 0.6 em and reads as a gap in 「12/20 16:12」 or 「NT$400 ≈ ¥1,900」).
- Commas and points are wrapped in `<span class="sep">` and pulled in by 0.17 em on each side, so
  ¥1,453,365 reads as one number. Digits keep their fixed width.
- The currency prefix comes from `currencies.ts` (US$, ¥, CN¥, NT$, ₩...). Never a bare $. JPY
  and CNY never share a bare ¥. At display sizes (34 and up) the prefix is 0.6 em with a 0.08 em
  gap (`.amt-display .cur`); in rows it is full size.
- Decimals follow `currencies.ts` (JPY, TWD, KRW 0; USD 2).
- Monospace is a deliberate exception to "proportional figures for big numbers": it is the
  thermal-print voice.
- Never apply `font-feature-settings: "halt"` to whole strings (native's squeezed commas). Chinese
  punctuation stays full width.

---

## 5. Space, size, radius, elevation

**Space** (4 px base): 4, 8, 12, 16, 20, 24, 32 (`--sp-1` to `--sp-8`). Gutter 16. Section gap 18
(first) and 10 (between). Slip padding 15 / 18 / 20 (top, sides, bottom incl. 7 px teeth).

**Sizes**: touch target 44 minimum everywhere. Band bar 50. Friend and group rows 60. Expense rows
64. Bottom bar 64 plus safe area. Register keys 46 (44 under 680 px tall, 52 at 760 and up).
Sidebar 248, content max 760, desktop dialog 480.

**Radii** (by object, not one value everywhere):

| Object | Radius |
|---|---|
| Slip | Square where it leaves the slot, serrated 14 x 7 teeth at the torn edge |
| Stub | 2 on the perforated left edge, 8 on the right |
| Ticket | 6, with 4.5 px half-circle notches at mid-height on both sides |
| Stamp | 8 outer, 5 inner ring |
| Category tile | 10 (36 px), 9 (30 px) |
| Avatar | 0.3 x size: 12 (40), 11 (36), 8 (26), 7 (24, 22) |
| Chips, secondary buttons, keys, fields | 12 (small buttons and mini chips 9 to 10) |
| Segmented | 14 track, 11 selected |
| Primary key | 15 |
| Panels | 16 |
| Sheets | 14 (full-height page sheet), 20 (picker sheets), 16 (desktop dialogs) |

**Elevation** (paper casts `filter: drop-shadow` so the shadow follows teeth and notches):

| Level | What | Light | Dark |
|---|---|---|---|
| 0 | Rows and headers on the counter | none | none |
| 1 | Paper lying down: stubs, tickets, coupons, empty slip | `--lift-1` 0.5 px contact | 0.5 px light edge |
| 2 | The slip hanging from a slot | `--lift-2` contact + 10 px soft | light edge + dark soft |
| 3 | Dialogs, popovers | `--lift-3` | light ring |
| Keys | Primary key, register keys | `--shadow-key`, 1 px key edge | light edge |

---

## 6. Iconography

### 6.1 Rules

- Line icons on a 24 grid, stroke 1.8 (1.6 for ticket art, 2.2 to 3 for tiny glyphs), round caps
  and joins, `currentColor`, no fills except dots. Sizes: 24 (icon buttons), 20 (in 36 px
  tiles), 22 (ticket art, add-sheet tile), 16 to 18 (chips, small buttons), 14 (meta glyphs after
  a title), 13 (sync chip).
- An icon is never the only label for an important action. Tabs always show text; 新增費用 has
  text. Icon-only buttons (back, share, more, search) are secondary, 44 px, with `aria-label`.
- The tabs are the exception: the phone tab bar and the desktop sidebar (總覽, 群組, 朋友, 動態
  and 我的) show colored tab art, not line icons (`TabIcon.tsx`; sizes, fade and forced colors in
  design/PICTUREBOOK.md, "Tab art"). `Icon.tsx` keeps its `home`, `groups`, `friends`, `activity`
  and `user` line icons for the other pages (`home` is also the 居家 category).
- The reference sprite is `reference/_src/icons.svg`. `Icon.tsx` should contain the same drawings.

### 6.2 Category icons (`CategoryIcon`)

- One line icon per `icon` name in `src/shared/categories.ts` (about 50: dining, groceries, coffee,
  liquor, food, plane, train, taxi, car, fuel, parking, bicycle, transport, hotel, ticket, ski,
  gift, luggage, movie, music, games, sports, party, rent, mortgage, furniture, electronics,
  supplies, tools, services, pets, home, electricity, water, heat, wifi, trash, cleaning, bill,
  shopping, clothing, medical, education, childcare, insurance, taxes, life, general, payment).
  Drawn in the style above; `dining`, `shopping`, `car`, `hotel`, `payment` and `general` are in
  the sprite as the pattern.
- Tile: 36 x 36, radius 10, fill = the parent hue mixed into paper (3.3), 1 px inset hairline,
  ink icon 20 px. Lists at desktop and stats use 30 px tiles with 17 px icons.
- `payment` is special: no fill, 1.5 px `--hair-2` ring, outlined banknote.
- Unknown icon names: render the category's `emoji` at 18 px with `filter: grayscale(1)` so it
  reads as print. Never a colored emoji next to line icons.

### 6.3 Group ticket art (`GroupAvatar`)

- The ticket prints a cover glyph chosen from the group's `emoji`:

| Emoji | Glyph |
|---|---|
| ⛷ 🏂 🏔 🗻 ⛰ | mountain (`t-mountain`) |
| 🏠 🏡 🏘 🛋 | house (`t-house`) |
| 🏝 🏖 🌊 ⛱ 🐚 | island and sea (`t-island`) |
| 🌲 🌳 ⛺ 🏕 | pine (`t-pine`) |
| ✈️ 🛫 🧳 | plane |
| 🍜 🍣 🍱 🍽 🍲 | bowl |
| ❤️ 💑 💕 | heart |
| 🏙 🌆 🗼 🗽 | city |
| anything else | the emoji itself, 18 px, grayscale |

- Ticket fill = group color mixed into paper; a settled group prints on plain paper in faded ink.
- Group creation: the emoji picker is the cover picker. Guess it from the name (滑雪, ski, 雪 to
  ⛷; 家, home, 房, 室友 to 🏠; 海, 島, beach, 沖繩 to 🏝; 露營, camp to ⛺), always changeable, so a
  ski trip and a beach trip never get the same ticket.

---

## 7. Layout and app shell

### 7.1 Mobile (under 900 px)

```
+--------------------------------------+  printer band: --printer, safe-t + 2 top, 22 bottom
| Evenly 分帳                     (G) |  bar 50 px; slot 8 px tall, 8 px above the band edge
|======================================|
|  [ slip: the screen's number      ]  |  hangs 13 px into the band, 16 px side margins
|  /\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/   |
|  section header             link     |  rows on the counter, hairlines, no cards
|  row                                 |
|  row                                 |
|--------------------------------------|  bottom bar: paper, hairline, 64 + safe-b
|  總覽  群組  [＋ 新增費用]  朋友  動態 |
+--------------------------------------+
```

- **Bottom bar** (`AppShell`): fixed; paper; `0 -1px 0 --hair`; padding 6, bottom 6 + safe-b;
  columns `1fr 1fr minmax(96px, 1.65fr) 1fr 1fr`. Tabs: min-height 52, tab art 30 (6.1), label 12/500
  ink-2; current tab ink 700 with `aria-current="page"`. Center key: 50 tall, margin 0 4,
  radius 15, `--key` fill, 「＋ 新增費用」 15/700 nowrap (English 「＋ Add」), icon 20 stroke 2.4,
  `--shadow-key`, press scale 0.96 and `--key-press`.
- **Current tab follows the section, not the route**: `#/g/*` marks 群組, `#/f/*` marks 朋友.
  (Receipt marked 總覽 on a group page.)
- **新增費用 key**: inside a group route it opens that group's add sheet; elsewhere it opens the
  last-used group's add sheet (the group of the last expense added on this device); with no
  groups yet it opens `AddExpenseChooser`.
- **Account** (我的): the avatar button on the 總覽 band (44 px, `data-testid="home-account"`) and
  the desktop sidebar.
- **Activity badge**: 18 px ink pill with paper text 11/700 at the icon's top right, plus
  sr text 「N 則未讀」.
- Content padding-bottom: `--tabbar-h + safe-b + 24`.
- 600 to 899 px: the phone layout in a centered 480 px column on `--desk`.

### 7.2 Desktop (900 px and wider)

```
+------------------------------------------------------------------------------+
| Evenly 分帳 |  < Niseko 滑雪 2026   [JPY] 6 人              (search) (G)      |  band, full width
|=============|================================================================|  slot over content
| [＋新增費用] |   [ slip: 你可以拿回 ¥86,400 ... ]                             |
| 總覽        |   [ 費用 | 結算 | 統計 | 設定 ]                                |
| 群組        |   2026 年 12 月                                     7 筆       |
|  [t] Niseko |   18  [tile] 燒肉晚餐   你付了        ¥12,600   [你借出 ¥10,500] |
|  [t] 家用   |       [tile] 藥妝       Tiffany 付了  ¥5,793    你沒參與        |
| 朋友        |                                                                |
| 動態        |   content: max 760, centered in the remaining width, 32 padding |
| 我的        |                                                                |
+------------------------------------------------------------------------------+
  sidebar 248
```

- **Band** spans the full width; the wordmark sits over the sidebar; the page title, back and
  actions align with the content column; search (44 icon button, shortcut `/`) and the account
  avatar on the right.
- **Sidebar**: 248 wide, sticky under the band, padding 16. The primary 「＋ 新增費用」 key (block,
  50 tall, shortcut N). Nav items 44 tall: tab art 30 (6.1) + label 15/600, radius 12; current item paper
  fill, ink 700, inset hairline. Under 群組 up to 6 recent groups: 28 x 30 mini ticket (no code),
  name 14/600, status words 12 px in the money color; then 「全部群組」.
- **Content**: max-width 760, centered, 32 side padding. Slips hang from the band as on mobile.
  No bottom bar.
- **Expense list** gains a bill-total column: `40px 36px minmax(0,1fr) max-content var(--stub-w)`,
  the total in 15 px Chivo 500 ink-2. Hover: `--press`, inside the hover media query only.
- **Add expense**: the Sheet becomes a centered dialog, 480 wide, max-height
  `calc(100dvh - 64px)`, radius 16, `--lift-3`, over `--scrim`. The keypad is hidden
  (`pointer: fine`); the amount is a real `<input inputmode="decimal">` (section 9.1). Footer:
  [取消] ghost and 「儲存到 Niseko 滑雪 2026」 primary block. Enter saves, Esc closes,
  Ctrl or Cmd + Enter saves from notes.
- **Pickers** become popovers anchored to their chip: min-width 280, max-height 360, radius 12,
  `--lift-3`, or dialogs when they need a keyboard.

---

## 8. Components

Names match `docs/COMPONENTS.md`. Measurements are CSS px at 390 wide.

### 8.1 Printer band (`PageHeader`)

| Variant | Content |
|---|---|
| 總覽 | Wordmark 「Evenly」 Chivo Mono 700 21 px, tracking -0.03 em, plus 「分帳」 15/600, tracking 0.1 em, `--on-printer-2`; account avatar button right |
| Detail (`back` set) | Back 44; title 17/700 one line with ellipsis; meta 13 px `--on-printer-2` with a currency code box (Chivo 600 11, 1 px light ring, radius 5); right: up to two 44 icon buttons or an `AvatarStack` |
| Top level (`large`) | Title 22/700, left padding 10; actions right |
| Compact (scrolled past the slip) | Bar 48, slot 6 px above the edge; fixed; the slip becomes the one-line strip (8.4) |

- Padding: top `safe-t + 2`, sides 6 (+ safe-l/r), bottom 22. Slot: inset 10 from the sides,
  8 px tall, bottom 8, radius 4, `--slot`, inset shadow. The band sets `--focus` to
  `--on-printer-pos`. Icon buttons press to `rgb(255 255 255 / .12)`.
- `AvatarStack` on the band: 26 px avatars overlapping 7 px with a 2 px ring in the band color,
  each initial nudged 6 px left into the visible part; at most 3, then 「+N」 Chivo 600 12
  `--on-printer-2`; the whole stack is one 44 px button with an aria label that names everyone.
- Long titles ellipsize on one line; the stack never shrinks (stress check:
  「2027 北海道跨年滑雪＋溫泉…」 with 「+7」).
- The offline banner lives inside the band (8.18).

### 8.2 Slip (`Slip`, new)

- Wrapper: `margin: -13px 16px 0`, `filter: var(--lift-2)`, `clip-path: inset(0 -28px -48px -28px)`
  so paper above the slot stays hidden while it feeds.
- Paper: `--paper`, padding 15 18 20, `container-type: inline-size` (amounts size from it),
  serrated bottom via mask: `linear-gradient` top part plus
  `conic-gradient(from -45deg at 50% 100%, #000 90deg, #0000 0) bottom / 14px 7px repeat-x`.
  A 14 px top shade where it leaves the slot.
- Inside: label lines 15/700; dashed rule (1.5 px, 5 on 4 off, `--ink-2` at 55%, margin 10 0);
  leader lines (`display:flex; align-items:baseline; gap:8px`, dots 0.85 px every 6 px in
  `--leader`); footnotes 13 px `--ink-2`, `flex-wrap: wrap`, each span nowrap, the right span
  pushed right (it wraps under on narrow screens instead of breaking mid-phrase).
- Print feed: class `is-printing` runs `feed` in `steps(6)` over 240 ms. See section 10 for when.

### 8.3 Money (`Money`, `MoneyStatus`)

- Markup: `<span class="amt"><span class="cur">¥</span>1<span class="sep">,</span>453<span class="sep">,</span>365</span>`
  with the visual part `aria-hidden` and a sr-only sentence that spells the currency:
  「欠你 1,192.46 美元」, 「你借入 6,338 日圓」 (English: "You borrowed ¥6,338").
- Sizes: `xl` 56 entering, `lg` 40 group status, `md` 34 總覽, row 17, stub 16, leader 16,
  meta 13/500, converted 20.
  - 總覽: `clamp(26px, 10.5cqw, 34px)`; group status: `clamp(30px, 12.4cqw, 40px)`; entering:
    `clamp(32px, calc((100cqw - 90px) / var(--amt-em)), 56px)` where the app sets `--amt-em` to
    the string's width in em: 0.6 per glyph, minus 0.34 per separator, prefix glyphs count 0.36,
    plus 0.13 for the caret. All Chivo glyphs are 0.6 em, so this is exact.
- Tone: `positive` carbon, `negative` red, `neutral` ink. Bills and payments are neutral; only
  balances and your share take a money color.
- `MoneyStatus` vocabulary (the single source; the words changed from SPEC.md are marked *):

| kind | > 0 | < 0 | 0 |
|---|---|---|---|
| groupMine | 你可以拿回 / You get back | 你欠* / You owe | 已結清 / Settled up |
| friend | 欠你 / owes you | 你欠 / you owe | 已結清 / Settled up |
| rowEffect | 你借出 / You lent | 你借入 / You borrowed | 剛好平衡 / Even; not involved: 你沒參與* / Not involved |
| rowEffect, refund (8.25) | 你可以拿回 / You get back | 你要還 / You owe | 剛好平衡 / Even |
| member (third person) | 可拿回 / gets back | 要付 / owes | 已結清 / Settled up |
| payment* | 你收到 / You received | 你付出 / You sent | |
| settledWith* | | | 跟你已結清 / Settled up with you |

- Sign: never next to a word. The `sign="always"` prop is for charts and exports only (U+2212).

### 8.4 Balance summary blocks (slips)

**總覽 tally** (`data-testid="home-totals"`):

```
別人欠你                                 15/700 ink
Abbie ················ US$1,192.46   name 15/500 ink, max 46% width, ellipsis; amount 34 carbon
Tiffany ····················· ¥86,400
- - - - - - - - - - - - - - - - - - - -
你欠別人
Kevin ······················· CN¥320    amount red
※ 各幣別分開計算，不會自動換匯           only with 2+ currencies
※ 1 筆等待同步，已計入   上次同步 12/20 16:12
```

- One line per currency, sorted by rough home-currency value (for ordering only, never shown).
- The name is who it comes from: one person, or 「Tiffany 等 3 人」.
- At most 3 lines per side; more becomes a 44 px text button 「另外 2 種幣別」 that expands.
- Empty side: 「沒有人欠你」 or 「你沒有欠別人」 in 15 px `--ink-2`, no amount.
- Everything settled: the stamp centered on the slip and 「沒有人欠你，你也沒有欠別人」.
- Footnote 2 appears only with pending items. The sync time is the store's `lastSyncAt`, the same
  value on every screen (receipt's Home and group used to disagree). Under a minute: 「剛剛同步」.
- Optional reference total (only with a home currency set and 2+ currencies, footnote style,
  never a big number): 「※ 約合：別人欠你 US$1,736（依今天匯率，只供參考）」.

**Group status** (`data-testid="group-status"`):

```
你可以拿回                        ¥86,400   15/700 label; 40 carbon (or 你欠, red)
- - - - - - - - - - - - - - - - - - - - -
[T] Tiffany 欠你 ········ ¥86,400 [結清 >]  one 44 px button: opens settle up, Tiffany prefilled
Abbie、Kevin 等 4 人 ············ 跟你已結清  value nowrap
※ 含 1 筆等待同步的付款     上次同步 12/20 16:12
```

- Counterparty lines: one per person you settle with under the plan (simplified or not), largest
  first, max 3, then 「另外 N 人」. Avatar 26, name 15/600 ellipsis, leader, amount 16, then the
  「結清」 pill (32 drawn, 1.5 px ink ring, radius 10, 14/700, chevron 16).
- Settled list: up to 3 names, otherwise the first 2 plus 「等 N 人」.
- When the slip scrolls out (IntersectionObserver), the band goes compact and a strip stays:
  fixed under the band, 39 px, padding 5 8 11 16, 12 x 6 teeth, 「你可以拿回」 15/700, leader,
  amount 18, chevron; the whole strip links to 結算 (`reference/group-scrolled.png`).

**Friend slip**: 「Abbie 欠你」 label, one 34 px line per currency, then leaders per group
(「家用 Gino & Abbie ········ US$1,192.46」), then the 結清 line.

### 8.5 Expense row (`data-testid="expense-row"`, `data-state`)

```
grid: 28px | 36px | minmax(0,1fr) | var(--stub-w)      column gap 10, padding 7 16, min-height 64
 18    [tile]  燒肉晚餐                 |▒ 你借出    |   title 16/600 ellipsis
 週五          你付了 ¥12,600           |▒ ¥10,500  |   payer line 13 ink-2
```

- **Day**: Chivo 600 17 over the weekday 11 `--ink-2`, top aligned, only on the first row of a
  day. Rules: a new day gets a full-width `--hair-2` rule; rows within a day get a `--hair` rule
  inset to 100 px.
- **Tile**: `CategoryIcon` 36 (6.2).
- **Main column** is a grid with `grid-template-columns: minmax(0, 1fr)` so long text can shrink.
  Payer line = `[name, ellipsis][verb][amount, never shrinks]`: 「Christop… 付了 ¥38,028」.
  Space between a Latin name and the verb, none after a CJK name (`describe.ts zhJoin`).
- **Stub**: paper, perforated left edge (`radial-gradient(circle at 0 50%, #0000 2.3px, #000 2.8px) 0 0 / 100% 7px repeat-y`),
  radius 2 8 8 2, padding 6 10 6 16, `--lift-1`. Label 13/600 with the subject (你借出, 你借入,
  你收到, 你付出); amount 16/600. Label and amount share the money color.
- **Stub width**, one value for the whole list, computed from the longest stub amount:
  `w = 26 + 16 x (0.6 x glyphs - 0.34 x separators)`, minimum 96 (zh) or 112 (en, fits
  「You borrowed」). Set it as `--stub-w` on the list. If it would pass 40% of the row, step stub
  amounts to 14 px. (¥12,453,365 gives 116; verified.)

| State | Looks like |
|---|---|
| You lent | Stub 「你借出 ¥10,500」 carbon |
| You borrowed | Stub 「你借入 ¥6,338」 red |
| Not involved | No stub. 「你沒參與」 13 `--ink-2`, right aligned |
| Payment to you | Banknote tile (outlined); title 「Leo 付給你」; line 2 the method (現金, LINE Pay); stub 「你收到 ¥236,222」 ink |
| Payment you made | Title 「你付給 Kevin」; stub 「你付出 CN¥320.00」 ink |
| Payment between others | Title 「Abbie 付給 Kevin」, line 2 the amount; 「你沒參與」 |
| Converted | Line 2 keeps the original 「佳穎付了 NT$2,400」; line 3 「≈ ¥11,400，12/16 匯率」 13 `--ink-2`, wraps, never truncates; the stub is in the group currency |
| Pending sync | Stub still attached: transparent, 1.5 px dashed `--ink-2` outline, no perforation, no shadow; status chip 「⏱ 等待同步」 (20 tall, radius 6, 1 px `--hair-2`, 12/600). Expenses: the chip gets its own line under the payer line. Payments: it follows the short method line |
| Sync failed | Same, outline and chip in red: 「⚠ 同步失敗」. Tap opens the detail with 重試 and 放棄 |
| Deleted | Hidden until 「顯示已刪除的費用」. Then day, tile and text at 55%, title and payer struck through, trail = 「已刪除」 13 over a small secondary 「復原」 button (undo icon) |
| Recurring, comments | 14 px repeat and comment glyphs after the title, each with an aria label (「每月重複」, 「2 則留言」) |

- Press: `--press` background, 110 ms. The whole row is the link. Its aria label is one sentence:
  「12 月 18 日，燒肉晚餐，你付了 12,600 日圓，你借出 10,500 日圓」.
- List end: 13 px `--ink-2` 「12 月的 7 筆都在這裡了」 and a ghost 「顯示已刪除的費用」
  (`data-testid="show-deleted"`).

### 8.6 Friend and group rows (`ListRow`)

- Row: flex, gap 12, min-height 60, padding 8 16; leading 40 avatar or ticket; main column title
  17/600 and subtitle 13 `--ink-2`, both ellipsis; trailing balance: word 13/600 over amount
  17/600, right aligned, never shrinks. Inset hairline from 68 px. Press `--press`.
- Friend row subtitle: the group the balance comes from (「家用 Gino & Abbie」, or 「3 個群組」).
- Group row subtitle: member count and the counterparty: 「6 人，來自 Tiffany」, 「4 人，付給 Kevin」;
  trailing: 「你可以拿回 ¥86,400」, 「Abbie 欠你」 for a two-person group, 「你欠 CN¥320」; settled:
  the stamp instead of the balance.
- 總覽 order: slip, then 群組, then 朋友 (groups first so every trip's status shows above the
  fold at 390 x 664; the slip already names the people).

### 8.7 Avatar (`Avatar`, `AvatarStack`)

- Rounded square (radius 0.3 x size). Sizes 40 (rows), 36 (add-sheet faces), 26 (stacks, slip
  lines), 24 (chips), 22 (inline).
- Initials: the first character for CJK names (佳), the first letters of up to two words for Latin
  names (AW, KL; a one-word group name like Abbie gives A). Weight 600, about 0.42 x size, ink.
- Fill: member color mixed into paper (3.3); 1 px inset `--hair-2` ring. You: paper with a
  1.5 px ink ring, your own initial; where a name would show, the label is 「你」.
- Photos, when they exist, fill the square and keep the ring.

### 8.8 Ticket (`GroupAvatar`)

44 x 46, radius 6, notches 4.5 px at mid-height on both sides (mask), fill = group color mixed
into paper, glyph 22 at stroke 1.6, currency code Chivo 600 10 under it, `--lift-1`. Settled:
paper and `--ink-2`. Mini ticket 28 x 30 without the code (sidebar, pickers, the add-sheet group
button uses the glyph alone at 16).

### 8.9 Stamp (已結清)

Inline grid, min-height 34, padding 0 11 0 12, 2 px solid border, inner 1 px ring inset 3 px
(radius 5, 80%), 15/700, tracking 0.08 em, `--stamp` (faded ink, 6.57:1). Level, solid, no noise
texture (receipt's rotated, noise-masked 14 px stamp failed legibility). It replaces a balance
and appears only for 已結清. It lands once with motion (section 10).

### 8.10 Section headers (`Section`)

- List section: h2 17/700, right link 15 `--ink-2` with a 44 px hit area
  (「建立群組」, 「全部朋友」); margin-top 18 (first) and 10.
- Month header in expense lists: sticky (`top: 0`, or under the compact band and strip), counter
  background, padding 14 16 5, 15/700, count on the right 13/500 `--ink-2` (「7 筆」).

### 8.11 Segmented control and tabs (`Segmented`, `Tabs`)

Track `--track`, padding 3, radius 14, gap 2, margin 14 16 0. Each segment is the full 44 px
target (receipt's were already 44; native's 38 px segments are not repeated), radius 11,
15/600 `--ink-2`. Selected: `--seg-on`, ink, `--shadow-seg`. Group tabs are links with
`aria-current="page"`: 費用 / 結算 / 統計 / 設定 (Expenses / Balances / Stats / Settings).
Transitions 160 ms on background and color only.

### 8.12 Buttons (`Button`, `IconButton`)

| Variant | Size | Look |
|---|---|---|
| primary `lg` | 50 tall, padding 0 20, radius 15 | `--key` fill, `--on-key` 16/700, `--shadow-key`; press `--key-press` |
| primary `md` | 44 tall, radius 12 | same, 15/700 |
| secondary | 44 tall, padding 0 16, radius 12 | transparent, 1 px inset `--hair-2`, ink 15/600; press `--press` |
| ghost | 44 tall, padding 0 10 | `--ink-2` 15/600, no ring |
| danger | 44 tall | `--danger` fill, `--on-danger` 15/700 (final confirm only) |
| danger quiet | 44 tall | 1 px inset red ring, red text (the button that opens the confirm) |
| `sm` | 36 drawn, 44 hit (pseudo element), radius 10 | 14/600; used inside coupons and rows |
| IconButton | 44 x 44, radius 12, icon 24 | `aria-label` required |

- One primary per surface. Press on `:active` (pointer down): scale 0.97 within 110 ms ease-out.
  Disabled: 40% opacity, no press. Loading: the label stays, a 16 px spinner replaces the icon,
  `aria-busy`.
- The register's 儲存 is the inverted primary: paper on graphite (9.1).

### 8.13 Chips (`Chip`) and the who-row

- **Payer and split chips** live in one sentence: 「由 [G 你 ▾] 付款，[平均分給 6 人 ▾]」 (English:
  "Paid by [you ▾], [split equally, 6 people ▾]"). Chip: 40 drawn with a 44 hit area, padding 0 8
  0 10, radius 12, paper fill, 1 px inset `--hair-2`, 16/600 ink, avatar 24, chevron 16 `--ink-2`.
  The row wraps (gap 6) for long names and English.
- **Faces** (tap to leave someone out; `data-testid="split-check-<memberId>"`): each a button,
  50 x 58, avatar 36 (radius 11), name 12 `--ink-2` under it, check badge 18 px ink circle with a
  counter-colored check, 2 px counter ring, at the avatar's bottom right. `aria-pressed`.
  Excluded: transparent avatar with a 1.5 px dashed `--ink-2` outline, no badge. You first.
  More than fit: horizontal scroll with snap. At least one person stays included (shake plus
  toast 「至少要有一個人分這筆」). With an unequal split method, tapping a face opens the split
  editor on that person. Hint 「點頭像可排除沒參與的人」 (12 px, centered) the first 3 times.
- **Currency chip**: 44, radius 12, 1.5 px inset ink ring, Chivo 600 15 「JPY ▾」. Foreign currency:
  ink fill, paper text, so a non-group currency is never missed.
- **Recent descriptions**: 32 drawn, 44 hit, radius 10, counter fill, 15/500, horizontal scroller
  with an edge fade.
- **Toggle chips** (filters): selected = ink fill, paper text, `aria-pressed`.
- **Balance chip** (friend header, settle sheet, search): 32 drawn, 44 hit, radius 10, paper,
  `--hair-2` ring, avatar 24, word and amount 15/600 in the money color; settled:
  「✓ 跟你已結清」 in `--ink-2` with a check icon.

### 8.14 Inputs (`TextField`, form rows, `Switch`)

- **Text field**: label 13/600 `--ink-2` above, gap 6; input 48 tall, radius 12, paper,
  1 px inset `--hair-2`, padding 0 14, 17 px. Focus: 2 px inset carbon. Error: 2 px inset red and
  a 13 px red line with a warning icon that says how to fix it (「密碼至少要 8 個字」). Hint 13
  `--ink-2`.
- **Form panel rows** (settings, group setup): paper panel radius 16 with a hairline; rows 54 tall,
  padding 0 12 0 16; key 15 `--ink-2` (76 px); value 17/600 right aligned; chevron 18. Focus or
  active editing: a 3 px carbon bar on the left edge.
- **Select**: a form row or chip that opens a picker sheet (mobile) or popover (desktop). No native
  `<select>` on touch.
- **Switch**: 51 x 31, track `--track` with a ring; on = ink; knob 27 paper with a soft shadow,
  160 ms; `role="switch"`, `aria-checked`.
- **Big amount input**: section 9.1.

### 8.15 Sheets and dialogs (`Sheet`, `Dialog`)

- **Page sheet** (新增費用, edit, settle up): top margin `safe-t + 11`, top radius 14, counter
  surface, grabber 36 x 5 `--hair-2` at 6 px; the parent page peeks as a 22 px dimmed strip; the
  area behind is `#121417` (dark: black). Header 52: 取消 left (17/500), centered title 17/700 with
  a second line. Body scrolls with `overscroll-behavior: contain`. Footer or register pinned.
- **Picker sheet** (payer, split, currency, category, date, notes, repeat): auto height up to
  `100dvh - safe-t - 40`, top radius 20, counter surface with paper panels, header 52 (取消 left,
  title center, 完成 right when it confirms), sticky footer padded by safe-b.
- Both: `--scrim`, rise 280 ms `--ease-sheet`, drag down from the grabber or header to dismiss
  (past 30% or 500 px/s; `touch-action: none` on the grabber zone only), Escape closes, focus moves
  in and returns, body scroll locked, `data-testid="sheet"` and `sheet-close`.
- **Confirm dialog**: centered, max 320, radius 16, paper, `--lift-3`; title 17/700, message 15
  `--ink-2`; two 44 buttons; a destructive confirm uses danger.

### 8.16 Toast (`Toaster`)

`--printer` strip, radius 14, min-height 48, padding 6 6 6 16, 15 px `--on-printer`; icon 20
(`--on-printer-2`, errors `--on-printer-neg`); action button 36 tall, 15/700 `--on-printer-pos`.
Fixed: bottom `tabbar-h + safe-b + 12`, sides 16, max 420 centered. 5 s with an action, 3 s
without; one at a time; swipe down to dismiss; `role="status"` (errors `role="alert"`).
The toast repeats the button's verb: 儲存 then 「已儲存「燒肉晚餐」 [復原]」.

### 8.17 Empty states (`EmptyState`)

A blank slip lying on the counter: paper with teeth, `--lift-1`, padding 22 20 30, centered;
icon 32 (stroke 1.5, `--ink-2`), title 17/700, body 15 `--ink-2` max 30 ch, then the screen's one
primary button.

| Where | Title | Body | Action |
|---|---|---|---|
| Group, no expenses | 還沒有費用 | 記下第一筆，誰該付誰會自動算好。 | ＋ 新增費用 |
| 總覽, no groups | 還沒有群組 | 建立一個群組，邀朋友一起記帳。 | 建立群組 |
| Friends | 還沒有朋友 | 傳邀請連結給朋友，或用名字新增，就能直接跟他記帳。 | 邀請朋友 (and 新增朋友, secondary, beside it) |
| Activity | 還沒有動態 | 有人新增或修改費用時，會出現在這裡。 | none |
| Search | 找不到「{q}」 | 換個關鍵字，或清除搜尋。 | 清除搜尋 |

### 8.18 Offline banner (`OfflineBanner`)

A status note inside the printer band, under the bar, like the machine's status light: min-height
34, margin 0 4 4, padding 0 10, radius 10, `rgb(255 255 255 / .07)`, 13 px `--on-printer`, icon 16.
The band grows; nothing jumps under the slip.

| State | Note |
|---|---|
| Offline | (cloud-off) 離線中，新增的費用會在連線後自動同步 |
| Syncing | (sync, rotating only while a request is in flight) 同步中（2 筆） |
| Failed | (warning, `--on-printer-neg`) 1 筆同步失敗 ... 查看 (underlined 700, opens the group) |

### 8.19 Settle-up transfer row (`data-testid="transfer-row"`)

A coupon you tear off. Paper, radius 4 4 12 12, perforated top edge (2.2 px holes every 8 px),
`--lift-1`, padding 16 14 14, margin 8 16.

```
[T] Tiffany  >  [G] 你                          ¥86,400   names 16/600; amount 20 in money color
- - - - - - - - - - - - - - - - - - - - - - - - - - - - -
你的收款方式（Tiffany 會看到）                           13 ink-2
Venmo  @gino-chang                            [複製]     44 rows; handle Chivo 500 15
LINE Pay  條碼                                 [顯示]     QR opens a sheet
[ 提醒 Tiffany ]                    [ 記錄還款 ]          secondary + primary, 44, equal width
```

- You pay: the payee's methods (「Kevin 的收款方式」), one block 「記錄還款」 primary.
- Between others: names and amount in `--ink-2`, one secondary 「記錄還款」.
- 記錄還款 opens settle up prefilled (from, to, amount); saving tears the coupon off (section 10)
  and writes the payment row. When a balance reaches zero, the stamp lands.
- 提醒 uses the Web Share API with a one-line summary (fallback: copy plus toast).
- `data-testid="transfer-settle"` on 記錄還款. Venmo and PayPal.me deep links per SPEC.md.

### 8.20 Stats (統計)

- Form first: total spent is a figure, not a chart: 「這趟總花費」 13 `--ink-2` over the amount at
  34 (display), with 「你的份」 20 on the right. Payments never count as spending.
- **By category**: one series, so no legend. Rows 44 tall: tile 30, label 14/600, a bar 12 px
  thick in `--chart-1`, square at the baseline, 4 px rounded end, min 4 px; the value at the tip
  side in text tokens (amount 14 Chivo, percent 12 `--ink-2`), never in the bar color. Sorted by
  amount.
- **Paid and share per person**: two series on one scale, legend above (「付了」 `--chart-1`,
  「分到」 `--chart-2`, 10 px swatches), bars 10 px, 2 px gap between a person's bars, values in
  13 px `--ink-2`.
- **By day** (trips): columns at most 24 px wide, 4 px rounded tops, one hairline baseline, day
  labels 11 px; the selected or current day in `--chart-1`, others `--chart-2`.
- Panels: paper, radius 16, hairline. Hover and tap show a tooltip with the exact amount; every
  chart has a table view (screen readers, export). The two chart colors pass the dataviz ordinal
  checks on paper in both modes (light end 3.15:1 light, 4.46:1 dark).

### 8.21 Welcome, 登入 and the email code (2026-10-25)

Every new account has an email confirmed with a 6-digit code (SPEC section 3), so these screens
ask for an email first and never for a password. Picture-book look (design/PICTUREBOOK.md): the
form sits on the yolk card (`.aform` on 開始使用, a yellow `Slip` on 登入), fields are award fields,
the one primary button is the yolk pill.

```
 [ sky picture: mascot, balance, hill      中文 | English ]
              吉諾分帳所
   出去玩、一起住的花費，記一筆就算好誰該付誰
 [ yolk card ----------------------------------------- ]
 [  你的名字  [名字或暱稱                     ]          ]
 [  朋友會在群組裡看到這個名字，之後可以改               ]
 [  Email    [name@example.com              ]          ]
 [  換手機或換瀏覽器時，用這個 Email 收驗證碼登入        ]
 [  (          寄驗證碼          )  yolk, lg, block      ]
 [  只會寄登入用的驗證碼給你，不會寄廣告  13, centered   ]
 [ --------------------------------------------------- ]
          已有帳號？登入      用其他裝置的登入碼
```

- **使用 Apple 登入 and 使用 Google 帳戶登入** (`SignInButtons`; Google 2026-10-25, Apple
  2026-10-29; SPEC section 3, Google and Apple) come first in the card of 開始使用 and 登入, and on
  the friend invite page, where they can work (the site offers them, cookie mode, not inside LINE,
  Facebook, Instagram or another app's web view, where the in-app hint stands instead). Apple's
  first, at the same size as Google's (App Review's rule for the iPhone app, kept here too):
  ```
   [ ([apple file] 使用 Apple 登入 )      black, white words, pill, 50 tall, block ]
   [ ( [G]  使用 Google 帳戶登入 )  white, 1 px gray, pill, 50 tall, block ]
   [ - - - - - - - - - -  或  - - - - - - - - - -   13 --ink-2, pencil dashes ]
   [  你的名字 ... (the email form as below)                                 ]
  ```
  Apple's black button as its Human Interface Guidelines draw a custom one (2026-10-30): black
  fill, no outline; Apple's own logo file, "Left-aligned, White, Medium" from Apple Design
  Resources (the white logo on its 31 x 44 black box, drawn as it is in `SignInButtons.tsx`), as
  tall as the button (50 px, about 35 wide), nothing cropped and no padding added above or below
  it; then the words, white, in the system font (SF on Apple devices), weight 500, at 43% of the
  button's height (21.5 px; Google's are 16, and Apple's may be no smaller; in English on a button
  under 280 px wide, a 320 px phone, 38% so Sign in with Apple stays on one line), right after the
  file, whose own padding is the space between them; the pair centered. Our pill and 50 px; press
  to 0.96 only, never another color, since the logo file's black box must match the fill (so no
  hover color either); the `--apple-*` tokens are used by nothing else, and under forced colors it
  keeps a ButtonText outline. Words: 使用 Apple 登入 / Sign in with Apple. Google's:
  its light button by its branding guidelines, not ours: white fill, a 1 px #747775
  outline, words #1F1F1F 16 px in Roboto where the device has it (Huninn otherwise; weight 500),
  the standard four-color G at 20 px, never recolored, 12 px from the words, the pair centered.
  Only its shape and size are ours: the pill radius and the 50 px of the yolk key under it, full
  width, press to 0.96 with `--google-press` (#F2F2F2), hover `--google-hover` (#F8F9FA). The
  colors are the `--google-*` tokens (tokens.css), used by nothing else. Words: 使用 Google
  帳戶登入 / Sign in with Google. Each is a link (a page load to Apple or Google and back), so
  neither has a spinner; offline a tap shows a toast and stays. A sign-in that came back to 登入
  shows its reason above the buttons as the usual error line (the reasons: SPEC section 3; words in
  `appleSignIn.ts` and `googleSignIn.ts`). Coming back signed in: 歡迎回來，{name}, as after a code.
  A new account that Apple gave a Hide My Email address gets one dialog instead: 「這是新的帳號」,
  「你在 Apple 選了隱藏 Email，所以找不到你原本的帳號，就建立了一個新的。已經有帳號的話：登出，用原本
  的方式登入，再到「我的 › 登入方式」連結 Apple。」, with 知道了 (yolk) and 我已經有帳號 (opens 我的).
  A sign-in that took an unconfirmed email over (an email code, Apple or Google; `notice` claimed,
  SPEC section 3, An unconfirmed email) adds one dialog on the page it opens: 「已確認你的 Email」,
  「為了安全，這個帳號原本的密碼已經清除，其他裝置也已登出。你可以到「我的 › 登入方式」重新設定密碼。」,
  with 知道了 (yolk) and 設定密碼 (opens 我的).
- **The code step** (`CodeStep`) replaces the form inside the same card: 「驗證碼已寄到 {email}」
  15 px (the address wraps anywhere), 「沒收到的話，看看垃圾郵件匣」 13 `--ink-2`, then one award
  field labeled 「6 位數驗證碼」 with the digits in `--font-num` at 30 px, spaced 0.3 em (the
  8-character code's field from 用登入碼登入), `inputmode="numeric"`, `autocomplete="one-time-code"`
  (iOS offers the code from Mail), `pattern="[0-9]{6}"`. Six digits are checked at once, no tap
  needed; 確認 (yolk, lg, block) is there for people who tap. Under it 重新寄送 (secondary sm with
  the sync icon, disabled with 「（52 秒）」 for the first 60 s) and 換一個 Email (ghost sm), then
  「※ 驗證碼 10 分鐘內有效」. On staging only, a 13 px line 「測試模式：驗證碼是 123456」.
- A wrong or expired code: the field turns coral, empties (so the next six digits go by
  themselves), and the error line says 「驗證碼不對或已經過期，請再輸入一次，或重新寄送。」
- An email that has an account signs in to it: toast 「歡迎回來，{name}」. The typed name is used
  only for a new account.
- **登入**: Email (`autocomplete="email"`) and 寄驗證碼, the line
  「我們會寄 6 位數驗證碼到這個 Email，不用密碼」, and a ghost block 「用密碼登入」 (key icon) that
  swaps the card to today's email and password form, whose ghost 「忘記密碼？用驗證碼登入」 (mail
  icon) swaps back with the email kept. An email without an account: the code step adds
  「這個 Email 還沒有帳號，輸入名字就會建立一個」 and a 你的名字 field, and 確認 becomes 建立帳號.
  Links under the card: 用其他裝置的登入碼, 還沒有帳號？用 Email 開始.
- **Joining signed out**: 加入群組 (or 接受，加入群組) opens a picker sheet 「用 Email 加入」 with
  the same two steps; the account takes the picked name. The footer line says 「會先寄驗證碼到你的
  Email，換手機也找得回這個帳號」.
- **我的 and 總覽**: an account without a confirmed email gets the yolk protect card (lock badge for
  no email, mail badge for 確認你的 Email) with the address step and then the code step in it; 總覽's
  card links there. With a confirmed email, 登入方式 shows 「目前用 {email} 登入：在新的裝置輸入這個
  Email，就會收到驗證碼。」 (a Hide My Email address adds 「這是 Apple「隱藏我的電子郵件」的地址：寄到這裡的
  信，Apple 會轉到你的信箱。」), 更換 Email (secondary, edit icon) that opens the same two steps, a
  dashed rule, then Apple and Google: the line 「也可以用 Apple 或 Google 登入這個帳號，用的 Email 不一樣
  也沒關係。」 and a row each (the maker's logo at 20 px and its name, 15 px; on the right 已連結 in
  14 `--ink-2`, or 連結 as a secondary sm button that goes to Apple or Google and back, or 未連結
  where it cannot work here; no unlink in v1), another dashed rule, and the optional password.
  Coming back from 連結 (2026-10-30), nothing is linked yet: 我的 asks first, a dialog
  「把 Google 帳戶 m.lin@gmail.com 連結到這個帳號？」 (Apple's 「把 Apple 帳號 {email} 連結到這個帳號？」, or
  「把 Apple 帳號（隱藏的 Email）連結到這個帳號？」 for a relay address or none), 「連結後，也能用 Google 登入這個
  帳號。」, with 取消 and 連結 (yolk). 連結: the toast 已連結 Apple，之後也可以用 Apple 登入。 (or Google's;
  「已連結 Apple。之前用它建立的空帳號已經刪除。」 when it came off an empty account, 6 s), or the reason
  (這個 Apple 帳號已經連結到另一個帳號了 and the like); 取消, Escape or leaving the page: nothing, and
  nothing is linked; a link that is gone: 「連結的時間過了，請再試一次。」. An account with Apple or
  Google linked and no email gets no protect card and no 加上 Email; one with an email nobody
  confirmed still gets 確認你的 Email (and 總覽's card), linked or not.
- Errors (`emailCode.ts`): 驗證碼不對或已經過期; 驗證信寄太多次了，請 {n} 分鐘後再試; 輸入錯太多次了;
  今天的驗證信已經寄完了，請明天再試，或用其他裝置的登入碼; 現在寄不出驗證信，請稍後再試; 請輸入你的名字;
  這個 Email 已經有別的帳號在用了.

### 8.22 邀請朋友 and the friend invite page (2026-10-25)

One personal link per account (SPEC section 4, Friend invite link). Opening it and signing in
makes the two friends with a 1:1 ledger; the inviter picks a ready-made message to send with it.

**邀請朋友** (`#/invite-friends`, in the shell under 朋友, so the tab bar stays; back goes to 朋友).
Entry points: a share-icon button in the 朋友 band beside 新增朋友, a secondary 邀請朋友 beside
新增朋友 under the list, the primary button of the empty state (新增朋友 secondary beside it), and a
row on 我的 (a sky share tile, 「傳你的連結給朋友，打開登入就是朋友了」).

```
 [ ( < )  邀請朋友                                              ]
 [ yolk card --------------------------------------------------- ]
 [  [ yolk strip: Gino 的朋友邀請 ][ sky stub, dashed tear    ] ]
 [  [ 傳這個連結給朋友，或讓他們掃 QR code ][   QR code 112   ] ]
 [  [ 打開後登入，你們就是朋友了   13 --ink-2 ][               ] ]
 [  [ https://split.ginochang.com/i/<code>?openExternalBrowser=1 ] dashed code box ]
 [ ------------------------------------------------------------- ]
   邀請文案                                     (Section, 18)
   ( 日常 )( 旅行 )( 室友 )                    chips, the picked one yolk
 [ 要傳的話                                                      ]
 [ 我最近都用吉諾分帳所記分帳，誰付了多少、誰欠誰一目了然。…      ]  textarea, 5 rows
   分享時，連結會接在文案的下一行               hint 13
 [ (            分享            )  yolk, lg, block, share icon ]
 [ (   複製文案   ) (   複製連結   )  secondary, two equal keys ]
   重設連結                                      quiet, underlined 13
```

- The pass is the group invite's (`InviteCard.tsx` `InvitePass`, PICTUREBOOK.md): the same yolk
  card, strip, notches, sky stub and dashed link box, so a friend invite reads as the same kind of
  ticket. The strip names whose invite it is.
- The chips switch the box to that message's words (an edit goes with it); the pick is remembered
  on the device, the edit is not. The box is a `TextField` (multiline, 1,000 characters, the count
  showing from 800). 分享 is the one yolk key: on a phone the share sheet with the text, then the
  link on its own line (`shareMessage`); on a laptop it copies the same with 已複製. 複製文案 copies
  that message (toast 已複製文案和連結), 複製連結 the link alone (已複製邀請連結).
- 重設連結 asks first, danger style: 「重設邀請連結？」 「舊的連結和 QR code 會立刻失效，還沒加入的人要用
  新的連結。已經是朋友的人不受影響。」, 重設連結 / 取消; then 「已重設邀請連結，舊的連結已經失效」.
  Offline it is disabled, as the group's reset is.
- Keyboard (9.5): nothing focuses the text box from script, a chip never focuses it, and the
  app-wide focus release lets go of it when Chrome for iOS's own keyboard button takes the page's
  focus, so the tab bar is never stranded over a kept keyboard inset (tests/e2e/keyboard-viewport.cjs
  K13).

**The friend invite page** (`#/i/<code>`, full screen like #/join, works signed out; the link
`https://<site>/i/<code>` lands here). The top bar is the wordmark (and 回到總覽 ✕ when signed in).

```
 [ sky card ------------------------------------------------- ]
 [  ( G )   朋友邀請                       13 --ink-2         ]
 [  64 px   Gino 邀請你一起分帳            20, up to 3 lines  ]
 [ - - - - - - - - - - - - - - - - - - - - - - - - - - - - -  ]
 [  ※ 加為朋友後，你們會有一本兩個人的帳本：一起記帳，算好誰該付誰。 ]
 [ ---------------------------------------------------------- ]
   已有帳號？登入                                          ( > )
 [ paper bar, ink rule ---------------------------------------- ]
 [ ( [G] 使用 Google 帳戶登入 )   where Google works          ]
 [ - - - - - - - - - -  或  - - - - - - - - - -               ]
 [ (           加為朋友           )  yolk, lg, block          ]
   會先寄驗證碼到你的 Email，換手機也找得回這個帳號   13 --ink-2
```

- The face is the inviter's avatar: their photo when they have one (shown to anyone holding the
  link), else the initial on their color.
- Signed out, 加為朋友 opens 用 Email 加入 (8.21). An address with no account gets the name step
  in the code step: 「這個 Email 還沒有帳號，輸入名字就會建立一個」, 你的名字 (hint 「朋友會看到這個名字，
  之後可以改」), and 確認 becomes 建立帳號. Then the page accepts by itself and opens the new ledger.
  Coming back from Google or 登入, it accepts by itself too.
- Signed in: no Google, no link row; the bar's fine line is 「會用「{name}」這個帳號加入」. One tap,
  then the ledger with the toast 「你和 Gino 現在是朋友了」.
- Already friends: 「你和 Gino 已經是朋友了」, the note 「你們的兩人帳本已經在了，打開就能一起記帳。」, and
  the yolk 打開你們的帳本.
- My own link: no kicker, 「這是你自己的邀請連結」, the note 「把它傳給朋友：他們打開、登入後，你們就是
  朋友了。」, and the yolk 邀請朋友 (share icon) to that screen.
- A link that does not work (reset, or never made): a paper card 「這個邀請連結已經失效」 「邀請你的朋友
  可能已經重設了連結，請向對方要一個新的。」 and one link row (回到總覽, or 用 Email 開始使用吉諾分帳所).
- The link's preview in LINE, Messenger or iMessage (the Worker writes it into the page, SPEC
  section 6, Friend invites): the title 「Gino 邀請你一起用吉諾分帳所分帳」, the line 「打開連結加入，你們就
  是朋友了：一起記帳，算好誰該付誰，不用下載 App。」, and `public/og-image.png`: the welcome
  picture at 1200 x 630, the coral robot standing on a grass hill (`--green`) under a sky
  (`--water-t`) with two paper clouds, 9 px ink lines, the robot centered so a square crop keeps it.
  Every other page of the app shares that image with the app's name and its one-line description.

### 8.23 封存群組 (2026-10-26)

Per person (SPEC section 4, Archive): the group leaves my 總覽 and 群組 list, its money stays.

- **群組**: the last fold, under 已結清的群組, is the same outlined pill with the archive icon (a box
  with its lid) and 「已封存（N）」 / "Archived (N)" (`groups-show-archived`). Open, it shows a 13 px
  `--ink-2` line 「只有你看不到這些群組，金額照樣算在總覽裡；別人新增費用時，群組會自己回來。」, then
  each group's usual row (cover, name, people, my balance in the money color) and, under it on the
  right, a secondary sm 取消封存 (restore icon, `group-unarchive`). Offline the buttons are
  disabled and a line says why.
- **設定**: a 你的列表 card (paper) with one row in the data rows' shape: the archive icon in its
  sky tile, 封存群組 over 「從你的總覽和群組列表收起來，別人不會看到變化，結餘照樣算」; archived, the
  restore icon, 取消封存 over 「這個群組已封存：放回你的總覽和群組列表」 (`settings-archive`,
  `data-archived`). Not for 1:1 ledgers.
- **Asking first** when my balance there is not zero: 「確定要封存嗎？」 「你在這個群組還有 ¥22,500
  沒結清（你欠）。封存只會把它從你的總覽和群組列表收起來，結餘照樣算在總覽裡；別人新增費用時，它會自己
  回來。」 (（你可以拿回） the other way), 封存 / 先不要. The amount names its direction in words, as
  every amount does (2.2). Then, or at once for a settled group, the toast 「已封存「北海道」，在群組頁最下面」
  with 復原.
- **總覽**: archived groups are not listed under 群組; when every group is archived the section's
  note says so and links to 群組. The hero, 朋友 and 動態 are unchanged.

### 8.24 群組預設分法 (2026-10-26)

One per group (SPEC section 4, Default split).

- **設定**: a 預設分法 section with one paper card row in the data rows' shape: the people icon in
  its sky tile, the default in words (「比例：你 60%、Abbie 40%」, ellipsis on one line) over who pays
  (「新增的人付款」 / 「Abbie 付款」), a chevron, and a ghost sm 清除 beside it, a button of its own
  (`settings-default-split`, `settings-default-split-clear`). None set: 沒有設定 over 「新費用平均分給
  全部的人；點這裡設定一個，群組裡每個人都會用」. A 13 px `--ink-2` note under the row when a member
  is new to it or it no longer adds up.
- **The sheet** is the split sheet (8.13) titled 預設分法, with only 平均 / 比例 / 份數, the total line
  replaced by 「新費用都會從這個分法開始，群組裡每個人都一樣；每一筆還是可以再改。」, no per-person
  amounts, then 誰付款 as sm chips (新增的人, then each member, the picked one yolk), and 儲存 as the
  footer key (disabled while the split does not add up or offline, which a line under the total
  says).
- **In the editor's split sheet**: under the split, a sky card with a 24 px checkbox (as the 平均
  rows') and 「設為這個群組的預設分法」, and a 13 px line under it: what 完成 will do once ticked, or
  why it cannot be ticked (「金額、加減和品項只用在這一筆，不能設成預設」, 「這個分法還不完整，完成了才能設成
  預設」, 「連線後才能設定預設分法」); checked and disabled with 「這就是這個群組的預設分法」 when it
  is. On 完成 with it ticked: the toast 「已設為這個群組的預設分法」.
- **A new expense** shows, among the editor's notes (info icon, 13 px), 「新成員不在預設分法裡：Lily」
  or 「預設分法的比例加起來不是 100%（有人離開了），這筆先平均分」 while its split is still the one it
  started from (`editor-default-note`).

### 8.25 退款 (2026-10-26)

Money coming back (SPEC section 2, Refunds), always said in words, as every amount is (2.2).

- **The editor**: where the title was, 費用 / 退款 as two sm segmented pills sized to their words,
  drawn 36 px tall like 取消 with 44 px targets, so the header keeps its height (`editor-kind`;
  the title stays as the heading for screen readers; payments keep their visible title). For a
  refund the who-row reads 「退款給 [你]，[平均分給 4 人]」 / "Refunded to [you], [split equally, 4
  people]", the payer sheet is 誰收到退款 (多人收到, 輸入每個人收到多少), my line is 你可以拿回 (grass) or
  你要還 (coral) over the amount, the 2-person chips are 我收到，平分 / 我收到，全是對方的 / 對方收到，平分 /
  對方收到，全是我的, and 重複 and 掃描 are not offered.
- **The effect words**: 你可以拿回 / "You get back" above zero and 你要還 / "You owe" below
  (MoneyStatus rowEffect with `refund`), not 你借出 / 你借入: when money comes back nobody lent or
  borrowed anything, and the receiver holds the others' money. The same words in rows, on the
  detail page, in the feed and in notifications.
- **Rows**: a 退款 tag before the title (12/700 on a sky tint, 2 px ink outline, pill, never
  shrunk; a tag, not a money color), 「Gino 收到退款 ¥30,000」 / "Gino got back ¥30,000" as the payer
  line (「2 人收到退款」 for several), and the effect stub on the right.
- **Detail**: the same tag before the title, 退款金額 as the amount's label, 收到退款的人 as the payers'
  section, and under the actions a paper row 「退的是 民宿押金 ¥30,000 >」 to the expense it refunds.
  An expense has 記一筆退款 (undo icon) among its actions and, once refunded, a 退款（N 筆） section of
  the same rows, each to its refund.

### 8.26 結算圖卡 (2026-10-26)

The group's summary as one picture (SPEC section 8.3), drawn to match the iPhone app's card
(`evenly-ios` Views/Settle/SettleCardView.swift): 1080 x 1350 px, sizes in pixels.

- **The scene**: the sky tint (`--water-t`) ground, a 112 px paper cloud high in the middle when
  the room above the header holds it (72 px or more), a 150 px one behind the mascot's head, and
  the grass hill (`--green`, 180 px, the app's Hill curve) along the bottom with its ink edge
  (6 px), where 「吉諾分帳所  split.ginochang.com」 sits in Huninn 28.
- **The header**: the group's emoji on a 112 px tile tinted from the group color (34 px radius, 4 px
  ink), the name in Huninn 56 (shrinks to 60 %, then …) over the days in 32 `--ink-2`
  (「2026/10/9～10/11」, "Oct 9 to Oct 11, 2026"), clear of the mascot.
- **Cards**: 52 px margins, 44 px radius, 6 px ink outlines. The summary on yolk tint: 這趟總花費 /
  總花費 (Huninn 32 `--ink-2`) over the total (M PLUS Rounded 1c 800, 84, shrinking to half), a
  dashed pencil line, and 花在哪裡 with the top 3 categories (a 40 px circle with the emoji on the
  category's tint, the name 28, the amount 30). 誰付了多少 and 怎麼結清 on paper: a 36 px title,
  rows split by the dashed pencil rule, each person an initial in a circle in their color (48 px,
  less as rows get short) and the name in 32; 付了 / 分到 columns that line up; payments 「A → B
  ¥7,500」 with the amount in 34. Folds in `--ink-2` 30. Settled: a sky pill with a seal and
  大家都結清了！ in 44 (the one exclamation mark against 13.1, kept from the contract: the card is
  for the whole group to celebrate, and both apps print the same words).
- **The mascot** (components/Mascot) stands on the summary card's top edge, 40 px in from its
  right, 176 px tall when there is room.
- Rows are 72, 62, 54 or 45 px as the lists get longer, so 8 lines of people and 6 of payments fit
  above the hill without smaller text; the room left over goes evenly above the header, between
  the cards and above the hill.
- **The sheet**: 結算圖卡 with 關閉; the PNG at the sheet's width in a 3 px ink frame (tile radius),
  a 13 px note that it shows only what everyone in the group can see, and 下載 + 分享 (yolk) in the
  footer, or 下載圖片 alone where files cannot be shared. While it is drawn, a spinner in the card's
  own shape. On 結算, 分享結算圖卡 (image icon) is a ghost sm button beside 分享結算.

---

## 9. The add-expense flow

Reference: `reference/add.png` (JPY), `add-fx.png` (TWD into a JPY group), `add-start.png`
(just opened: recents, an expression, one person left out).

```
 取消            新增費用                       header 52
             [^] Niseko 滑雪 2026 v             group button 14/600 ink, 44 hit
 由 [G 你 v] 付款，[平均分給 6 人 v]            who-row (8.13)
 (G)v (A)v (K)v (T)v (L)v (佳)v                faces, tap to leave out
        點頭像可排除沒參與的人
 /\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/   the slip, torn top edge, rising from the slot
 [12/18 今天 v]              [備註] [重複]      receipt header: mini chips 28 drawn, 44 hit
 [tile] 燒肉晚餐                自動分類：餐廳   item line 44: category button 40, input 17/600
 - - - - - - - - - - - - - - - - - - - - - -
 [JPY v]                          ¥12,600|     amount, right aligned like a receipt total
 每人 ······························ ¥2,100
 你借出 ···························· ¥10,500   the result, right above the keys
=============== slot ========================
 [ 1 ] [ 2 ] [ 3 ] [ del ]                      register: --printer, keys 46 tall, gap 6
 [ 4 ] [ 5 ] [ 6 ] [  +  ]                      columns 1fr 1fr 1fr 1.22fr
 [ 7 ] [ 8 ] [ 9 ] [ 儲存 ]                     儲存 spans two rows: 「儲存」 18/700 and
 [000] [ 0 ] [ - ] [ 到 Niseko 滑雪 2026 ]       「到 Niseko 滑雪 2026」 11/600, two-line clamp
```

The common path is four touches: 新增費用, digits, a recent description (or type one), 儲存.
Payer, split and date default to you, everyone and today.

### 9.1 Amount and keypad (`AmountInput` + new `AmountKeypad`)

- **Touch (`pointer: coarse`)**: the register keypad is the input. No element is focused when the
  sheet opens, so no system keyboard and no iOS focus rule can delay the first digit. The amount
  display shows a drawn caret (3 px x 0.72 em, ink, blinking `steps(1)` 1.1 s) after the last
  digit; editing is append-only, like a calculator.
- **Keys**: register body `--printer`, padding 5 8 (8 + safe-b); digits `--printer-key`, Chivo 500
  24 `--on-printer`, radius 12, 1 px key edge; operator and delete keys `--printer-key-2` with
  22 to 26 px glyphs (they are keycaps, not bare glyphs). Layout above: delete top right (away
  from 儲存), + under it, minus bottom right of the digits. The bottom-left key is 000 for
  zero-decimal currencies and 「.」 for others. Long-press delete clears.
- **Expression**: when an operator is typed, a 15 px Chivo 500 `--ink-2` line above the amount
  shows 「8,400 + 4,200」 with the caret, taking the place of the dashed rule, and the big line
  shows 「= ¥12,600」 (「=」 at 0.5 em, `--ink-2`). 儲存 evaluates the expression and drops a
  trailing operator (「12,600 −」 saves 12,600). Results of zero or less: shake and 「金額要大於 0」.
- **Limits**: 12 digits per operand, decimals per currency, leading zeros trimmed, 000 ignored on
  an empty amount, comma or point both accepted as the decimal key on desktop.
- **Accessibility**: the keypad is a `role="group"` labeled 「輸入金額」, keys are buttons with
  labels (「三個零」, 「刪除」, 「加」, 「減」); the amount display has an aria label that spells the
  value and currency (「金額 12,600 日圓」) and is a polite live region. Paste: long-press the
  amount for 「貼上」 (clipboard read; non-numbers are rejected with a toast).
- **Desktop and mouse (`pointer: fine`)**: no keypad. The amount is a real
  `<input inputmode="decimal" autocomplete="off">` in the same type, focused on open, formatted
  with separators on blur; Enter saves. This keeps the `AmountInput` contract (expression shows
  「= result」).
- Size: `clamp(32px, calc((100cqw - 90px) / var(--amt-em)), 56px)` (8.3).

### 9.2 Description, category, recents

- The item line sits on the slip: category button (40 tile, the auto-picked or chosen category,
  `data-testid="editor-category"`), the description input (17/600, `enterkeyhint="done"`), and on
  the right 「自動分類：餐廳」 13 `--ink-2` (or 「分類：其他交通」 when chosen by hand). Both open
  the category picker. `detectCategory` runs as you type unless a category was picked by hand.
- Empty description: the input narrows to 52 px with the placeholder 「說明」 and the line shows
  up to 5 recent descriptions from this group (most used and most recent), 3 visible, scrolling.
  Tapping one fills the description and its category.
- Typing: the same chips become autocomplete matches (prefix first, then contains).
- The description is optional for the person: if it is empty on save, the app sends the
  category's name (「餐廳」, or 「一般」), so the server rule (an expense needs a description)
  still holds.

### 9.3 Paid by, split, date, notes, repeat

- Paid by: `MemberPicker`; the last option is 多人付款 (multiple payers with amounts).
- Split: the split editor (平均 / 金額 / 比例 / 份數 / 加減 / 品項) with a live per-person preview;
  two-person groups also get the four presets from SPEC.md.
- The faces mirror the split: checked faces are in an equal split; for other methods each face
  shows its share under the name (12 px Chivo).
- Date chip 「12/18 今天」 opens 今天 / 昨天 / calendar. 備註 and 重複 are small chips on the
  receipt header; a set value shows in the chip (「每月」).

### 9.3a Receipt photos (附收據, 2026-10-25; up to three, 2026-10-30)

Photos of the receipt kept with the entry, up to three, for a long receipt taken in parts or a bill
and its card slip (docs/SPEC.md section 8.7), in the picture-book look (design/PICTUREBOOK.md):

```
 [▢ 10/25 今天] [▤ 備註] [⟲ 重複] [▧ 附收據]          the option pills; 附收據 is the fourth
 [(▧ 收據)(×)]                                        one photo: one yolk-tint pill, 2 px outline
 [(▧ 收據  3)]                                        two or three: the count where × was
```

- **No photo**: 附收據 / Attach receipt is an option pill like 備註 (receipt icon 19, 15 px), and
  opens the device's picker (the camera, or the library with several at once). While a photo is
  shrunk, the icon is a 16 px spinner. Picked files go in in the picker's order up to three; more
  get 「一筆最多三張，多選的 1 張沒有加進來」, the same picture twice 「這張已經加過了」.
- **One photo** (picked here, or the photo a 掃描 just read): the pill turns yolk tint
  (`--yellow-t`, as a set option) and holds a 30 px thumbnail (2 px ink outline, radius 10,
  cropped to fill) with 「收據」, and a round × (16 px glyph). The thumbnail opens the 收據照片
  sheet (「收據照片，點一下查看或加一張」); × takes the photo off the form (a saved one comes off on
  儲存). Each part is a 44 px target; press and hover fill `--yellow`.
- **Two or three**: the same pill with the first photo's thumbnail, 收據, and the count in
  `--font-num` 700 where the × was, 28 px wide, so the pill keeps the one-photo width (112 px in
  zh-TW) and three photos lay out exactly as one: at 390 x 664 the receipt pill takes the options
  row's second line, as 附收據 always has, and nothing wraps further. No ×: a tap opens the sheet
  (「3 張收據照片，點一下查看」).
- **The 收據照片 sheet** (size auto, 收據照片, 完成 on the right): the photos in a row in their order,
  each 140 px tall and at most a third of the row, in its own shape (cropped to fill), 3 px ink
  outline, radius 14; with two or more, a 22 px yolk badge at the top left with its number; a
  round 28 px × at the top right (44 px target). While there are fewer than three, a dashed 2 px
  pencil tile of the same height, ＋ 加一張. A tap on a photo opens the viewer, whose 關閉 comes back
  here. Under the row, 13 px ink-2: 「收據太長的話，可以分成最多三張，從上面拍到下面。群組的人都看得到這些
  照片。」. While adding, the footer is a yolk block button: 掃描這張 / 2 張一起掃描 / 3 張一起掃描;
  right after a scan of this exact list 已掃描 (aria-disabled); while reading 讀取中 with the spinner,
  and a tap stops it.
- **掃描 in the header** (adding only): with no photo it opens the picker, adds what was picked and
  reads them all at once; with photos not yet scanned as they are, one tap reads them all
  (「掃描這 3 張收據照片」); with this exact list scanned, it opens the sheet with 「這些照片已經掃描
  過了，加一張或移除一張就可以重新掃描」. Any change to the list stops a running scan.
- **Editing**: the entry's photos show the same way, from their versioned addresses (a photo still
  in the outbox from its data URL).
- The first scan on a device says 「照片會附在這筆費用上，群組的人看得到；掃描會一起讀這筆的所有照片（最多
  三張）。不想留的話，點「收據」移除」. After a scan of two or three: 「已從 3 張收據照片填入…」, and when
  fewer than three were read and no total was found, 「收據太長的話，可以加一張有總額的照片，再掃描一次」.

On **費用明細**, a 收據 section comes right after the action row. **One photo**: the photo in its own
shape (aspect-ratio from its width and height, so nothing jumps), 168 px tall, a 3 px ink frame at
radius 16, cropped to fill; beside it 移除收據 (danger quiet, sm, trash icon) and, for a photo still
in the outbox, one 13 px sky-ink line (coral ink when it failed): 「收據照片等待上傳」, 「離線中，收據照片會
在連線後上傳」, 「今天的收據照片上傳額度用完了，明天會自動上傳」, 「收據照片的空間滿了，這張存不下」, 「這筆已經有
三張收據照片了，這張沒有存」. **Two or three**: titled 收據（3 張）, tiles 128 px tall in their own shape
with number badges, 8 px apart (a coral frame for one whose upload failed); under them a 13 px
line per photo still in the outbox, 「第 2 張：收據照片等待上傳」 (coral with 重試 / 放棄 once it
failed), then 「點照片可以放大或移除」. A tap opens the **viewer**: a full-height sheet titled 收據
(收據 2/3 for more) with 關閉 (yolk, right) instead of 取消, one photo per page, each as wide as the
sheet in the same frame, in a horizontal scroll-snap pager; with two or three, round 38 px ‹ and ›
(2 px ink outline, paper) over the edges at the middle of what shows, hidden at the ends, and ← →
on a keyboard. A photo that does not load says 「打不開收據照片」 「它可能已被換掉或移除。」 in a dashed
box instead of spinning. The footer: 移除收據 (one photo) or 移除這張 (danger quiet, block). Pinch
zoom is the browser's. Removing asks first: 「移除這張收據照片？」 「群組裡的人都不會再看到它，移除後不能
復原。」 [移除] (danger). Expense rows with photos (stored or still queued) show a 14 px receipt glyph
after the title, like the comment glyph, said as 「有收據照片」 or 「有 3 張收據照片」.

### 9.4 Which group, and what 儲存 says

- Inside a group: that group. From 總覽, 朋友 or 動態: the last-used group on this device. The
  header button (glyph 16, name 14/600 ink, chevron, 44 hit area) changes it.
- 儲存 always names the group on its second line, so a wrong group is caught at the moment of
  saving. Desktop: 「儲存到 Niseko 滑雪 2026」 on the footer button.
- After saving: the sheet drops, the toast says 「已儲存「燒肉晚餐」」 with 復原 (undo = delete),
  and the group's slip prints the new number.

### 9.5 When the system keyboard is up (description, notes)

- Hide the keypad while someone types: a text field has focus and the page itself has focus
  (`document.hasFocus()`, and the page is visible); with a mouse, focus alone. A save bar rides on
  top of the keyboard, positioned from `visualViewport`
  (`bottom = innerHeight - (vv.height + vv.offsetTop)`, read in `requestAnimationFrame` after each
  viewport, window resize, focus or visibility event, and never higher than `innerHeight - 56`):
  56 tall, paper with a 3 px ink top rule, 「完成」 on the left (back to the keypad) and
  「儲存到 Niseko 滑雪 2026」 primary on the right. The sheet body scrolls so the item line stays
  just above it.
- The keyboard can leave without a blur. Chrome for iOS's own keyboard button (it falls back to
  `endEditing:YES`), its address bar and tab grid, and an app switch take focus away from the page
  but leave the field as `document.activeElement`, with no `focusout`. So typing also follows the
  page's focus (window blur and focus, `visibilitychange`, `pageshow`, and a check every second
  while a field is focused), and on touch screens the field is blurred once the page has lost
  focus: the keypad comes back at once, and nothing is focused again when the page returns. A
  browser whose `document.hasFocus()` never says true (a guard for in-app browsers) falls back to
  focus alone, and nothing is blurred there. A
  keyboard that goes down while the field keeps focus (Android Back) keeps typing on, so the save
  bar drops to the bottom of the screen (`lib/viewport.ts` `watchTyping`).
- Every other page lets go of such a field the same way (`installFocusRelease`, started once by
  main.tsx on every platform). Left focused, WebKit focuses it again at the next tap on the page,
  with no keyboard, so it reads as typing: the root scroll guard below leaves the page past its end
  and sheets follow the stale visual viewport (the expense detail page's 留言 after Chrome's own
  keyboard button: the tab bar mid-screen on the last row over a keyboard-sized blank band, as in
  IMG_6978; 邀請朋友's message box is the same case, 8.22). On a touch screen (`pointer: fine` false, read at each check), at a window blur, a
  `visibilitychange` to hidden, or a check every second while a keyboard field is focused that
  finds `document.hasFocus()` false, the field is blurred one task later if the page is still
  unfocused; its text stays. With a mouse, and where `hasFocus()` never says true, nothing is
  blurred. Fields in the add sheet are left to `watchTyping`, so they get one blur and one check.
- Our own code never focuses a keyboard field from script on a touch screen (`pointer: fine`
  false, read at the call; `lib/viewport.ts` `focusFromScript`, which returns whether it
  focused). iOS raises the keyboard only for a focus inside the tap's own handler; a focus from an
  effect, a timer, an await or a route change leaves the field focused with no keyboard, the same
  stranded tab bar as above. So on a touch screen:
  - a sheet or dialog that opens focuses its container, not its `initialFocus`, `[autofocus]` or
    `[data-autofocus]` field (Dialog's prompt input, as in 用邀請連結加入; CurrencyPicker's
    search; the 備註 textarea), and one that closes never focuses a field again: a field in a
    sheet still open under it gives focus to that sheet, and otherwise focus stays where it is
    (`Sheet.tsx` `useOverlay`, `focusLayerOpen` and `focusLayerReturn`);
  - fields that focus themselves as a page, sheet or step appears (`TextField` and `AmountInput`
    `autoFocus`, the code fields of CodeStep and LinkPage: 登入, 新增朋友, 建立群組, 用 Email 加入,
    更換 Email, the 刪除帳號 password, the name under 我不在名單上) use `lib/autoFocus.ts` `useAutoFocus`
    instead of React's autoFocus and stay unfocused; if focus was lost with the step before, the
    sheet or dialog around them takes it;
  - the split sheet opened from a face only scrolls that person's field into view, a closing
    toast hands focus to `#main` instead of a field, and the copy fallback does not focus a field
    again.

  A tap on the field then focuses it and raises the keyboard. With a mouse every one of these
  focuses the field as before. A focus inside the tap's or key's own handler stays a plain
  `focus()`, since iOS raises the keyboard for it: 改匯率 (rendered with `flushSync`, then
  focused in its click), 加入 and Return moving on to the next field, 儲存 pointing at the rate, a
  form's submit pointing at a bad field, a tap beside the amount's digits, and Tab inside a sheet.
- The tab bar moves down by `visualViewport.offsetTop` (`--vv-shift` on the bar), but only while
  the visual viewport is 120 px or more short of the window. It then sits behind a real keyboard,
  as in native apps, and on the bottom of the screen when the web view keeps a keyboard inset
  after the keyboard left: WebKit then holds the layout viewport, which `position: fixed` follows,
  above the screen's bottom. While the visual viewport is less than 120 px short of the window,
  no `offsetTop` moves it (iOS 26.0 reported `offsetTop` 24 with no keyboard) (`startFixedShift`).
- Root scroll guard (`installRootScrollGuard`, started by main.tsx on iOS only): with such a
  leftover inset the page can come to rest scrolled past its end, over a blank band. 350 ms after
  the page stops moving, with no finger down, at scale 1, no sheet open and nobody typing, the
  part past the end is scrolled back (`evenly:vvguard` on window), and the tab bar takes its new
  place in the same frame instead of a frame or two later, when WebKit reports the new visual
  viewport. Only a keyboard's space lets a page rest past its end, so a page by itself never sets
  the guard off. Off iOS a browser's own keyboard over a page nobody types in looks the same
  (Android Chrome's find in page), and the guard would scroll the match out of sight, so it is
  not installed there.
- Sheets and dialogs (`Sheet.tsx` `useViewportBox`) follow the visual viewport only while someone
  types (a keyboard field with real focus) or the page is zoomed. Otherwise they cover the screen:
  the layout viewport, moved down by `visualViewport.offsetTop` and as tall as the window while the
  visual viewport is 120 px or more short (as the tab bar), so a leftover inset neither floats them
  above an empty band nor cuts off their top.
- `interactive-widget` is deliberately not set (index.html). WebKit trunk now reads it, and
  `resizes-content` would resize every 100dvh root (the shell, the add sheet) and every fixed bar
  with the keyboard. Add it only after testing on an iPhone.
- To read these numbers on a phone: `?debug=vv` before the `#`, or five taps on the version line on
  我的 (`components/ViewportDebug.tsx`). 複製 copies the live numbers and the last 60 focus and
  viewport events as JSON.

### 9.6 Foreign currency

- When the currency differs from the group's, the chip fills ink and the slip adds a two-column
  block under the amount: left 「以 JPY 記入群組」 over 「1 TWD = 4.75 JPY，12/16 匯率」 (13 px);
  right 「≈ ¥11,400」 (20 px ink) over 「改匯率」 (13/700 underlined, 44 hit area,
  `data-testid="fx-rate"`).
- The rate comes from `/api/fx` for the expense date; changing the date re-fetches it. A
  hand-edited rate carries forward for this group until reset. Offline: the last cached rate, and
  the line says so: 「1 TWD = 4.75 JPY，12/15 匯率（離線）」.
- Results: 「每人 NT$400 ≈ ¥1,900」 and 「你借入 ¥1,900」 in the group currency.

### 9.7 Short screens

The slip lives in the scrolling sheet body, docked to the bottom with `margin-top: auto`; the
register is pinned; the slot lip is `position: sticky; bottom: 0`, so on short screens (iPhone
SE in Safari is about 375 x 548) the body scrolls and the paper slides under the lip. The sheet
opens scrolled to the bottom (amount and result visible); scroll up for payer and faces. Keys go
to 44 px under 680 px tall.

---

## 10. Motion

Only where it says something. All of it is off under `prefers-reduced-motion` (values swap in
place).

| What | When | How |
|---|---|---|
| Slip print (the memorable element) | A number on this slip changed since you last saw it (after a save, a sync, a payment), and once on first launch | `feed`: translateY(-100%) to 0 in `steps(6)` over 240 ms; only that slip moves. Never on plain navigation or back, never on the add sheet. Keep a per-slip hash of its numbers in sessionStorage |
| Press | Every control | `:active` on pointer down, 110 ms ease-out, scale 0.96 to 0.98 or the press tint |
| Sheet | Open, close | Rise 280 ms `cubic-bezier(.32,.72,0,1)`; follows the finger on drag-down |
| New row | After 儲存, back on the list | Slides in 8 px from the right and fades in, 160 ms |
| Coupon tear | 記錄還款 saved | The coupon moves up 6 px and fades, 200 ms, then the payment row appears |
| Stamp | A balance reaches zero by your action | Once: scale 1.25 to 1, rotate -6 to 0 deg, opacity 0 to 1, 180 ms ease-out; it rests level |
| Caret | Amount entry | Blink, `steps(1)`, 1.1 s |
| Sync icon | Only while a request is in flight | One turn per 1.2 s; waiting stays still |
| Compact band and strip | Scrolled past the slip | Cross-fade 160 ms |

---

## 11. Dark mode: the night counter

- The same structure with swapped tokens (3.1, 3.2): warm charcoal counter `#161514`, dark carbon
  paper `#22201E`, chalk ink `#EDEBE6`, lighter carbon and red at 7 to 8:1.
- The printer goes darker than the counter (`#0C0B0A`) so the slot still reads. Shadows become a
  0.5 px light edge. Tints mix at 30%. Primary keys invert to light keys with dark text; the
  register's 儲存 stays the lightest object.
- Follows `prefers-color-scheme`. An in-app choice (我的 → 外觀: 跟隨系統 / 淺色 / 深色) sets
  `<html data-theme>` and rewrites `<meta name="theme-color">` from JavaScript.
- `theme-color`: light `#1F2328`, dark `#0C0B0A` (the band continues into the status bar); on the
  add sheet `#121417` / `#000000`. Manifest: `theme_color #1F2328`, `background_color #EAE8E3`.
- Renders: `reference/home-dark.png`, `group-dark.png`, `add-dark.png`.

---

## 12. Platform and accessibility

### 12.1 Mobile-native floor (in tokens.css and the shell)

- Viewport `width=device-width, initial-scale=1, viewport-fit=cover`, with no
  `interactive-widget` (9.5). Never `user-scalable=no`.
- `apple-mobile-web-app-status-bar-style: black-translucent`: in standalone mode the band paints
  under the status bar and pads by `safe-t`.
- `html`: tap highlight off, `text-size-adjust: 100%`, `overscroll-behavior: none`; inner scrollers
  `overscroll-behavior: contain`. App shell and sheets use `100dvh`.
- Controls: `touch-action: manipulation`, `user-select: none`, `-webkit-touch-callout: none`.
  Content stays selectable.
- Every hover style sits inside `@media (hover: hover) and (pointer: fine)`.
- Safe areas: band top, bottom bar, register, sheet footers, toasts.
- Inputs 17 px; `inputmode`, `enterkeyhint`, `autocomplete` on every field.

### 12.2 Accessibility

- Direction always in words; color repeats it (3.4 for contrast).
- Focus ring: 2 px `--focus` (carbon; light carbon on graphite), offset 2.
- Targets 44 minimum (drawn controls smaller than 44 extend their hit area with a pseudo element).
- Tabs and segments use `aria-current="page"`; faces and toggles `aria-pressed`; switches
  `role="switch"`; the keypad is a labeled group; toasts are live regions.
- Money reads as a sentence with the currency spelled out (8.3); expense rows have one-sentence
  labels (8.5).
- Layouts survive 200% zoom and 320 px width: titles ellipsize, footnotes and the who-row wrap,
  amounts scale with the slip (checked at 320 x 568, no horizontal overflow).

---

## 13. Copy

### 13.1 Tone

- Plain, warm, short. Talk to the person as 你 / you. No exclamation marks, no blame, no apology.
- Buttons say what happens and the result repeats the verb: 儲存 → 已儲存; 記錄還款 → 已記錄還款;
  復原 → 已復原.
- Errors say what happened and what to do: 「沒有網路，這筆已存在手機，連線後會自動同步。」
- Empty screens invite the next step (8.17).

### 13.2 zh-TW rules

- Taiwan usage: 群組, 帳戶, 匯率, 儲存, 復原, 設定, 朋友, 動態, 我的.
- Full-width punctuation in Chinese text: ，、：；「」（）？. No full stop on one-line labels,
  buttons, chips or row text; 。 only in multi-sentence notes and empty-state bodies.
- One half-width space between Chinese and Latin letters or digits (Niseko 滑雪 2026, 6 人,
  12 月); none between Chinese and Chinese, none next to full-width punctuation. After a Latin name
  before a verb: 「Tiffany 付了」; after a Chinese name: 「佳穎付了」.
- Digits for numbers (6 人, not 六人). Dates 「12/18 週五」, ranges 「12/16～12/20」 with the
  full-width tilde, times 24 h 「16:12」.
- Never the em dash or en dash. Use ，：（）「」 instead.

### 13.3 English rules and string table

US spelling, sentence case, contractions are fine. Dates "Fri, Dec 18", ranges "Dec 16 to 20",
times "4:12 PM". ※ becomes "Note:". Never the em dash or en dash.

| Where | zh-TW | English |
|---|---|---|
| Tabs | 總覽 / 群組 / 新增費用 / 朋友 / 動態 / 我的 | Home / Groups / Add / Friends / Activity / Account |
| Home sections | 別人欠你 / 你欠別人 | You're owed / You owe |
| Friend row | 欠你 / 你欠 | owes you / you owe |
| Group row | 你可以拿回 / 你欠 / Abbie 欠你 | You get back / You owe / Abbie owes you |
| Group meta | 6 人，來自 Tiffany / 4 人，付給 Kevin | 6 people, from Tiffany / 4 people, to Kevin |
| Settled | 已結清 / 跟你已結清 | Settled up / Settled up with you |
| Row effect | 你借出 / 你借入 / 你沒參與 / 剛好平衡 | You lent / You borrowed / Not involved / Even |
| Payment | 你收到 / 你付出 / Leo 付給你 | You received / You sent / Leo paid you |
| Payer line | 你付了 ¥12,600 / Kevin 付了 ¥38,028 | You paid ¥12,600 / Kevin paid ¥38,028 |
| Converted | ≈ ¥11,400，12/16 匯率 | ≈ ¥11,400 at the 12/16 rate |
| Footnotes | ※ 各幣別分開計算，不會自動換匯 / ※ 1 筆等待同步，已計入 | Note: each currency is totaled separately, never converted. / Note: includes 1 item waiting to sync. |
| Sync | 上次同步 12/20 16:12 / 等待同步 / 同步失敗 / 同步中（2 筆） | Last synced Dec 20, 4:12 PM / Waiting to sync / Sync failed / Syncing (2) |
| Offline | 離線中，新增的費用會在連線後自動同步 | You're offline. New expenses sync when you reconnect. |
| Group tabs | 費用 / 結算 / 統計 / 設定 | Expenses / Balances / Stats / Settings |
| Settle | 結清 / 記錄還款 / 提醒 Tiffany / 你的收款方式 | Settle up / Record a payment / Remind Tiffany / How to pay you |
| Add sheet | 新增費用 / 取消 / 儲存 / 到 Niseko 滑雪 2026 | Add expense / Cancel / Save / to Niseko 滑雪 2026 |
| Who-row | 由 你 付款，平均分給 6 人 | Paid by you, split equally, 6 people |
| Faces hint | 點頭像可排除沒參與的人 | Tap a face to leave someone out |
| Slip | 每人 / 你借出 ¥10,500 | Each / You lent ¥10,500 |
| Category | 自動分類：餐廳 / 分類：其他交通 | Auto: Dining out / Category: Transportation, other |
| FX | 以 JPY 記入群組 / 改匯率 | Booked in JPY / Edit rate |
| Date chips | 今天 / 昨天 / 備註 / 重複 | Today / Yesterday / Note / Repeat |
| Toasts | 已儲存「燒肉晚餐」 / 復原 / 重試 | Saved "Korean BBQ dinner" / Undo / Retry |
| Deleted | 已刪除 / 復原 / 顯示已刪除的費用 | Deleted / Restore / Show deleted expenses |
| List end | 12 月的 7 筆都在這裡了 | That's all 7 for December |
| Email code | 寄驗證碼 / 6 位數驗證碼 / 確認 / 重新寄送 / 換一個 Email | Send code / 6-digit code / Confirm / Send again / Use another email |
| Sign-in | 用密碼登入 / 忘記密碼？用驗證碼登入 / 歡迎回來，Abbie | Sign in with a password / Forgot it? Sign in with a code / Welcome back, Abbie |
| Google | 使用 Google 帳戶登入 / 或 / 已連結 / 連結 / 未連結 / Google 登入已取消。 | Sign in with Google / or / Linked / Link / Not linked / Google sign-in was canceled. |
| Apple | 使用 Apple 登入 / 這是新的帳號 / 知道了 / 我已經有帳號 / Apple 登入已取消。 | Sign in with Apple / This is a new account / Got it / I have an account / Sign in with Apple was canceled. |
| Email on 我的 | 保護你的帳號 / 加上 Email / 確認你的 Email / 更換 Email | Protect your account / Add email / Confirm your email / Change email |
| Receipt photo | 附收據 / 收據 / 移除收據 / 關閉 / 已移除收據照片 | Attach receipt / Receipt / Remove receipt / Close / Receipt photo removed |
| Receipt photos (up to three) | 收據照片 / 加一張 / 移除這張 / 收據 2/3 / 收據（3 張） / 上一張 / 下一張 / 第 2 張： | Receipt photos / Add one / Remove this photo / Receipt 2 of 3 / Receipts (3) / Previous photo / Next photo / Photo 2: |
| Reading them together | 掃描這張 / 2 張一起掃描 / 3 張一起掃描 / 已掃描 / 正在一起讀 3 張… | Scan it / Scan both / Scan all 3 / Scanned / Reading 3 photos… |
| Photo notes | 一筆最多三張，多選的 1 張沒有加進來 / 這張已經加過了 / 收據太長的話，可以分成最多三張，從上面拍到下面。 / 點照片可以放大或移除 / 照片還在準備中，請稍等一下 | An expense keeps up to three photos, so 1 was not added / This photo is already here / For a long receipt, take up to three photos, from the top down. / Tap a photo to see it full screen or remove it / Still preparing the photos. One moment |
| Before the first scan (App Review 5.1.2(i)) | 掃描會把收據照片傳給 AI / 掃描時，這筆費用的收據照片會傳給第三方 AI 服務 Cloudflare Workers AI，讀出金額、日期、店名和品項。只附上、沒有掃描的照片不會傳出去。同意後，這個帳號在這裡掃描就不會再問，可以在「我的」重設。 / 隱私權政策 / 同意並掃描 / 取消 | Scanning sends your receipt photos to AI / When you scan, this expense's receipt photos are sent to Cloudflare Workers AI, a third-party AI service, to read the amount, date, store and items. Photos you only attach are not sent. Once you agree, this account won't be asked again here, and you can reset this in Account. / Privacy policy / Agree and scan / Cancel |
| 我的: 收據掃描 | 收據掃描 / 你已同意：掃描時，收據照片會傳給 Cloudflare Workers AI 讀取。 / 下次掃描前再問我 / 下次掃描前會再問你 / 第一次掃描前會先問你，同意後才會把收據照片傳給 Cloudflare Workers AI。 | Receipt scanning / You agreed: when you scan, receipt photos are sent to Cloudflare Workers AI to be read. / Ask me again next time / You'll be asked again before your next scan / You'll be asked before your first scan. Receipt photos are sent to Cloudflare Workers AI only once you agree. |
| Scans that do not fit (two or three photos) | 你今天的收據掃描次數不夠讀這 3 張了，明天再試，或直接輸入 / 今天的收據掃描不夠一起讀這 3 張了，明天再試，或直接輸入 / 今天的收據辨識額度不夠一起讀這 3 張了，明天再試，或直接輸入 | You don't have enough receipt scans left today for 3 photos. Try again tomorrow, or type it in / Today's receipt scans can't cover 3 photos now. Try again tomorrow, or type it in / Today's receipt reading can't cover 3 photos now. Try again tomorrow, or type it in |
| Invite friends | 邀請朋友 / 邀請文案 / 日常 / 旅行 / 室友 / 要傳的話 / 分享 / 複製文案 / 複製連結 / 重設連結 | Invite friends / Message / Everyday / Trip / Roommates / What to send / Share / Copy message / Copy link / Reset link |
| Friend invite | 朋友邀請 / Gino 邀請你一起分帳 / 加為朋友 / 你和 Gino 已經是朋友了 / 打開你們的帳本 / 這是你自己的邀請連結 / 這個邀請連結已經失效 | Friend invite / Gino invited you to split costs together / Add as a friend / You and Gino are already friends / Open your ledger / This is your own invite link / This invite link no longer works |

English labels run longer: titles ellipsize, the who-row wraps, the stub minimum is 112 px, and
the center key says Add (verified in `reference/kit.png`).

### 13.4 Changes against docs/SPEC.md section 9 and COMPONENTS.md

| SPEC / contract | Now | Why |
|---|---|---|
| rowEffect not involved 沒有參與 | 你沒參與 | Parallel with 你借出 / 你借入; judged most natural |
| groupMine < 0 你要付 | 你欠 | The brief's wording (廈門 12 月 你欠 CN¥320); 要付 stays for third person |
| (none) | 你收到 / 你付出 on payment stubs | Stubs always carry a subject (judge 2) |
| (none) | 跟你已結清 for people on a slip | 「已結清」 alone did not say with whom |
| 結清 / 記錄還款 = Settle up | tab 結算 = Balances; button 結清 = Settle up; 記錄還款 = Record a payment | One word per action |
| Home: approximate total in home currency | Optional footnote only (8.4) | Balances are never converted; the big numbers stay per currency |
| Center add button | Center key 「＋ 新增費用」, English 「Add」 | Fits at 96 px |

---

## 14. Fix log: every judge problem

Receipt problems (all three judges), then the cross-cutting ones adopted as rules.

| # | Problem | Fix | Where |
|---|---|---|---|
| 1 | Print animation hides the add slip for about 1 s, repeats on every visit | Never on the add sheet; prints only when a number changed, 240 ms | 10 |
| 2 | iOS decimal pad: no Next, no 000, no +, focus timing | Register keypad, nothing focused on open | 9.1 |
| 3 | Invisible opacity-0 input, no caret, no expression | Drawn caret, append-only, expression line with 「= result」 | 9.1, add-start.png |
| 4 | Currency chip top left, hardest reach | The slip sits on the keypad; the chip is at about y 400 of 664 next to the amount | 9, add.png |
| 5 | Target group from 總覽 unspecified; 13 px grey picker | Last-used group; 儲存 names the group; picker 14/600 ink, 44 hit | 9.4 |
| 6 | Group header takes 235 px; day repeats on every row | Day once per day; compact band plus a one-line strip on scroll; 4 rows show at 664 | 8.4, 8.5, group-scrolled.png |
| 7 | Fixed 112 px stub column overflows on 8 digits | List-wide stub width from the longest amount (formula), 14 px step | 8.5 |
| 8 | Home said 已同步 while the group had a pending payment | One `lastSyncAt` everywhere; 「※ 1 筆等待同步，已計入」 | 8.4 |
| 9 | Group page marked 總覽 as current | Current tab follows the section | 7.1 |
| 10 | Stamp 14 px, rotated, noisy, 74% grey | Level, 15/700, solid faded ink 6.57:1, no noise | 8.9 |
| 11 | 「已結清」 does not say with whom | 「跟你已結清」 | 8.4, 13.3 |
| 12 | Stub labels 12 px without a subject | 13/600 你借出 / 你借入 / 你收到 / 你付出 | 8.5 |
| 13 | Home totals name nobody | A name on each currency line, with leaders | 8.4 |
| 14 | No English; ※ unfamiliar; English stub fit unknown | String table; "Note:"; 112 px stub minimum verified | 13.3, kit.png |
| 15 | ≈ falls back to the wide CJK glyph | Chivo Mono ≈ file (U+2248); ≈ inside `.amt` | 4.2 |
| 16 | Avatar stack uncapped | 3 plus 「+N」 | 8.1 |
| 17 | Long payer name pushes out the bill total | Name ellipsizes, verb and amount never shrink | 8.5, kit.png |
| 18 | Settled list wraps and splits 已結清 | Value nowrap; 「A、B 等 N 人」 | 8.4 |
| 19 | Cashier-terminal mood | Warm stone counter, tinted tickets with cover art, carbonless category tiles | 3, 6.3 |
| 20 | Every JPY trip has the same ticket | Cover glyph from the group emoji, chosen at creation | 6.3 |
| 21 | ₩ ₫ ₹ ₱ outside the font subsets; 「+ Add expense」 does not fit | latin-ext subsets loaded; English key 「Add」 | 4.2, 7.1 |
| 22 | (native) Segments 38 px | Segments are the full 44 | 8.11 |
| 23 | (native) Faces not discoverable, 26 px | Buttons with `aria-pressed`, 50 x 58, check badges, first-use hint | 8.13 |
| 24 | (native) Keypad: bare + and minus, minus above 儲存, trailing operator undefined | Keycaps, delete moved top right, 儲存 drops a trailing operator | 9.1 |
| 25 | (native) Description is the slow step, high on the sheet | Item line on the slip above the keys, recents, autocomplete, optional description | 9.2 |
| 26 | (native) System keyboard covers 儲存 | Save bar on the keyboard via `visualViewport` | 9.5 |
| 27 | (native) No one-tap settle | 「Tiffany 欠你 ¥86,400 [結清]」 is one button | 8.4 |
| 28 | (native) Pending sync barely visible | Dashed stub plus chip plus slip footnote | 8.5 |
| 29 | (native) Squeezed commas from `halt` | No `halt` on whole strings | 4.4 |
| 30 | (native) Label under the number, mirrored layout | Label always first | 8.4 |
| 31 | (native) Two currencies side by side on one line | One currency per line | 8.4 |
| 32 | (native) Signs without words in the bead strip | No bare signs anywhere | 2.2 |
| 33 | (picturebook) Red-green money pair | Blue against red | 3.1 |
| 34 | (picturebook) Word plus minus sign double negatives | Never a sign next to a word | 8.3 |
| 35 | (picturebook) CJK web font | System CJK only | 4.1 |
| 36 | (picturebook) Fake controls (check badges, 自動 pill) | Every drawn control is a button | 2.2, 8.13 |
| 37 | (picturebook) Top-anchored form, clipped date chip | The slip docks on the keys; nothing hides under 儲存 | 9.7 |
| 38 | (picturebook) Tilt from converted totals | No conversions in balances; optional reference footnote only | 8.4 |
| 39 | (picturebook) Heavy outlines | Hairlines; rings only on controls that act | 5 |
| 40 | (all) Content assumptions undocumented | Listed in reference/README.md | 15 |

---

## 15. Files

| Path | What |
|---|---|
| `design/DESIGN.md` | This file |
| `design/tokens.css` | Every token (light, dark via `prefers-color-scheme` and `[data-theme]`), font loading, base element styles, utilities. Copy to `src/web/styles/tokens.css` |
| `design/reference/home.html`, `.png` | 總覽, fixed |
| `design/reference/group.html`, `.png` | Niseko 滑雪 2026, 費用 tab, fixed |
| `design/reference/add.html`, `.png` | 新增費用, fixed |
| `design/reference/add-fx.*`, `add-start.*`, `group-scrolled.*` | Foreign currency; just opened; scrolled group |
| `design/reference/home-full.png` | 總覽 full length (friends section) |
| `design/reference/*-dark.png` | Dark mode (sources in `reference/_render/`) |
| `design/reference/kit.html`, `.png` | Component kit: money sizes, every expense-row state, buttons, chips, inputs, avatars, tickets, stamp, toast, offline notes, empty state, coupons, stats, English |
| `design/reference/original/` | The receipt mockups exactly as judged (HTML, PNGs, NOTES.md) |
| `design/reference/_src/` | Sources: `components.css`, `add.css`, `kit.css`, `icons.svg`, `*.src.html`, `build.py` |
| `design/reference/README.md` | How to rebuild and render; content assumptions |

Rebuild: `python design/reference/_src/build.py`, then
`node design/shot.cjs design/reference/<name>.html design/reference/<name>.png`
(`FULL=1` for a full page). The build inlines `tokens.css`, so the references always match it,
and refuses en and em dashes.

---

## 16. Needs a real iPhone

Emulation cannot show these; check on hardware (Safari tab and Home Screen app):

- PingFang TC next to Hanken Grotesk and Chivo Mono (the PNGs use Microsoft JhengHei).
- The keypad under a thumb; 44 px keys at 664 px tall; long-press delete; paste.
- The save bar riding the keyboard (`visualViewport`) while typing a description in Zhuyin.
- Safe areas in standalone mode with `black-translucent`; the band under the notch.
- Sheet drag-to-dismiss and momentum in the sheet body; the sticky slot lip on short screens.
- Whether the 6-step print feed looks crisp, not janky, at 240 ms.
- `color-mix()` tints and `cqw` sizing on the oldest iOS the friends use (both need iOS 16.2 or
  later; fall back to plain paper tiles and fixed sizes below that).
