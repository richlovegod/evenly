// Data shapes exchanged between the web app and the Worker (the API contract).
// Amounts are integer minor units. Dates are 'YYYY-MM-DD'; timestamps are ISO 8601 UTC.

import type { Repeat } from './dates';
import type { DefaultSplit, DefaultSplitInput } from './defaultSplit';
import type { Transfer } from './settle';
import type { Portion, SplitInput } from './split';

export type { DefaultSplit, DefaultSplitInput } from './defaultSplit';

export type Locale = 'zh-TW' | 'en';
export type GroupType = 'trip' | 'home' | 'couple' | 'other' | 'pair';
export type MemberRole = 'admin' | 'member';
export type ExpenseKind = 'expense' | 'payment';

export const GROUP_TYPES: readonly GroupType[] = ['trip', 'home', 'couple', 'other', 'pair'];

// ---------- users ----------

export interface UserDTO {
  id: string;
  name: string;
  /** Sign-in email (lowercase), null for an account that has none yet. */
  email: string | null;
  /**
   * The email was confirmed with a code sent to it (POST /api/auth/email/verify or
   * /api/me/email/verify). false for an account without one, and for an email set before email
   * codes (signup and POST /api/me/credentials took one without a code then). Clients treat a
   * missing field as false.
   */
  emailVerified: boolean;
  hasPassword: boolean;
  /**
   * A Google account is linked: 使用 Google 帳戶登入 signs in here (docs/SPEC.md section 3,
   * Google). The Google account's id itself never leaves the server. Clients treat a missing
   * field as false.
   */
  googleLinked: boolean;
  locale: Locale;
  /** Home currency, used for approximate totals across currencies. */
  currency: string;
  color: string;
  /** Free text other members see when settling up (bank account, LINE Pay, Zelle...). */
  payInfo: string;
  /** Venmo username without "@". */
  venmo: string;
  /** PayPal.me username. */
  paypal: string;
  isAdmin: boolean;
  createdAt: string;
  /**
   * The profile photo's version, or null without one. The photo is at
   * `<API base>/api/users/<id>/avatar?v=<avatar>`. Clients treat a missing field as null.
   */
  avatar: string | null;
}

export interface SessionDTO {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}

// ---------- groups ----------

export interface GroupDTO {
  id: string;
  name: string;
  type: GroupType;
  currency: string;
  emoji: string;
  color: string;
  simplify: boolean;
  notes: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  /**
   * The group's default split (docs/SPEC.md section 4, Default split; shared/defaultSplit.ts), or
   * null: new expenses then split equally among everyone. Clients treat a missing field as null.
   */
  defaultSplit: DefaultSplit | null;
}

export interface MemberDTO {
  id: string;
  groupId: string;
  /** Linked account, or null for a placeholder (someone added by name who has not joined). */
  userId: string | null;
  name: string;
  color: string;
  role: MemberRole;
  /** false after the member left or was removed (kept so old expenses still show them). */
  active: boolean;
  sort: number;
  createdAt: string;
  claimedAt: string | null;
  /** Payment details from the linked account, for settling up. */
  payInfo: string;
  venmo: string;
  paypal: string;
  /** The linked account's photo version (see UserDTO.avatar); null for a placeholder or without a photo. */
  avatar: string | null;
}

export interface ExpenseDTO {
  /** Client-generated UUID, so offline creates can be retried safely. */
  id: string;
  groupId: string;
  kind: ExpenseKind;
  description: string;
  category: string;
  amount: number;
  currency: string;
  /** 1 major unit of `currency` = fxRate major units of the group currency. */
  fxRate: number;
  date: string;
  notes: string;
  payers: Portion[];
  split: SplitInput;
  /** Computed by the server from `split` (minor units of `currency`). */
  shares: Portion[];
  repeat: Repeat;
  repeatSeries: string | null;
  repeatStart: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedBy: string | null;
  version: number;
  commentCount: number;
  /**
   * The receipt photo kept with this entry, or null (docs/SPEC.md section 6, Receipt photos). The
   * bytes are at `<API base>/api/groups/<groupId>/expenses/<id>/receipt?v=<receipt.version>`.
   * Clients treat a missing field as null.
   */
  receipt: ReceiptDTO | null;
}

