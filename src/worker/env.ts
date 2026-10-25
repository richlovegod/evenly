import type { Context } from 'hono';

export interface Env {
  DB: D1Database;
  /** The built web app (Workers Static Assets). Files are served without the Worker; it sees /api,
   *  page loads of "/" (to renew the session cookies) and paths with no file. */
  ASSETS?: Fetcher;
  /** Workers AI: reads receipt photos (routes/receipts.ts). */
  AI?: Ai;
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
  /** Seconds a push waits before it is sent, so bursts merge and undone entries are dropped
   *  (default 30; staging 0). */
  PUSH_HOLD_SECONDS?: string;
  /** Most push messages one sender run sends (default 12, at most 40). */
  PUSH_MAX_PER_RUN?: string;
  /** Receipt scans: the Workers AI model and the per-user and whole-app daily limits. */
  RECEIPT_MODEL?: string;
  RECEIPT_PER_DAY?: string;
  RECEIPT_GLOBAL_PER_DAY?: string;
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
