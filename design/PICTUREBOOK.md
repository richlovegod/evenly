# Evenly restyle: picture book (same family as award.ginochang.com)

Gino's ask (2026-10-16): "修改設計風格，和 https://award.ginochang.com/ 一樣的設計風格". This file is
the target for the restyle. It replaces the receipt look of `design/DESIGN.md` for everything
visual; DESIGN.md still describes layout, flows, copy and behavior, which stay as they are.

## Sources (read them, in this order)
1. **The award site's CSS**, the ground truth for the family look:
   `C:/Users/chunju/.claude/tmp/award-search/repo/index.html`, lines 1 to 600 (read only, do not edit).
   Screenshot: `C:/Users/chunju/evenly/tmp/award-ref/login.png`.
2. **The picture-book mockups made for Evenly** (same style adapted to this app; follow them for
   Evenly-specific screens): `design/mockups/picturebook/` (`home.html`, `group.html`, `add.html`,
   `add-fx.html`, their PNGs, `NOTES.md`, `_src/shared.css`, `_src/icons.svg`).
3. **Tokens**: `src/web/styles/tokens.css` (already rewritten with the picture-book values; the
   receipt token names are kept so modules compile, but restyle each module to the rules below).

## Rules
- **Ground and cards.** Page ground is paper `--paper` (#FFFCF6). Cards, sheets, fields and
  buttons are paper (or a pastel tint) with a **3 px ink outline** (`--line`). Radii: cards 22
  (`--r-panel`), fields 16 (`--r-field`), group covers and tiles 14, buttons and chips are pills
  (999). No drop shadows, no gradients, no blur. Dashed 2 px pencil (`--dash`) between rows.
- **Fills carry meaning.** Yolk `--yellow` = the action color (記一筆 / 新增費用, 儲存, primary
  buttons) and the selected tab, segment and chip. Sky `--water` = context and selection backgrounds
  (`--water-t` for focused fields, info cards), focus ring 3 px sky. Grass `--green`/`--green-t`
  and coral `--coral`/`--coral-t` appear only for money (欠你 vs 你欠) and toasts (grass) or
  destructive actions (coral). Text on money uses `--money-pos` (#2F6B3B) / `--money-neg`
  (#A63D2B), always with words (欠你, 你欠, 你借出, 你借入, 你可以拿回) and signs; never color alone.
- **Type.** Huninn for all text (`--font-text`), single weight: never bold, never faux bold;
  hierarchy by size and fill. Amounts, dates and counts in `--font-num` (M PLUS Rounded 1c) at
  `--fw-num` (800) for display and row amounts, `--fw-num-2` (700) for small ones, with tabular
  figures. Currency prefix 0.6 em at display sizes.
- **Top bar** (PageHeader, every page): the award site's `.top`: paper background,
  `border-top: 7px solid var(--water)`, `border-bottom: var(--line)`, sticky, the mascot logo
  (38 px) and title on the left, round 38 px icon buttons with 3 px outline on the right
  (`.icon-btn`), safe-area aware. Back button: a round outlined button with a chevron.
- **Bottom tab bar** (AppShell): the award site's `.tabbar` (`border-top: var(--line)`, 58 px,
  labels 12 px under the 30 px tab art below; the current tab's art sits in a 59 x 37 pill (54 x 32
  inside the outline) with yolk fill and 2.5 px ink outline, with the `pop` hop). The center add action is a yolk pill with 3 px outline
  saying 「＋ 記一筆」 (en "＋ Add") that sits on the bar's top rule, like the award site's search
  button sits on its card's bottom border. Desktop 900 px+: the award's centered dock.
- **Tab art** (`TabIcon.tsx`, Gino's drawings chosen 2026-10-25): colored drawings in the mascot's
  style on a 48 grid (ink #333 outlines, coral #F48B7B, face #F7A092, gold #F9D976, slip #FFFDF7,
  blue #A9CBE6), not line icons. 總覽 a house whose wall is a robot face, the antenna on the roof;
  群組 three robots around a table; 朋友 two heads leaning in under a gold heart; 動態 a smiling
  gold bell; 我的 the mascot's head and shoulders. 30 px in the tab bar and in the desktop
  sidebar's nav items (總覽 to 我的). The current tab keeps its yolk pill; the others show the same
  art at opacity .55 and `saturate(.35)`, back to full color under a hovering pointer. Forced
  colors: the art becomes a line drawing in the theme's colors (fills Canvas, outlines and eyes
  CanvasText) with no fade, and only the current tab keeps its outline. `Icon.tsx`'s `home`,
  `groups`, `friends`, `activity` and `user` stay line icons for the other pages.
- **Mascot.** The award robot, recolored for Evenly (yolk face, coral cheeks), same strokes:
  `<svg viewBox="0 0 40 40"><g fill="none" stroke="#3E3A39" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"><path d="M20 3v6"/><circle cx="20" cy="3" r="1.5" fill="#3E3A39"/><rect x="6" y="9" width="28" height="24" rx="9" fill="#F6D27A"/><circle cx="14.5" cy="19" r="4.2" fill="#FFFCF6"/><circle cx="25.5" cy="19" r="4.2" fill="#FFFCF6"/><circle cx="14.5" cy="19" r="1.4" fill="#3E3A39" stroke="none"/><circle cx="25.5" cy="19" r="1.4" fill="#3E3A39" stroke="none"/><path d="M16.5 27q3.5 3 7 0"/><path d="M11 38l3-5M29 38l-3-5"/></g></svg>`
  It is the logo in the top bar (floating gently, `.float`), on the welcome and empty states,
  and on the home hero.
- **Home hero, the memorable element** (from the mockup): a sky card (`--water-t`, 3 px outline,
  radius 22) with clouds and a hill drawn in the same 3 px ink line, and the mascot on a balance
  beam: 別人欠你 hangs on the left as a grass-tinted tag, 你欠別人 on the right as a coral-tinted tag,
  one line per currency; the heavier side sits lower; level when settled.
- **Slips become cards.** Every receipt slip (perforated, torn edges, dotted leaders, printer
  band, paper slot, stub, stamp) becomes a picture-book card: 3 px outline, radius 22, paper or a
  tint, dashed pencil rules, no tears. The 已結清 stamp becomes a sky pill with 2 px outline.
  Expense rows: a round 2 px outlined category circle with a sky or yolk tint, title, meta, and
  the word + amount on the right in the money color (no stub box). Pending sync: a dashed sky
  outline row with 「等待同步」; failed: coral-t with 重試 / 放棄.
- **Controls.** Buttons: pill, 3 px outline; primary yolk, secondary paper, danger coral, ghost no
  fill; `:active { transform: scale(.96) }`. Chips: pill, 3 px outline (2 px when small), selected
  yolk. Segmented control and tabs: separate pills with outline, selected yolk (award `.tt`).
  Inputs: 3 px outline, radius 16, label inside top-left in 12 px ink-2 (award `.field`), focused
  `--water-t` background. Switch: pill track with outline, knob outlined, on = grass.
  Checkboxes: 24 px outlined square radius 8, checked grass with an ink check.
- **Keypad** (add sheet): paper keys, 3 px outline, radius 16, digits in `--font-num`; operator
  keys sky tint; 儲存 key yolk. No dark register.
- **Sheets and dialogs**: paper, 3 px outline, top radius 28, a 5 px ink handle; scrim
  `--scrim`. **Toast**: the award `.toast`: grass pill (coral-t for errors), 3 px outline, centered,
  above the tab bar.
- **Avatars**: circles with 2 px outline; fill from the member color mixed into paper
  (`color-mix(in srgb, <color> 30%, var(--paper))`), initial in ink.
- **Motion**: only the award's: a hop (`pop`) when something arrives, the floating mascot, drifting
  clouds; all off under `prefers-reduced-motion`.
- **Light only**, like the award site: no dark mode (remove the 外觀 choice and any dark rules).
- **Do not change**: component props, data-testids, behavior, routes, copy (except where the old
  copy described the receipt look). Long names, 10+ members and amounts like ¥1,712,140 must not
  overflow at 320 px.

## How to check your work
A Vite dev server runs at http://127.0.0.1:5173/ (hot reload, talks to the staging API, which
allows that origin). Screenshot with `node C:/Users/chunju/evenly/design/shot.cjs <url> <png>
[device]` (WebKit, iPhone 14 by default; also try `"iPhone SE"`), or a small Playwright script with
`require('C:/Users/chunju/.claude/tmp/webkit-test/node_modules/playwright')` to sign up a test
account (names start with `test-`) and create data. Compare with the award screenshot and the
picture-book mockup PNGs. Scratch files go in `C:/Users/chunju/evenly/tmp/pb/<your key>/`.