/** A receipt photo's metadata (never its bytes). */
export interface ReceiptDTO {
  /** The first 16 hex characters of SHA-256 of the bytes: the photo's address never changes its bytes. */
  version: string;
  /** 'image/jpeg' or 'image/png'. */
  mime: string;
  /** In px, as the app measured the image (1 to 4000): for the thumbnail's shape before it loads. */
  width: number;
  height: number;
  /** Size of the stored image. */
  bytes: number;
}

/** GET /api/groups/:id */
export interface GroupSnapshotDTO {
  group: GroupDTO;
  members: MemberDTO[];
  /** All entries including deleted ones (deletedAt set), newest date first. */
  expenses: ExpenseDTO[];
  me: { memberId: string; role: MemberRole };
  inviteCode: string;
}

/** One group in GET /api/me. */
export interface GroupListItemDTO {
  id: string;
  name: string;
  type: GroupType;
  currency: string;
  emoji: string;
  color: string;
  version: number;
  updatedAt: string;
  myMemberId: string;
  /** My net in the group currency (positive = I get money back). */
  myNet: number;
  /** Settle-up transfers that involve me. */
  myTransfers: Transfer[];
  spent: number;
  count: number;
  lastDate: string | null;
  /** `avatar`: the linked account's photo version (see UserDTO.avatar), null for a placeholder. */
  members: { id: string; name: string; color: string; userId: string | null; active: boolean; avatar: string | null }[];
  /**
   * I archived the group (PUT /api/groups/:gid/archive): it is off my 總覽 and 群組 list, under
   * 已封存 at the bottom of 群組. My own flag only; nobody else sees it. Its balances still count in
   * `totals` and `friends`. Clients treat a missing field as false.
   */
  archived: boolean;
}

/** PUT /api/groups/:gid/archive */
export interface ArchiveReq {
  archived: boolean;
}

/** PUT /api/groups/:gid/archive: the flag as it is now. */
export interface ArchiveRes {
  archived: boolean;
}

export interface MoneyAmount {
  currency: string;
  amount: number;
}

/** A person I share groups with, with what we owe each other. */
export interface FriendDTO {
  /** 'u:<userId>' for people with an account, 'm:<memberId>' for placeholders. */
  key: string;
  userId: string | null;
  name: string;
  color: string;
  /** Per currency; positive = they owe me, negative = I owe them. */
  balances: MoneyAmount[];
  groups: { groupId: string; memberId: string; currency: string; amount: number }[];
  /** The 1:1 group with this person, if one exists. */
  pairGroupId: string | null;
  payInfo: string;
  venmo: string;
  paypal: string;
  /** The account's photo version (see UserDTO.avatar); null for 'm:' friends and without a photo. */
  avatar: string | null;
}

/** GET /api/me */
export interface MeDTO {
  user: UserDTO;
  groups: GroupListItemDTO[];
  friends: FriendDTO[];
  /** Per currency: owed = others owe me (>= 0), owe = I owe others (>= 0). */
  totals: { currency: string; owed: number; owe: number }[];
  unread: number;
  serverTime: string;
}

// ---------- activity and comments ----------

/**
 * `friend.join`: someone accepted a friend invite link and the two of them got a new 1:1 ledger.
 * The actor is the person who accepted; `data.memberId` and `data.memberName` are the link's owner
 * (their member in the new ledger), who gets the notification.
 */
