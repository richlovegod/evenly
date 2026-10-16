import type { Context } from 'hono';

export interface Env {
  DB: D1Database;
  /** Comma-separated origins allowed by CORS. */
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
}

export interface AuthUser {
  id: string;
  name: string;
  email: string | null;
  isOwner: boolean;
  sessionId: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    /** Set by requireUser (always) and optionalUser (when a valid token was sent). */
    user: AuthUser;
  };
};

export type Ctx = Context<AppEnv>;
