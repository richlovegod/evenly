# Web component contract (src/web/components)

Pages import these by path, e.g. `import { Button } from '../../components/Button'`. Props below
are the contract: implementers may add optional props, never rename or remove these. Every
component takes an optional `className`. Styling: CSS Modules next to each component
(`Button.module.css`) using the custom properties from `src/web/styles/tokens.css` (from
`design/tokens.css` and `design/DESIGN.md`). No inline color literals in pages; use tokens.
Every visible string comes from `useT().t('中文', 'English')`.

## Shell and navigation
- `AppShell({ route: Route, children })` in `AppShell.tsx`. Mobile (< 900 px): page content, then
  a fixed bottom tab bar: 總覽 Home (`#/`), 群組 Groups (`#/groups`), center add button,
  朋友 Friends (`#/friends`), 動態 Activity (`#/activity`, unread badge from `me.unread`). The
  account page opens from the avatar button in `PageHeader` on Home and from the desktop sidebar.
  If DESIGN.md defines different tab items (for example 總覽 / 群組 / 記一筆 / 動態 / 我的), follow
  DESIGN.md, as long as every route stays reachable (Friends from the Home 好友 section's
  "全部" link and the sidebar; Account from a tab or the avatar button).
  Desktop (>= 900 px): left sidebar with the same items plus 我的 Account and a 新增費用 button;
  content column max 760 px. The add button: inside a group route (`params.gid`) navigate to
  `/g/<gid>/add`, else open `AddExpenseChooser`. Renders `OfflineBanner` at the top.
  Safe areas: `env(safe-area-inset-*)`.
- `PageHeader({ title: ReactNode, subtitle?: ReactNode, back?: string, actions?: ReactNode, large?: boolean, leading?: ReactNode })`
  in `PageHeader.tsx`. `back` = fallback path for `router.back()`; shows a back button when set.
- `Tabs({ tabs: { key: string; label: string; href: string; badge?: number }[], active: string })`
  in `Tabs.tsx` (link-based tabs, e.g. the group page).
- `AddExpenseChooser({ open: boolean, onClose: () => void })` in `AddExpenseChooser.tsx`: sheet
  listing my groups (most recent first) and friends; picking one navigates to `/g/<gid>/add`
  (for a friend without a pair group it calls `actions.addFriend` first).

## Primitives
- `Button({ variant?: 'primary' | 'secondary' | 'ghost' | 'danger', size?: 'sm' | 'md' | 'lg', block?: boolean, loading?: boolean, icon?: IconName, ...ButtonHTMLAttributes })` in `Button.tsx`.
- `IconButton({ icon: IconName, label: string, onClick?, badge?: number, href?: string, size?: number })` in `IconButton.tsx` (label is the aria-label; 44 px target).
- `Icon({ name: IconName, size?: number, title?: string })` and `type IconName` in `Icon.tsx`.
  UI names: back, close, plus, check, chevronRight, chevronDown, search, settings, share, copy, qr,
  trash, edit, restore, undo, comment, repeat, calendar, user, users, home, groups, friends,
  activity, bell, wallet, swap, arrowRight, info, warning, offline, sync, logout, language,
  currency, device, link, lock, mail, download, upload, chart, more, camera, star, sparkle.
  Plus every `icon` value in `src/shared/categories.ts`. Unknown names render a neutral dot.
- `CategoryIcon({ category: string, size?: number })` in `CategoryIcon.tsx`: the category's icon in
  a tinted tile (color by category parent).
- `Avatar({ name: string, color: string, size?: number, ring?: boolean })` and
  `AvatarStack({ people: { name: string; color: string }[], max?: number, size?: number })` in
  `Avatar.tsx`. Initials: first character for CJK names, first letters of up to two words for
  Latin names.
- `GroupAvatar({ emoji: string, color: string, name: string, size?: number })` in `GroupAvatar.tsx`.
- `Money({ amount: number, currency: string, tone?: 'auto' | 'positive' | 'negative' | 'neutral', sign?: 'auto' | 'always' | 'never', size?: 'sm' | 'md' | 'lg' | 'xl' })`
  in `Money.tsx`: tabular figures, never wraps inside the number.