export type ActivityType =
  | 'group.create' | 'group.update' | 'group.delete'
  | 'member.add' | 'member.join' | 'member.claim' | 'member.update' | 'member.remove' | 'member.leave' | 'member.unlink'
  | 'expense.create' | 'expense.update' | 'expense.delete' | 'expense.restore'
  | 'comment.add'
  | 'recurring.create'
  | 'friend.join';

export interface ActivityData {
  kind?: ExpenseKind;
  description?: string;
  amount?: number;
  currency?: string;
  /** Effect on each member in the group currency at the time (positive = gets back). */
  nets?: Record<string, number>;
  groupCurrency?: string;
  memberId?: string;
  memberName?: string;
  /** For updates: which fields changed, with display-ready before and after values. */
  changes?: { field: string; from: string; to: string }[];
  comment?: string;
  groupName?: string;
  /**
   * A 'group.update' that changed the default split: the new one (null: cleared), for the feed's
   * own sentence. Its `changes` line (field 'defaultSplit') holds the same as plain text.
   */
  defaultSplit?: Omit<DefaultSplit, 'setAt'> | null;
}

export interface ActivityDTO {
  id: string;
  groupId: string;
  groupName: string;
  groupEmoji: string;
  groupType: GroupType;
  userId: string | null;
  memberId: string | null;
  actorName: string;
  type: ActivityType;
  expenseId: string | null;
  data: ActivityData;
  createdAt: string;
}

export interface CommentDTO {
  id: string;
  expenseId: string;
  userId: string;
  memberId: string | null;
  authorName: string;
  body: string;
  createdAt: string;
}

// ---------- requests ----------

/**
 * POST /api/auth/signup: a name alone (older clients, the iOS app, test scripts). An email or a
 * password in the body is 400 `email_requires_code` and makes nothing: an account gets an email
 * only with a code sent to it (EmailStartReq).
 */
export interface SignupReq {
  name: string;
  locale?: Locale;
  currency?: string;
}

export interface AuthRes {
  token: string;
  user: UserDTO;
}

export interface LoginReq {
  email: string;
  password: string;
}

export interface UpdateMeReq {
  name?: string;
  locale?: Locale;
  currency?: string;
  color?: string;
  payInfo?: string;
  venmo?: string;
  paypal?: string;
}

/**
 * POST /api/me/credentials: sets or changes the password only. `email` must be the account's own
 * (the password key is salted with it), and that email must be confirmed, unless the account had
 * a password already; a new email goes through POST /api/me/email (400 `email_unconfirmed`).
 */
export interface CredentialsReq {
  email: string;
  password: string;
  /** Required when the account already has a password. */
  currentPassword?: string;
}

// ---------- email codes (docs/SPEC.md section 3, Email codes) ----------

/** POST /api/auth/email/start: a 6-digit code to `email`, in `locale` (default zh-TW). */
export interface EmailStartReq {
  email: string;
  locale?: Locale;
}

/** POST /api/me/email/start: a code to the email this account wants (in the account's language). */
export interface AddEmailStartReq {
  email: string;
}

/** Both start routes: the same answer whether or not the email has an account. */
export interface EmailStartRes {
  ok: true;
  /** How long the code works, in seconds (600). */
  expiresInSec: number;
  /** The code itself, in test mode only (EMAIL_DEV_ECHO on staging; never in production). */
  devCode?: string;
}

/** POST /api/auth/email/verify */
export interface EmailVerifyReq {
  email: string;
  code: string;
  /** The new account's name; needed when no account has this email (else 400 `name_required`). */
  name?: string;
  /** For a new account, as at signup. */
  locale?: Locale;
  currency?: string;
}

export interface EmailVerifyRes extends AuthRes {
  /** true: a new account was made with this email; false: the account that has it signed in. */
  created: boolean;
}

/** POST /api/me/email/verify */
export interface AddEmailVerifyReq {
  email: string;
  code: string;
}

export interface AddEmailVerifyRes {
  user: UserDTO;
  /**
   * The account had a password: its key was derived with the old email as the salt and no longer
   * works, so it was removed (POST /api/me/credentials sets a new one).
   */
  passwordCleared: boolean;
}

