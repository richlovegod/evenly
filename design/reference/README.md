# Evenly reference screens (收據 Receipt, fixed)

These are the screens the React implementation copies. They apply every judge fix and the grafts
listed in `design/DESIGN.md` section 1.2 and section 14. `original/` holds the receipt mockups
exactly as the judges saw them.

## Files

| File | Shows |
|---|---|
| `home.html` / `home.png` | 總覽 at 390 x 664 (Safari with toolbars) |
| `home-full.png` | 總覽 full length, including 朋友 |
| `group.html` / `group.png` | Niseko 滑雪 2026, 費用 tab |
| `group-scrolled.html` / `.png` | The same list after scrolling past the slip: compact band, one-line strip, sticky month |
| `add.html` / `add.png` | 新增費用: ¥12,600 燒肉晚餐, paid by 你, split 6 ways |
| `add-fx.html` / `add-fx.png` | Foreign currency: NT$2,400 機場接送 paid by 佳穎, booked in JPY |
| `add-start.html` / `add-start.png` | Just opened: recent descriptions, an expression (8,400 + 4,200), Tiffany left out |
| `*-dark.png` | Dark mode for home, group, add (sources in `_render/`) |
| `kit.html` / `kit.png` | Component kit: every expense-row state, buttons, chips, inputs, avatars, tickets, stamp, toast, offline notes, empty state, settle-up coupons, stats, English |
| `original/` | The receipt direction as judged (HTML, PNGs, NOTES.md) |
| `_src/` | Sources and the build script |

## Rebuild and render

```
python design/reference/_src/build.py
node design/shot.cjs design/reference/home.html design/reference/home.png
FULL=1 node design/shot.cjs design/reference/kit.html design/reference/kit.png
node design/shot.cjs design/reference/_render/home-dark.html design/reference/home-dark.png
```

`build.py` inlines `design/tokens.css`, `_src/components.css`, `_src/add.css`, `_src/kit.css` and
`_src/icons.svg` into each `_src/<name>.src.html`, writes `<name>.html` here and a
`data-theme="dark"` copy to `_render/`, and stops on any en or em dash. Edit the sources, never
the built HTML. The pages are self-contained except for the web fonts (fonts.gstatic.com).

Checked with `shot.cjs`: no horizontal overflow at 390 (iPhone 14) or 320 (iPhone SE), no page
errors. At 320 the add sheet's recent-description chips scroll sideways inside their own scroller
by design.

## Content assumptions

The brief's data is used as given. Where a screen needed more, these were filled in:

- Abbie in 家用 Gino & Abbie and Niseko is the friend Abbie.
- Niseko runs 12/16 to 12/20 (from the expense dates). Whistler 2025 is a CAD group of 5.
- 佳穎 paid 機場接送 (NT$2,400 at 1 TWD = 4.75 JPY is ¥11,400; your share ¥1,900).
- Leo's ¥236,222 was cash and is the row waiting to sync; last sync 12/20 16:12 on every screen.
- In Niseko only Tiffany owes you; Abbie, Kevin, Leo and 佳穎 are settled with you.
- Colors come from `src/shared/colors.ts`: Niseko and Kevin blue, 家用 and 佳穎 burnt orange,
  廈門 teal, Abbie ochre, Tiffany raspberry, Leo green.
- Kit only: 纜車票 (pending), 便利商店 (sync failed), 計程車 (deleted), 房租 12 月 (monthly, 2
  comments), 「Christopher Montgomery」 as a long-name stress case, Venmo @gino-chang and
  kevin.li@example.com as placeholder handles, Kevin's share in the stats as an illustrative number.
- The trip total ¥1,784,511 and your share ¥270,513 in the kit are computed from the brief's rows
  (payments excluded).
