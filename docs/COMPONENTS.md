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
  Safe areas: `env(safe-area-inset-*)`. The phone tab bar moves down by `visualViewport.offsetTop`
  while the visual viewport is 120 px or more short of the window (`startFixedShift` in
  `lib/viewport.ts` keeps `--vv-shift` on the bar; DESIGN.md 9.5).
- `ViewportDebug()` in `ViewportDebug.tsx` (mounted once by App beside `Toaster` and `DialogHost`,
  portaled to body): the keyboard debug overlay of DESIGN.md 9.5, the live visual viewport, focus
  and tab bar numbers with a verdict, and the last 60 focus and viewport events (sessionStorage
  `evenly.vvlog`), with 複製 / 清除 / 關閉. On with `?debug=vv` before the `#`, or five taps on the
  version line on 我的 within 3 s (`viewportDebugOn()`, `setViewportDebug(on)`: sessionStorage
  `evenly.vvdebug`, per tab, then an `evenly:vvdebug` event on window). Off, it renders nothing.
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
- `Avatar({ name: string, color: string, userId?: string | null, avatar?: string | null, photoUrl?: string | null, size?: number, ring?: boolean })` and
  `AvatarStack({ people: { name: string; color: string; userId?: string | null; avatar?: string | null }[], max?: number, size?: number })` in
  `Avatar.tsx`. Initials: first character for CJK names, first letters of up to two words for
  Latin names. With `userId` and `avatar` (the DTO's photo version) the profile photo shows in the
  same circle and outline; the initial is the fallback when it does not load (`lib/avatars.ts`).
  `photoUrl` names the photo's address instead (the friend invite page: the inviter's photo at
  `/api/invite/<code>/avatar?v=`, which needs no sign-in).
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
  in `TextField.tsx` (font-size >= 16 px). `autoFocus` focuses the field as it mounts with a mouse
  only, never on a touch screen (`lib/autoFocus.ts` `useAutoFocus`, DESIGN.md 9.5).
- `AmountInput({ value: string, onChange: (raw: string) => void, currency: string, onCurrencyClick?: () => void, autoFocus?: boolean, size?: 'md' | 'lg' | 'xl', error?: string, label?: string })`
  in `AmountInput.tsx`: shows the currency symbol (a tappable chip when onCurrencyClick is set),
  `inputMode="decimal"`, and when the text is an expression (`shared/money.isExpression`) shows
  "= <formatted result>" using `parseAmount`. `autoFocus` as TextField's (a mouse only).
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
  On a touch screen its `[data-autofocus]` field (or a Dialog's prompt input) is not focused as it
  opens, the container is, and a field is not focused again as it closes (DESIGN.md 9.5).
- `Dialog.tsx`: `DialogHost()` (mounted once by App) and
  `confirmDialog({ title: string, message?: string, link?: { label: string, href: string }, confirmLabel?: string, cancelLabel?: string, danger?: boolean }): Promise<boolean>`
  (`link`: a page that says more, under the message, opened in a new tab; `dialog-link`)
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
  exist), `tabbar` (the phone tab bar itself), `offline-banner`; dialogs: `dialog-confirm`,
  `dialog-cancel`, `dialog-link`, `prompt-input`; toast: `toast`, `toast-action`; sheets: `sheet` (container),
  `sheet-close`; the keyboard debug overlay: `vv-debug` (container), `vv-copy`, `vv-clear`,
  `vv-close`.
- Welcome / login / link: `welcome-name`, `welcome-email`, `welcome-send` (寄驗證碼), `welcome-login`,
  `welcome-link`, `lang-zh`, `lang-en`, `login-email` (both forms), `login-send` (寄驗證碼),
  `login-password-toggle` (用密碼登入), `login-password`, `login-submit`, `login-code-toggle`
  (忘記密碼？用驗證碼登入), `link-code`, `link-submit`, `apple-sign-in` (使用 Apple 登入) and
  `google-sign-in` (使用 Google 帳戶登入), on 開始使用, 登入 and the friend invite page, only where
  each can work.