export interface LinkCodeRes {
  /** 8 characters, shown as XXXX-XXXX; valid 10 minutes, one use. */
  code: string;
  expiresAt: string;
}

// ---------- Sign in with Google (docs/SPEC.md section 3, Google) ----------

/** GET /api/auth/providers: the sign-in ways this site offers besides email codes and passwords. */
export interface ProvidersRes {
  /**
   * The app on this site may show 使用 Google 帳戶登入: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
   * are set, and the request came to the site Google sends people back to (APP_URL's origin).
   */
  google: boolean;
}

/**
 * How a Google sign-in ended, in the query of the page the callback sends the browser to
 * (`/?google=<arrival>#<return path>`): `new` made an account, `back` signed in to the account
 * linked to that Google account, `linked` linked it to the account that has its email and signed in.
 */
export type GoogleArrival = 'new' | 'back' | 'linked';

/**
 * Why a Google sign-in did not happen (`/?google_error=<code>#/login`; 登入 says it in words).
 * unavailable: not set up on this site. start: not started from the app on this site. denied:
 * the person said no on Google's page. state: the sign-in took over 10 minutes, or another one
 * started in this browser since. failed: Google's answer could not be used (the code exchange,
 * the token's signature or claims). unverified: Google has not verified the email. linked_other:
 * the account with this email is linked to another Google account. rate_limited: too many tries
 * from this network. server: anything else.
 */
export type GoogleErrorCode =
  | 'unavailable' | 'start' | 'denied' | 'state' | 'failed' | 'unverified' | 'linked_other' | 'rate_limited' | 'server';

export interface CreateGroupReq {
  id?: string;
  name: string;
  type: GroupType;
  currency: string;
  emoji?: string;
  color?: string;
  simplify?: boolean;
  /** Placeholders to add right away (an email that matches an account links it). */
  members?: { name: string; email?: string }[];
}

export interface UpdateGroupReq {
  name?: string;
  type?: GroupType;
  emoji?: string;
  color?: string;
  simplify?: boolean;
  notes?: string;
  /** Changing the currency re-bases every entry's fxRate (server fetches the rate). */
  currency?: string;
  /**
   * Set the group's default split (the Worker adds setAt and checks it against the active
   * members: shared/defaultSplit.ts checkDefaultSplit), or null to clear it. Not sent: unchanged.
   */
  defaultSplit?: DefaultSplitInput | null;
}

export interface AddMemberReq {
  name: string;
  email?: string;
}

export interface UpdateMemberReq {
  name?: string;
  color?: string;
  role?: MemberRole;
}

export interface UpsertExpenseReq {
  kind: ExpenseKind;
  description: string;
  category: string;
  amount: number;
  currency: string;
  fxRate: number;
  date: string;
  notes?: string;
  payers: Portion[];
  split: SplitInput;
  repeat?: Repeat;
  /**
   * The group currency `fxRate` was chosen against (the one the client saw). The server converts a
   * rate for an older group currency through the currency changes since.
   */
  rateBase?: string;
  /** The entry's version when the form was opened. Without `base`, a save older than someone else's write is a 409 conflict. */
  baseVersion?: number;
  /** The entry as the form was opened: the server writes only the parts this save changed (3-way merge); a part both people changed is a 409 conflict. */
  base?: Omit<UpsertExpenseReq, 'base' | 'baseVersion'>;
}

export interface UpsertExpenseRes {
  expense: ExpenseDTO;
  groupVersion: number;
}

export interface BatchImportReq {
  expenses: (UpsertExpenseReq & { id: string })[];
}

/** GET /api/join/:code (no sign-in needed) */
export interface JoinInfoDTO {
  group: { id: string; name: string; emoji: string; color: string; currency: string; type: GroupType; memberCount: number };
  members: { id: string; name: string; color: string; claimed: boolean; active: boolean }[];
  /** Set when the caller is signed in and already in the group. */
  myMemberId: string | null;
}