- `MoneyStatus({ amount: number, currency: string, kind: 'groupMine' | 'friend' | 'rowEffect' | 'member', involved?: boolean, size?: 'sm' | 'md' | 'lg' })`
  in `Money.tsx`: words + amount with the right tone, the single source of this vocabulary:
  - groupMine: > 0 你可以拿回 X / you get back X; < 0 你要付 X / you owe X; 0 已結清 / settled up
  - friend: > 0 欠你 X / owes you X; < 0 你欠 X / you owe X; 0 已結清 / settled up
  - rowEffect: > 0 你借出 X / you lent X; < 0 你借入 X / you borrowed X; 0 with involved 剛好平衡 /
    even; involved = false 沒有參與 / not involved
  - member (third person): > 0 可拿回 X / gets back X; < 0 要付 X / owes X; 0 已結清 / settled up
- `TextField({ label: string, value: string, onChange: (v: string) => void, placeholder?, type?, inputMode?, autoComplete?, error?: string, hint?: string, maxLength?: number, autoFocus?: boolean, multiline?: boolean, rows?: number, onEnter?: () => void, id?: string, disabled?: boolean })`
  in `TextField.tsx` (font-size >= 16 px).
- `AmountInput({ value: string, onChange: (raw: string) => void, currency: string, onCurrencyClick?: () => void, autoFocus?: boolean, size?: 'md' | 'lg' | 'xl', error?: string, label?: string })`
  in `AmountInput.tsx`: shows the currency symbol (a tappable chip when onCurrencyClick is set),
  `inputMode="decimal"`, and when the text is an expression (`shared/money.isExpression`) shows
  "= <formatted result>" using `parseAmount`.
- `Segmented<T extends string>({ options: { value: T; label: string; icon?: IconName }[], value: T, onChange: (v: T) => void, size?: 'sm' | 'md' })` in `Segmented.tsx`.
- `Chip({ label: ReactNode, icon?: IconName, onClick?: () => void, selected?: boolean, tone?: 'default' | 'accent' | 'warning' })` in `Chip.tsx`.
- `Switch({ checked: boolean, onChange: (v: boolean) => void, label: string, description?: string, disabled?: boolean })` in `Switch.tsx`.
- `ListRow({ leading?: ReactNode, title: ReactNode, subtitle?: ReactNode, trailing?: ReactNode, href?: string, onClick?: () => void, chevron?: boolean, disabled?: boolean })` in `ListRow.tsx`.
- `Section({ title?: ReactNode, action?: ReactNode, children, flush?: boolean })` in `Section.tsx`.
- `EmptyState({ icon?: IconName, title: string, body?: string, action?: ReactNode })` in `EmptyState.tsx`.
- `Spinner({ size?: number })` and `Skeleton({ height?: number, width?: number | string })` in `Spinner.tsx`.
- `OfflineBanner()` in `OfflineBanner.tsx`: from `useStore`: offline -> 離線中，新增的費用會在連線後自動同步;
  pending items -> 同步中（N 筆）; failed items -> N 筆同步失敗 (link to the group).
- `Toaster()` in `Toaster.tsx`: renders `lib/toast` (above the tab bar, safe-area aware, action button).
- `Sheet({ open: boolean, onClose: () => void, title?: ReactNode, children, footer?: ReactNode, size?: 'auto' | 'full', dismissible?: boolean })`
  in `Sheet.tsx`: bottom sheet on mobile, centered dialog on desktop; portal; Escape and backdrop
  close; focus moves in and returns; body scroll locked; footer sticks above the home indicator.
- `Dialog.tsx`: `DialogHost()` (mounted once by App) and
  `confirmDialog({ title: string, message?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean }): Promise<boolean>`
  and `promptDialog({ title, message?, label, initial?, placeholder?, confirmLabel? }): Promise<string | null>`.

## Pickers and helpers
- `CurrencyPicker({ open, onClose, value: string, onSelect: (code: string) => void, highlight?: string[] })`
  in `CurrencyPicker.tsx`: search by code or name (zh and en), `highlight` first (group currency,
  recent), then `COMMON_CURRENCIES`, then all.
- `CategoryPicker({ open, onClose, value: string, onSelect: (key: string) => void })` in
  `CategoryPicker.tsx`: grid grouped by `CATEGORY_GROUPS`.
- `MemberPicker({ open, onClose, title: string, members: MemberDTO[], value?: string, onSelect: (memberId: string) => void, meId?: string })`
  in `MemberPicker.tsx` (shows 你 / you for meId).
- `DateField({ value: string, onChange: (iso: string) => void, label?: string })` in
  `DateField.tsx`: chips 今天 / 昨天 plus a native date input; shows the date with `formatDate(.., 'mdw')`.