- The email code step (`CodeStep`, on every email-code form): `code-input` (the 6 digits),
  `code-submit`, `code-resend` (重新寄送, disabled for 60 s), `code-change-email` (換一個 Email),
  `code-name` (登入, when the email has no account yet), `code-dev` (the code itself, staging's test
  mode only).
- Home: `home-totals`, `home-friend-row`, `home-group-row` (each row also `data-id`), `home-new-group`,
  `home-add-friend`, `home-account`, `home-protect` (the card for an account without a confirmed
  email) and its `home-add-email`.
- New group: `newgroup-name`, `newgroup-currency`, `newgroup-type-<trip|home|couple|other>`,
  `newgroup-member-input`, `newgroup-member-add`, `newgroup-submit`.
- Group page: `group-title`, `group-status`, `group-tab-<expenses|balances|stats|settings>`,
  `group-add-expense`, `expense-search`, `expense-row` (with `data-id` = expense id and
  `data-state` = `synced` | `pending` | `failed` | `deleted`), `expense-row-receipt` (the receipt
  glyph in a row whose entry has photos, stored or queued; `data-photos` = how many), `show-deleted`.
- Editor: `editor-amount`, `editor-currency`, `editor-description`, `editor-category`,
  `editor-payer`, `editor-split`, `split-method-<equal|exact|percent|shares|adjust|items>`,
  `split-check-<memberId>`, `split-value-<memberId>`, `split-done`, `split-error`,
  `payer-option-<memberId>`, `payer-multi`, `preset-<i-equal|i-full|they-equal|they-full>`,
  `editor-date`, `editor-notes`, `editor-repeat`, `fx-rate`, `fx-rate-input`, `editor-save`,
  `editor-savebar` (the bar riding the keyboard while someone types, with `editor-done` and its own
  `editor-save`), `editor-scan` (掃描; `data-offer` = `pick` | `scan` | `scanned` | `reading`) and
  `editor-scan-file` (its hidden file input, `multiple`); the receipt photos (up to three):
  `editor-receipt-attach` (附收據, no photo yet), `editor-receipt-thumb` (the pill: the first
  photo's thumbnail and 收據; a tap opens the 收據照片 sheet), `editor-receipt-remove` (× on the
  pill, one photo only), `editor-receipt-count` (the count where × was, two or three photos),
  `editor-receipt-file` (the hidden `<input type="file" accept="image/*" multiple>` behind 附收據
  and ＋ 加一張; tests call setInputFiles on it, with several files at once); the 收據照片 sheet:
  `editor-receipts-sheet` (its content), `editor-receipts-done` (完成), `editor-receipt-photo-<i>`
  (the tiles, 1 to 3), `editor-receipt-photo-remove-<i>` (their ×), `editor-receipt-add` (＋ 加一張),
  `editor-receipts-scan` (the footer's scan button, `data-offer` as on 掃描), and
  `editor-receipts-scanned` (the line after 掃描 on a list already scanned).
- Expense detail: `detail-amount`, `detail-edit`, `detail-delete`, `detail-restore`,
  `comment-input`, `comment-send`, `comment-item`, `history-item`, `share-row` (one per member);
  one receipt photo: `detail-receipt` (the thumbnail button), `detail-receipt-image` (its `<img>`),
  `detail-receipt-status` (why a photo in the outbox waits), `detail-receipt-remove` (移除收據); two
  or three: `detail-receipt-<i>` and `detail-receipt-image-<i>` (the tiles, 1 to 3),
  `detail-receipt-status-<i>` (a queued photo's line) with `detail-receipt-retry-<i>` and
  `detail-receipt-discard-<i>` once its upload failed for good; the full-screen viewer
  (`ReceiptViewer`): `receipt-viewer` (its content, `data-at` = the page shown, 0-based),
  `receipt-viewer-close` (關閉), `receipt-viewer-prev` and `receipt-viewer-next` (two or three
  photos, hidden at the ends), `receipt-viewer-count` (the position in the title, 2/3 or 2 of 3),
  `receipt-viewer-remove`.
- Balances and settle: `balance-row` (data-id = member id), `transfer-row`, `transfer-settle`,
  `simplify-switch`, `share-summary`, `settle-from`, `settle-to`, `settle-amount`, `settle-save`.
- Settings: `settings-name`, `settings-invite-link`, `settings-invite-copy`, `settings-invite-share`,
  `settings-member-add-input`, `settings-member-add`, `member-row` (data-id), `member-claim-link`,
  `settings-export`, `settings-import`, `settings-leave`, `settings-delete`, `settings-currency`.
- Join / claim: `join-member` (data-id), `join-not-listed`, `join-new-name`, `join-submit`,
  `claim-name`, `claim-accept`; signed out, the 用 Email 加入 sheet: `signin-email`, `signin-send`
  (then the code step).
- Account: `account-name`, `account-protect` (the card for an account without a confirmed email)
  with `add-email-input` and `add-email-start` (寄驗證碼), `change-email` (更換 Email),
  `change-email-input`, `change-email-send`, `change-email-cancel`, `account-password`,
  `account-current-password`, `account-save-credentials` (the password only), `account-apple`
  and `account-google` (their rows in 登入方式) with `account-link-apple` and `account-link-google`
  (連結, where it can work), `account-relay` (the line for a Hide My Email address),
  `account-link-code`, `account-link-code-value`, `account-logout`,
  `account-lang-zh`, `account-lang-en`, `account-venmo`, `account-paypal`, `account-payinfo`,
  `account-save-profile`, `account-version` (the version line; five taps toggle the keyboard debug
  overlay).
- Friends and activity: `friend-row` (data-key), `addfriend-name`, `addfriend-email`,
  `addfriend-submit`, `activity-item`; 邀請朋友 from 朋友: `friends-invite` (the band button),
  `friends-list-invite` (under the list), `friends-empty-invite` (the empty state), and from 我的:
  `account-invite`.
- 邀請朋友 (`#/invite-friends`): `invite-link` (the link's code box), `invite-template-<everyday|trip|roommates>`
  (the chips, `aria-pressed`), `invite-text` (the message box, a textarea), `invite-share`,
  `invite-copy-text`, `invite-copy-link`, `invite-reset`.
- The friend invite page (`#/i/:code`): `invite-card` (the sky card, `data-state` = `signed-out` |
  `ready` | `friends` | `self`), `invite-title` (its h1), `invite-accept` (加為朋友),
  `invite-open-ledger`, `invite-self-open` (邀請朋友, on my own link), `invite-login` (已有帳號？登入),
  `invite-invalid` and `invite-error` (the h1 of a link that does not work, or did not load);
  signed out, the 用 Email 加入 sheet's `signin-email`, `signin-send`, then the code step (with
  `code-name` when the address has no account).

## Email-code pieces (src/web/features/auth, shared by 開始使用, 登入, the join and claim pages and 我的)
- `useEmailCode({ start, verify, onVerifyError? })` in `useEmailCode.ts`: the address step, then
  the code step (`step`, `email`, `code`, `resendAt`, `devCode`, `error`, `sending`, `verifying`,
  `send(raw)`, `resend()`, `type(raw)` (six digits are checked at once), `submit()`, `changeEmail()`).
- `CodeStep({ flow, submitLabel?, children?, className? })` in `CodeStep.tsx`: the code step drawn
  from that flow (TextField-like award field with big digits, Button, Note).
- `EmailSheet({ open, onClose, name, onSignedIn })` in `EmailSheet.tsx`: 用 Email 加入 for the
  join, claim and friend invite pages (a `Sheet`). With `name` empty (the friend invite page) an
  address that has no account gets a name step in the code step, as 登入 does (`code-name`).
- `emailCode.ts` (pure): `cleanEmail`, `emailOk`, `cleanCode`, `codeComplete`, `resendAt`,
  `waitText`, `codeErrorText(e, 'send' | 'verify')`.

## Sign in with Apple and Google (src/web/features/auth; docs/SPEC.md section 3, Google and Apple)
- `SignInButtons({ error?, className? })` in `SignInButtons.tsx`: 使用 Apple 登入 / Sign in with
  Apple (a link to `/api/auth/apple/start`, `data-testid="apple-sign-in"`), then 使用 Google
  帳戶登入 / Sign in with Google (`/api/auth/google/start`, `google-sign-in`), and the 或 rule
  under them, put first in the email form of 開始使用 and 登入 and on the friend invite page
  (design/DESIGN.md 8.21). Each shows only where it can work (`useProviders()`: the site says so
  through GET /api/auth/providers, remembered in `localStorage['evenly.providers']`; cookie mode;
  not `isEmbeddedBrowser()`); `error` (`ProviderError`), why the last sign-in came back to 登入,
  always shows. Offline, a tap says so instead of leaving the page (`startTap`). The Apple button
  draws Apple's own logo file (`AppleButtonLogo`, the "Left-aligned, White, Medium" file from
  Apple Design Resources, as tall as the button). Also exported: `AppleLogo` (the "Left-aligned,
  Black, Medium" file as it is, 31 x 44) and `GoogleG`, for 我的 > 登入方式 (`CredentialsForm.tsx`
  ProviderRows: 已連結, 連結, 先確認 Email for an account whose email is not confirmed, or 未連結 for
  each), and `claimedNotice()`, the dialog after a sign-in that took an unconfirmed
  email over (開始使用, 登入 and the email sheet call it after an email code with `notice`
  claimed).
- `takeProviderReturn(booted)` (main.tsx, once): takes `?google=`, `?apple=`, their `_error` and
  `_link`, `?link_pending=` and `?notice=` out of the address, keeps an error for 登入
  (`providerError()`, `clearProviderError()`), after a sign-in calls `actions.googleArrived()` (the
  same for both) and toasts 歡迎回來, or shows the dialog for a new account with a Hide My Email
  address (and `claimedNotice()` for `notice=claimed`); a link from 我的 that came back
  (`link_pending`) is asked about first (GET, then 連結 POST or 取消 DELETE through
  `actions.pendingLink`, `confirmPendingLink`, `dropPendingLink`), then the account is loaded
  again and a toast says how it went; a failed one toasts its reason.
- `googleSignIn.ts` and `appleSignIn.ts` (pure): `googleStartUrl` / `appleStartUrl(apiBase,
  returnTo, locale)`, `googleLinkUrl` / `appleLinkUrl(apiBase, locale)`, `readGoogleReturn` /
  `readAppleReturn(search)` (arrival, error, link, the rest of the query), the arrival, error and
  linked texts, `webViewUa(ua)`, `isRelayEmail(email)` and `relayNewAccountText()`.
- `signInNotices.ts` (pure): `readNoticeReturn(search)` (a pending link's id, whether the sign-in
  was `claimed`, the rest of the query), `pendingLinkQuestion(p)`, `pendingLinkedText(provider,
  moved)`, `pendingExpiredText()` and `claimedNoticeText()`.
- `session.ts` `isEmbeddedBrowser()`: LINE, Facebook, Instagram (`isInAppBrowser`) or another
  app's web view (`webViewUa`, the Home Screen app excepted). `InAppHint` shows there, and the
  buttons do not. `App.tsx` `peekReturn()`: the remembered page without forgetting it.

## Hooks the pages use (already written in src/web/lib)
- Receipt photos, up to three per entry (`lib/receipts.ts`, docs/SPEC.md section 8.7):
  `receiptUrl(gid, eid, version)`, `useReceiptImage(gid, eid, photo)` (anything with a `version`:
  `{src, onError, failed}`, src null while it loads or after it did not, then `failed`; like a
  profile photo through `lib/avatars.ts` usePrivateImage), `receiptAspect(photo)` (CSS
  aspect-ratio from width and height). Read an entry's photos through `photosOf(e)`
  (`shared/receipts.ts`, with `RECEIPT_PHOTOS_MAX`), or as they will be once the outbox is sent
  through `visiblePhotos(e, view.pendingPhotos[e.id], view.pendingReceipts[e.id])` (`lib/outbox.ts`,
  re-exported by the store: stored ones, a leftover legacy item on the first, drops hidden, queued
  adds after, each a `VisiblePhoto` with `stored` or `queued`). Changes go through the outbox:
  `actions.addReceiptPhoto(gid, eid, {version, image, width, height})` and
  `actions.removeReceiptPhoto(gid, eid, version)`. Photos come from `lib/photo.ts`
  receiptPhoto(file) (or `features/expenses/receiptScan.ts` scanPhotos(file) while adding, with the
  scan copy), and their version from `photoVersion(image)` (SHA-256, the first 16 hex characters).
- `ReceiptViewer({ gid, eid, photos, start, onClose, remove? })` (`features/expenses/ReceiptViewer.tsx`):
  the full-height viewer, one photo per page (`photos`: `{version, width, height, image?}`, a data
  URL or the stored photo's address), with ‹ › and ← → for two or three; `remove` puts a
  `{label, run(photo, index)}` button in its footer. The editor's photo rules without React are in
  `features/expenses/editorPhotos.ts` (`FormPhoto`, `startingPhotos`, `photosKey`, `pickPlan`,
  `withPhoto`, `photoSavePlan`, `scanOffer`).
- `useT()` -> `{ t, locale, zh, money, date, time, relative, num }` (`lib/i18n.ts`).
- `useStore(selector)`, `useGroupView(gid)`, `actions.*`, `membersById(snap)` (`lib/store.ts`).
- `useRoute()`, `navigate(path, {replace})`, `back(fallback)`, `href(path)` (`lib/router.ts`).
- `showToast({ message, kind?, action?, duration? })` (`lib/toast.ts`), `errorMessage(e)` (`lib/errors.ts`).
- `appLink('/join/<code>')` (`config.ts`), `isIosDevice()`, `isIosSafari()`, `isStandalone()`, `isInAppBrowser()` (`lib/pwa.ts`).
- The keyboard and the visual viewport (`lib/viewport.ts`, DESIGN.md 9.5): `readViewport()`,
  `keyboardCover(snap)` (null when zoomed or missing), `bottomInset(snap)`, `fixedShift(snap)`,
  `pinchZoomed(snap)`, `KB_UP` (120); `isTypingField(el)` (the add sheet's rule),
  `keyboardField(el)` and `realTyping(doc)` (a keyboard field with `:focus` on a page with
  focus); `watchTyping({ root, isField, fine, onChange })`, `installFocusRelease(fine)` (once,
  from main.tsx, on every platform: on a touch screen it blurs a keyboard field the page lost focus
  with, outside the add sheet, which watchTyping covers), `startFixedShift(el)` and
  `installRootScrollGuard()` (once, from main.tsx, on iOS only; after each scroll back it sends
  `GUARD_EVENT`, `evenly:vvguard`, on window), each returning a stop function.
  Focus from script: `finePointer()` (`(pointer: fine)` now) and
  `focusFromScript(el, { fine?, ...FocusOptions }): boolean`, the one way code outside a tap's own
  handler focuses something: on a touch screen it refuses a keyboard field and returns false (the
  caller then focuses a container or leaves focus where it is); with a mouse it focuses as
  `focus()` does. `focusLayerOpen(box, target, opts)` and `focusLayerReturn(box, previous, opts)`
  are the open and close rules of `Sheet.tsx` `useOverlay`. `useAutoFocus(ref, on)`
  (`lib/autoFocus.ts`) is React's autoFocus through `focusFromScript`, for TextField, AmountInput
  and fields with no component of their own.