export interface JoinReq {
  /** Claim this placeholder... */
  memberId?: string;
  /** ...or join as a new member with this name. */
  name?: string;
}

/** GET /api/claim/:token (no sign-in needed) */
export interface ClaimInfoDTO {
  group: { id: string; name: string; emoji: string; color: string };
  member: { id: string; name: string; color: string };
  expiresAt: string;
}

// ---------- friend invite links (docs/SPEC.md sections 4 and 6, Friend invites) ----------

export type InviteTemplateKey = 'everyday' | 'trip' | 'roommates';

/** One ready-made invite message (src/shared/invites.ts), in the language asked for. */
export interface InviteTemplateDTO {
  key: InviteTemplateKey;
  /** The chip's word (日常 / Everyday). */
  label: string;
  /** The message without the link: clients send the link after it, on its own line (shareMessage). */
  text: string;
}

/** GET /api/me/invite?locale= and POST /api/me/invite/reset?locale= */
export interface MyInviteDTO {
  /** The personal code: random base62, 16 characters. */
  code: string;
  /** The link to share, built by the server: `<APP_URL>i/<code>?openExternalBrowser=1`. */
  url: string;
  /** everyday, trip, roommates, in that order. */
  templates: InviteTemplateDTO[];
}

/** GET /api/invite/:code (no sign-in needed) */
export interface InviteInfoDTO {
  /**
   * The link's owner. `avatar` is the photo's version (as UserDTO.avatar), or null without one;
   * anyone holding the code sees it at `<API base>/api/invite/<code>/avatar?v=<avatar>`.
   */
  inviter: { name: string; color: string; avatar: string | null };
  /** The caller is signed in and the code is their own. */
  self: boolean;
  /** The caller is signed in and already has a 1:1 ledger with the inviter (both active in it). */
  groupId: string | null;
}

/** POST /api/invite/:code */
export interface InviteAcceptRes {
  /** The 1:1 ledger (a pair group). */
  groupId: string;
  /** true: the two were friends already, and nothing changed. */
  existed: boolean;
}

/** GET /api/fx?base=TWD&date=2026-10-15 */
export interface FxRes {
  base: string;
  /** The date the rates are for (may be earlier than requested when no newer data exists). */
  date: string;
  /** rates[C] = value of 1 unit of C in `base` (major units). rates[base] = 1. */
  rates: Record<string, number>;
  source: string;
}

// ---------- owner tools (/api/admin, OWNER_EMAILS only) ----------
// None of these ever carries a password hash, a session id or a token.

/** One account in the owner's list (GET /api/admin/users). */
export interface AdminUserRow {
  id: string;
  name: string;
  /** Sign-in email, null for an account that has none. */
  email: string | null;
  /** The email was confirmed with a code (UserDTO.emailVerified). */
  emailVerified: boolean;
  hasPassword: boolean;
  locale: Locale;
  currency: string;
  /** Avatar color (#RRGGBB). */
  color: string;
  createdAt: string;
  /** The latest use of any of the account's sessions (written at most hourly), null without sessions. */
  lastActiveAt: string | null;
  /** Sessions that have not expired. */
  sessions: number;
  /** Labels of those sessions ("iPhone Safari"), distinct, most recently used first, at most 5. */
  devices: string[];
  /** Groups (not deleted) the account is an active member of. */
  groups: number;
  /** Entries (expenses and payments) the account created that are not deleted, in groups that are not deleted. */
  entries: number;
  /** When the newest of those entries was created. */
  lastEntryAt: string | null;
  /** The email is one of OWNER_EMAILS. */
  isOwner: boolean;
}

