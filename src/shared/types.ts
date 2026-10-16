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
  members: { id: string; name: string; color: string; userId: string | null; active: boolean }[];
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

export interface SignupReq {
  name: string;
  email?: string;
  password?: string;
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

export interface CredentialsReq {
  email: string;
  password: string;
  /** Required when the account already has a password. */
  currentPassword?: string;
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
  /** The version the client edited; informational (last write wins). */
  baseVersion?: number;
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
  | 'password_required'
  | 'balance_not_zero'
  | 'code_invalid'
  | 'already_member'
  | 'member_claimed'
  | 'last_admin'
  | 'limit_reached'
  | 'fx_unavailable';

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; details?: unknown };
}
