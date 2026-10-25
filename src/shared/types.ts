// Data shapes exchanged between the web app and the Worker (the API contract).
// Amounts are integer minor units. Dates are 'YYYY-MM-DD'; timestamps are ISO 8601 UTC.

import type { Repeat } from './dates';
import type { Transfer } from './settle';
import type { Portion, SplitInput } from './split';

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

export type ActivityType =
  | 'group.create' | 'group.update' | 'group.delete'
  | 'member.add' | 'member.join' | 'member.claim' | 'member.update' | 'member.remove' | 'member.leave' | 'member.unlink'
  | 'expense.create' | 'expense.update' | 'expense.delete' | 'expense.restore'
  | 'comment.add'
  | 'recurring.create';

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
  | 'email_requires_code';

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

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}