- `QRCode({ text: string, size?: number })` in `QRCode.tsx` (SVG from `qrcode-generator`).
- `src/web/lib/share.ts`: `shareOrCopy({ title?: string, text: string, url?: string }): Promise<'shared' | 'copied' | 'failed'>`
  (Web Share API when available, else clipboard, toast on copy) and `copyText(text): Promise<boolean>`.
- `src/web/lib/csv.ts`: `toCSV(rows: (string | number)[][]): string`, `parseCSV(text): string[][]`,
  `downloadFile(name, mime, content)`.

## Test ids (data-testid, required for the automated UI tests)
Put these exact `data-testid` values on the element a person taps or types into:
- Shell: `tab-home`, `tab-groups`, `tab-add`, `tab-friends`, `tab-activity`, `tab-account` (whichever
  exist), `offline-banner`; dialogs: `dialog-confirm`, `dialog-cancel`, `prompt-input`; toast:
  `toast`, `toast-action`; sheets: `sheet` (container), `sheet-close`.
- Welcome / login / link: `welcome-name`, `welcome-start`, `welcome-login`, `welcome-link`, `lang-zh`,
  `lang-en`, `login-email`, `login-password`, `login-submit`, `link-code`, `link-submit`.
- Home: `home-totals`, `home-friend-row`, `home-group-row` (each row also `data-id`), `home-new-group`,
  `home-add-friend`, `home-account`.
- New group: `newgroup-name`, `newgroup-currency`, `newgroup-type-<trip|home|couple|other>`,
  `newgroup-member-input`, `newgroup-member-add`, `newgroup-submit`.
- Group page: `group-title`, `group-status`, `group-tab-<expenses|balances|stats|settings>`,
  `group-add-expense`, `expense-search`, `expense-row` (with `data-id` = expense id and
  `data-state` = `synced` | `pending` | `failed` | `deleted`), `show-deleted`.
- Editor: `editor-amount`, `editor-currency`, `editor-description`, `editor-category`,
  `editor-payer`, `editor-split`, `split-method-<equal|exact|percent|shares|adjust|items>`,
  `split-check-<memberId>`, `split-value-<memberId>`, `split-done`, `split-error`,
  `payer-option-<memberId>`, `payer-multi`, `preset-<i-equal|i-full|they-equal|they-full>`,
  `editor-date`, `editor-notes`, `editor-repeat`, `fx-rate`, `fx-rate-input`, `editor-save`.
- Expense detail: `detail-amount`, `detail-edit`, `detail-delete`, `detail-restore`,
  `comment-input`, `comment-send`, `comment-item`, `history-item`, `share-row` (one per member).
- Balances and settle: `balance-row` (data-id = member id), `transfer-row`, `transfer-settle`,
  `simplify-switch`, `share-summary`, `settle-from`, `settle-to`, `settle-amount`, `settle-save`.
- Settings: `settings-name`, `settings-invite-link`, `settings-invite-copy`, `settings-invite-share`,
  `settings-member-add-input`, `settings-member-add`, `member-row` (data-id), `member-claim-link`,
  `settings-export`, `settings-import`, `settings-leave`, `settings-delete`, `settings-currency`.
- Join / claim: `join-member` (data-id), `join-new-name`, `join-submit`, `claim-accept`.
- Account: `account-name`, `account-email`, `account-password`, `account-current-password`,
  `account-save-credentials`, `account-link-code`, `account-link-code-value`, `account-logout`,
  `account-lang-zh`, `account-lang-en`, `account-venmo`, `account-paypal`, `account-payinfo`,
  `account-save-profile`.
- Friends and activity: `friend-row` (data-key), `addfriend-name`, `addfriend-email`,
  `addfriend-submit`, `activity-item`.

## Hooks the pages use (already written in src/web/lib)
- `useT()` -> `{ t, locale, zh, money, date, time, relative, num }` (`lib/i18n.ts`).
- `useStore(selector)`, `useGroupView(gid)`, `actions.*`, `membersById(snap)` (`lib/store.ts`).
- `useRoute()`, `navigate(path, {replace})`, `back(fallback)`, `href(path)` (`lib/router.ts`).
- `showToast({ message, kind?, action?, duration? })` (`lib/toast.ts`), `errorMessage(e)` (`lib/errors.ts`).
- `appLink('/join/<code>')` (`config.ts`), `isIosSafari()`, `isStandalone()`, `isInAppBrowser()` (`lib/pwa.ts`).
