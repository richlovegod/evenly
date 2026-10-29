import type { Context } from 'hono';

export interface Env {
  DB: D1Database;
  /** The built web app (Workers Static Assets). Files are served without the Worker; it sees /api,
   *  page loads of "/" (to renew the session cookies), friend invite pages (/i/<code>) and paths
   *  with no file. */
  ASSETS?: Fetcher;
  /** Workers AI: reads receipt photos (routes/receipts.ts). */
  AI?: Ai;
  /** Workers KV: the receipt photos kept with expenses (routes/receiptPhotos.ts), key
   *  receipt:<expenseId>:<version>. Without it the photo routes answer 503 or 404. */
  RECEIPTS?: KVNamespace;
  /** Comma-separated origins allowed by CORS (cross-origin Bearer callers only). */
  ALLOWED_ORIGINS: string;
  /** Where the web app lives, used to build links (ends with "/"). */
  APP_URL: string;
  ENVIRONMENT: string;
  /** Secret: comma-separated emails that get owner tools (admin page). */
  OWNER_EMAILS?: string;
  /** Optional rate-limit overrides (numbers as strings); staging sets them high for tests. */
  SIGNUP_PER_HOUR?: string;
  LOGIN_EMAIL_PER_15M?: string;
  LOGIN_IP_PER_15M?: string;
  LINK_PER_15M?: string;
  /** Web Push (RFC 8292): the public key (base64url, 65-byte P-256 point), the contact URL, and
   *  the secret private key as a JWK JSON string {kty, crv, d, x, y}. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_SUBJECT?: string;
  VAPID_PRIVATE_JWK?: string;
  /** Apple Push Notification service (services/apns.ts), the iPhone app's notifications: the auth
   *  key's id, the Apple Developer team id, the app's bundle id (the apns-topic), and the secret
   *  key itself, Apple's .p8 file as it is (PEM). Without all four, iPhones get no notifications. */
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
  APNS_AUTH_KEY?: string;
  /** Seconds a push waits before it is sent, so bursts merge and undone entries are dropped
   *  (default 30; staging 0). */
  PUSH_HOLD_SECONDS?: string;
  /** Most push messages one sender run sends (default 12, at most 40). */
  PUSH_MAX_PER_RUN?: string;
  /** Receipt scans: the Workers AI model and the per-user and whole-app daily limits. */
  RECEIPT_MODEL?: string;
  RECEIPT_PER_DAY?: string;
  RECEIPT_GLOBAL_PER_DAY?: string;
  /** Receipt photos: KV writes the whole app may make a UTC day (default 900) and the bytes it may
   *  keep (default 950,000,000). Workers KV's free 1,000 writes a day and 1 GB belong to the
   *  Cloudflare account, shared by staging and production, so staging sets small ones. */
  RECEIPT_KV_WRITES_PER_DAY?: string;
  RECEIPT_STORE_MAX_BYTES?: string;
  /** Secret: the Resend API key that sends the sign-in codes (services/email.ts). Without it,
   *  production answers 503 email_unavailable and staging only echoes the code (EMAIL_DEV_ECHO). */
  RESEND_API_KEY?: string;
  /** The sender of the code emails, e.g. "吉諾分帳所 <login@ginochang.com>" (a domain verified in Resend). */
  EMAIL_FROM?: string;
  /** "1": test mode, the start routes also answer with the code (devCode). Never honored when
   *  ENVIRONMENT is production (services/email.ts canEcho). */
  EMAIL_DEV_ECHO?: string;
  /** Code emails asked for per IP an hour (default 10) and sent by the whole app a UTC day
   *  (default 90, under the 100 a day of Resend's free plan). */
  EMAIL_IP_PER_HOUR?: string;
  EMAIL_GLOBAL_PER_DAY?: string;
  /** Sign in with Google (services/google.ts): the OAuth client's id, a var ("SET_ME" until the
   *  Google Cloud console has made one, which counts as not set), and its secret. Without either,
   *  GET /api/auth/providers says google: false and the start route sends people back to 登入. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Google sign-ins started, and callbacks answered, per IP in 15 minutes (default 20 each). */
  GOOGLE_IP_PER_15M?: string;
  /** Looks at a friend invite without signing in (GET /api/invite/:code), per IP in 15 minutes
   *  (default 30, routes/invites.ts). */
  INVITE_IP_PER_15M?: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string | null;
  isOwner: boolean;
  sessionId: string;
  /** How this request signed in: an Authorization header, or the session cookie. */
  via: 'bearer' | 'cookie';
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    /** Set by requireUser (always) and optionalUser (when a valid token was sent). */
    user: AuthUser;
  };
};

export type Ctx = Context<AppEnv>;