/** Site-wide counts for the owner page. */
export interface AdminStatsDTO {
  users: number;
  /** Accounts created in the last 7 days. */
  newLast7: number;
  /** Accounts that used one of their sessions in the last 7 days. */
  activeLast7: number;
  /** Accounts with an email: they sign in anywhere with an email code (or a password). */
  withEmail: number;
  /** Accounts with an email and a password. */
  withPassword: number;
  /** The rest: no email, so they live only on their devices. */
  deviceOnly: number;
  /** Groups that are not deleted. */
  groups: number;
  /** Entries that are not deleted, in groups that are not deleted. */
  entries: number;
}

/** GET /api/admin/users?q=&limit=&offset= (q: part of a name or email, any case; limit 1 to 100, default 50). */
export interface AdminUsersRes {
  /** Accounts matching q, all pages together. */
  total: number;
  /** Newest account first. */
  users: AdminUserRow[];
  stats: AdminStatsDTO;
}

/** A group the account has a member row in (also ones it left, and deleted groups). */
export interface AdminUserGroupDTO {
  id: string;
  name: string;
  type: GroupType;
  currency: string;
  emoji: string;
  color: string;
  /** Active members. */
  memberCount: number;
  /** The account's role there. */
  role: MemberRole;
  /** false after the account left or was removed. */
  active: boolean;
  /** Live entries in the group (anyone's). */
  entries: number;
  /** Date of the group's latest live entry ('YYYY-MM-DD'). */
  lastDate: string | null;
  deleted: boolean;
}

/** A session that has not expired: which device, when it signed in, last use, expiry. */
export interface AdminSessionDTO {
  label: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export interface AdminUserDetailDTO extends AdminUserRow {
  payInfo: string;
  venmo: string;
  paypal: string;
}

/** GET /api/admin/users/:id */
export interface AdminUserRes {
  user: AdminUserDetailDTO;
  /** Active memberships first, deleted groups last. */
  groups: AdminUserGroupDTO[];
  /** Most recently used first. */
  sessions: AdminSessionDTO[];
  /** The latest 20 activity rows the account made, newest first. */
  activity: ActivityDTO[];
}

export type ApiErrorCode =
  | 'bad_request'
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'server_error'
  | 'email_taken'
  | 'invalid_credentials'
  | 'weak_password'
  /** No longer sent (signup took an email with a password until 2026-10-25); kept for older clients. */
  | 'password_required'
  | 'balance_not_zero'
  | 'code_invalid'
  | 'already_member'
  | 'member_claimed'
  | 'last_admin'
  | 'limit_reached'
  | 'fx_unavailable'
  /** 401: the session cookie now belongs to another account than the X-Evenly-User this tab
   *  sent (another tab signed in as someone else). Reload, do not sign out. */
  | 'session_changed'
  /** 409: signup refused because a live session cookie is already present. */
  | 'already_signed_in'
  /** 502: the receipt could not be read (the model failed or gave nothing usable). */
  | 'scan_failed'
  /** 503: today's code emails are used up (EMAIL_GLOBAL_PER_DAY, or Resend's own daily quota);
   *  `details.retryAfter` counts to 00:00 UTC. */
  | 'email_quota'
  /** 503: no code email can go out now (email is not set up here, or Resend failed). */
  | 'email_unavailable'
  /** 400: the code was right, but no account has this email: send `name` to create one. */
  | 'name_required'
  /** 400: POST /api/me/credentials cannot set an email that was not confirmed with a code. */
  | 'email_unconfirmed'
  /** 400: POST /api/auth/signup takes a name only; an email comes with a code (POST /api/auth/email/start). */
  | 'email_requires_code'
  /** 503: today's receipt photo uploads for the whole app are used up (Workers KV's free daily
   *  writes); `details.retryAfter` counts to 00:00 UTC. */
  | 'receipts_quota'
  /** 503: the space kept for receipt photos is full; nothing new is stored until some are deleted. */
  | 'receipts_full'
  /** 400: POST /api/invite/:code with the caller's own friend invite code. */
  | 'own_invite';

// ---------- push notifications (docs/PLAN-push-scan-cookies.md section 2) ----------

/** Which kinds of change notify this account (on every device that turned push on). */
export interface PushPrefsDTO {
  /** A new expense you are part of. */
  expenses: boolean;
  /** A payment to or from you. */
  payments: boolean;
  /** Someone joined a group you are in, or added you to one. */
  joins: boolean;
}

/** PUT /api/push/subscription: PushSubscription.toJSON() plus the device's time zone. */
export interface PushSubscriptionReq {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** IANA time zone, e.g. 'Asia/Taipei' (optional). */
  tz?: string;
}

export interface PushStatusRes {
  /** The VAPID public key (base64url) the browser subscribes with. */
  publicKey: string;
  prefs: PushPrefsDTO;
  /** How many devices of this account get notifications. */
  devices: number;
}

export interface PushTestRes {
  sent: number;
  /** Subscriptions the push service said are gone (deleted). */
  removed: number;
  failed: number;
}

/** What the service worker receives (encrypted) in each push message. */
export interface PushPayload {
  title: string;
  body: string;
  /** Hash route to open on tap, e.g. '/g/<gid>/e/<eid>' (the SW resolves it against its scope). */
  path: string;
  /** Notifications with the same tag replace each other (one per group). */
  tag: string;
}

// ---------- receipt scan (docs/PLAN-push-scan-cookies.md section 3) ----------

export interface ReceiptScanReq {
  /** data:image/jpeg;base64,... (the app shrinks the photo to about 1600 px first). */
  image: string;
  /** The form's currency when the scan started: the reader's guess for a receipt that shows no
   *  currency or only a bare $, and then the unit of its amounts. */
  currency?: string;
  locale?: Locale;
}

/** What a receipt says. Money is in MAJOR units as plain numbers (1260 for ¥1,260; 12.5 for
 *  US$12.50); null when it could not be read. */
export interface ReceiptScanDTO {
  merchant: string | null;
  /** YYYY-MM-DD (Gregorian; 民國 and 令和 years are converted). */
  date: string | null;
  /** ISO 4217 code, or null when unsure. */
  currency: string | null;
  /** The final amount paid, tax, service and tip included. */
  total: number | null;
  /** Line items as printed, after per-line discounts; no subtotal, tax, tip or change lines. */
  items: { name: string; amount: number }[];
  tax: number | null;
  /** Tip, or a service charge (服務費, サービス料). */
  tip: number | null;
  /** A category key from shared/categories.ts (never 'payment'), or null. */
  category: string | null;
  /** Things the reader noticed, in the request's language (e.g. the items do not add up). */
  warnings: string[];
  /** For the admin page and tuning. */
  usage?: { model: string; promptTokens: number; completionTokens: number; neurons: number };
}

// ---------- profile photo (docs/SPEC.md section 6, Profile photo) ----------

/** PUT /api/me/avatar */
export interface AvatarReq {
  /** data:image/jpeg;base64,... or data:image/png;base64,... (the app sends a 256 x 256 JPEG). */
  image: string;
}

/** PUT and DELETE /api/me/avatar: the photo's version now (UserDTO.avatar), null after a removal. */
export interface AvatarRes {
  avatar: string | null;
}

// ---------- receipt photos (docs/SPEC.md section 6, Receipt photos) ----------

/**
 * PUT /api/groups/:gid/expenses/:eid/receipt?w=<px>&h=<px>: the body is the image itself
 * (Content-Type image/jpeg or image/png, at most 600,000 bytes; no JSON, no base64). Answers the
 * photo now on the entry and the group's new version.
 */
export interface ReceiptRes {
  receipt: ReceiptDTO;
  groupVersion: number;
}

/** DELETE /api/groups/:gid/expenses/:eid/receipt */
export interface ReceiptDeleteRes {
  groupVersion: number;
}

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}
