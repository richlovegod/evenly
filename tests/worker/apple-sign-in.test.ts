// Sign in with Apple (services/apple.ts, the /api/auth/apple routes and /api/me/apple) and Google
// in the iPhone app (the client=ios flow of the Google routes, POST /api/auth/google/exchange and
// POST /api/me/google/ticket), docs/SPEC.md section 3, Apple and Google on the iPhone: the identity
// token's checks (signature, issuer, audience, expiry, nonce, the key cache and its refetch for an
// unknown key id), the client secret's shape, the code exchange and revoking, which account an
// Apple sign-in reaches (back, linked, new, linked_other, no_email, the name of a relay address),
// the iPhone app's Google code (single use, the verifier, expiry; the account found or made only at
// the exchange), the web's Apple flow (its SameSite=None cookie, the state, the user JSON, the
// session it replaces), linking from 我的 (what a flow is bound to lives on the server, found by a
// secret only the flow cookie holds, so a cookie written by hand or a leaked authorize URL names
// no account; the ticket needs its own session; a link that comes back through a browser waits as
// a pending link for the person to confirm; an empty account gives its Apple ID or Google account
// up), an unconfirmed email taken over, a refused grant kept or revoked, revoking on account
// deletion, what the per-IP limits count, the providers answer, the associated domain file and the
// app's way back, the daily cleanup and migrations 0013 to 0015. Runs the real Worker against the
// real schema in SQLite (d1-sqlite.ts) with https://split.test as APP_URL. Apple's endpoints point
// at https://apple.test (setAppleEndpoints) and fetch is a stub that plays them and Google; the
// identity tokens are signed in the test with an RSA key pair, and the Sign in with Apple key is a
// P-256 pair made here. No network.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSession } from '../../src/worker/auth';
import { sha256Hex } from '../../src/worker/http';
import worker from '../../src/worker/index';
import {
  APPLE_FLOW_TTL_SEC, appleClientSecret, appleName, appleSigning, CLIENT_SECRET_TTL_SEC, decodeAppleFlow, formatPersonName,
  nameFromAppleUser, setAppleEndpoints, verifyAppleToken,
} from '../../src/worker/services/apple';
import { cleanupStmts } from '../../src/worker/services/cron';
import { decodeFlow, forgetGoogleKeys, GOOGLE_JWKS_URL, GOOGLE_TOKEN_URL, pkceChallenge } from '../../src/worker/services/google';
import { settleExpiredPendingLinks } from '../../src/worker/services/links';
import { TestD1 } from './d1-sqlite';

const SITE = 'https://split.test';
/** The iPhone app's API origin (production's workers.dev): the same Worker, not APP_URL's origin. */
const API = 'https://evenly-api.test';
const SESSION = '__Host-evenly_session';
const MARKER = '__Host-evenly_user';
const APPLE_FLOW = '__Host-evenly_apple';
const GOOGLE_FLOW = '__Host-evenly_google';
const APPLE = {
  authorize: 'https://apple.test/auth/authorize',
  token: 'https://apple.test/auth/token',
  revoke: 'https://apple.test/auth/revoke',
  keys: 'https://apple.test/auth/keys',
};
const KEY_ID = 'ABC123DEFG';
const TEAM = '7XHV5223X7';
const APP_ID = 'com.ginochang.evenly';
const SERVICES_ID = 'com.ginochang.evenly.web';
const G_CLIENT = 'test-client.apps.googleusercontent.com';
const SUB = '001234.0a1b2c3d4e5f60718293a4b5c6d7e8f9.0123';
const G_SUB = '109876543210987654321';
const RELAY = 'x7k2m9q4p1@privaterelay.appleid.com';
/** The nonce the iPhone app keeps; Apple got its SHA-256 in hex. */
const RAW_NONCE = 'b2E5c-raw-nonce-kept-by-the-app.0123';
const APP_UA = 'Evenly/1.1 (com.ginochang.evenly; build:3; iPhone; iOS 26.0) Alamofire';
/** The iPhone app's way back from its Google flows: https on APP_URL's host (the associated domain). */
const IOS_CALLBACK = SITE + '/app/auth/google';

let db: TestD1;
let vars: Record<string, string | undefined>;
let sent: { url: string; init: RequestInit }[];

// ---------- keys made here: Apple's token signer, the Sign in with Apple key, Google's signer ----------

interface Signer {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey;
}

async function makeSigner(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', kid } as JsonWebKey };
}

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const b64json = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));
const unb64 = (s: string): unknown => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

async function signJwt(signer: Signer, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const head = b64json({ alg: 'RS256', kid: signer.kid, ...header });
  const body = b64json(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer.privateKey, new TextEncoder().encode(head + '.' + body));
  return head + '.' + body + '.' + b64url(new Uint8Array(sig));
}

let apple: Signer;
let forger: Signer;
let google: Signer;
/** The Sign in with Apple key (the APPLE_SIGNIN_KEY secret as a .p8 holds it) and its public half. */
let keyPem: string;
let keyPublic: CryptoKey;

beforeAll(async () => {
  apple = await makeSigner('apple-key-1');
  forger = await makeSigner('apple-key-1');
  google = await makeSigner('google-key-1');
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  // As Apple's .p8 file holds it (as apns.test.ts writes it).
  keyPem = ['-----BEGIN PRIVATE KEY-----', ...(der.match(/.{1,64}/g) ?? []), '-----END PRIVATE KEY-----'].join('\n');
  keyPublic = pair.publicKey;
});

afterAll(() => setAppleEndpoints());

// ---------- the stand-ins for Apple and Google ----------

/** The identity token's claims for an audience and the nonce it carries. */
function appleClaims(aud: string, nonce: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://appleid.apple.com', aud, exp: now + 600, iat: now, sub: SUB, c_hash: 'Q2hhc2g', email: RELAY,
    email_verified: 'true', is_private_email: 'true', auth_time: now, nonce_supported: true, nonce,
  };
}

/** What the next identity token says (the default: appleClaims), and its signer. */
let claimsEdit: (c: Record<string, unknown>) => Record<string, unknown>;
let signWith: () => Signer;
/** Apple's published keys. */
let appleKeys: () => JsonWebKey[];
/** The sub the token endpoint's id_token names (null: the identity token's). */
let exchangedSub: string | null;
/** How the token endpoint and revoke answer (defaults: a grant, 200). */
let tokenAnswer: (body: URLSearchParams) => Promise<Response>;
let revokeAnswer: (body: URLSearchParams) => Promise<Response>;
let grants = 0;

async function identityToken(aud: string, nonce: string): Promise<string> {
  return signJwt(signWith(), claimsEdit(appleClaims(aud, nonce)));
}

/** The nonce of the Google flow the token endpoint answers for (read from its cookie by the test). */
let googleNonce = '';
let googleClaims: (nonce: string) => Record<string, unknown>;

function goodGoogleClaims(nonce: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com', azp: G_CLIENT, aud: G_CLIENT, sub: G_SUB, email: 'abbie.lin@gmail.com', email_verified: true,
    name: 'Abbie Lin', given_name: 'Abbie', iat: now, exp: now + 3600, nonce,
  };
}

beforeEach(() => {
  db = new TestD1();
  vars = {};
  sent = [];
  grants = 0;
  setAppleEndpoints(APPLE);
  forgetGoogleKeys();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  claimsEdit = c => c;
  signWith = () => apple;
  appleKeys = () => [apple.jwk];
  exchangedSub = null;
  googleClaims = goodGoogleClaims;
  tokenAnswer = async body => {
    grants++;
    const sub = exchangedSub ?? SUB;
    const idToken = b64json({ alg: 'RS256', kid: 'apple-key-1' }) + '.' + b64json({ iss: 'https://appleid.apple.com', aud: body.get('client_id'), sub }) + '.c2ln';
    return Response.json({ access_token: 'a.access', token_type: 'Bearer', expires_in: 3600, refresh_token: `r.refresh-${grants}`, id_token: idToken });
  };
  revokeAnswer = async () => new Response(null, { status: 200 });
  vi.stubGlobal('fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    sent.push({ url: u, init });
    if (u === APPLE.keys) return Response.json({ keys: appleKeys() }, { headers: { 'Cache-Control': 'no-store' } });
    if (u === APPLE.token) return tokenAnswer(new URLSearchParams(String(init.body)));
    if (u === APPLE.revoke) return revokeAnswer(new URLSearchParams(String(init.body)));
    if (u === GOOGLE_JWKS_URL) return Response.json({ keys: [google.jwk] }, { headers: { 'Cache-Control': 'public, max-age=600' } });
    if (u === GOOGLE_TOKEN_URL) return Response.json({ id_token: await signJwt(google, googleClaims(googleNonce)) });
    throw new Error('unexpected fetch ' + u);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function env() {
  return {
    DB: db.d1, ALLOWED_ORIGINS: 'https://old.test', APP_URL: SITE + '/', ENVIRONMENT: 'test',
    GOOGLE_CLIENT_ID: G_CLIENT, GOOGLE_CLIENT_SECRET: 'google-secret-not-real',
    APPLE_SIGNIN_KEY_ID: KEY_ID, APPLE_TEAM_ID: TEAM, APPLE_APP_ID: APP_ID, APPLE_SERVICES_ID: SERVICES_ID, APPLE_SIGNIN_KEY: keyPem,
    ...vars,
  };
}

interface Res {
  status: number;
  headers: Headers;
  location: string;
  text: string;
  data: any;
  setCookies: string[];
}

async function call(method: string, url: string, headers: Record<string, string> = {}, body?: unknown): Promise<Res> {
  const h: Record<string, string> = { 'cf-connecting-ip': '203.0.113.7', ...headers };
  let payload: string | undefined;
  if (typeof body === 'string') payload = body;
  else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const req = new Request(url.startsWith('http') ? url : SITE + url, { method, headers: h, body: payload });
  // Work the Worker leaves for after the answer (a refused grant's revoke) is done before the test looks.
  const later: Promise<unknown>[] = [];
  const ctx = { waitUntil: (w: Promise<unknown>) => void later.push(w), passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env() as never, ctx);
  const text = await res.text();
  await Promise.all(later);
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: res.status, headers: res.headers, location: res.headers.get('Location') ?? '', text, data, setCookies: res.headers.getSetCookie() };
}

interface SetCookie {
  value: string;
  attrs: string[];
}

function cookiesOf(r: Res): Record<string, SetCookie> {
  const out: Record<string, SetCookie> = {};
  for (const line of r.setCookies) {
    const [pair, ...attrs] = line.split(';').map(s => s.trim());
    const eq = pair.indexOf('=');
    out[pair.slice(0, eq)] = { value: decodeURIComponent(pair.slice(eq + 1)), attrs: attrs.map(a => a.toLowerCase()) };
  }
  return out;
}

const cleared = (c: SetCookie | undefined): boolean => !!c && c.value === '' && c.attrs.includes('max-age=0');

const userRows = () =>
  db.rows<{ id: string; name: string; email: string | null; email_verified_at: string | null; apple_sub: string | null; google_sub: string | null; locale: string; currency: string }>(
    'SELECT id, name, email, email_verified_at, apple_sub, google_sub, locale, currency FROM users ORDER BY created_at, rowid',
  );
const sessionRows = () => db.rows<{ id: string; user_id: string; label: string }>('SELECT id, user_id, label FROM sessions');
const grantRows = () => db.rows<{ user_id: string; client_id: string; refresh_token: string }>('SELECT user_id, client_id, refresh_token FROM apple_grants ORDER BY client_id');
const flowRows = () =>
  db.rows<{ id: string; kind: string; user_id: string; session_id: string; state_hash: string | null }>(
    'SELECT id, kind, user_id, session_id, state_hash FROM sign_in_flows ORDER BY created_at, rowid',
  );
const pendingRows = () =>
  db.rows<{
    id: string; user_id: string; session_id: string; provider: string; sub: string; email: string | null; client_id: string | null;
    refresh_token: string | null; expires_at: string; created_at: string;
  }>('SELECT * FROM pending_links ORDER BY created_at, rowid');
/** A flow cookie as anyone can write one in their own browser: base64url JSON. */
const handMade = (name: string, o: Record<string, unknown>): string => `${name}=${b64json(o)}`;

/** An account with an email (confirmed or not) and an optional Apple ID. */
function account(id: string, email: string | null, o: { confirmed?: boolean; appleSub?: string; googleSub?: string; name?: string } = {}): string {
  const at = new Date().toISOString();
  db.exec(
    'INSERT INTO users (id, name, email, color, activity_seen_at, created_at, updated_at, email_verified_at, apple_sub, google_sub) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, o.name ?? id, email, '#2F6FB5', at, at, at, o.confirmed ? at : null, o.appleSub ?? null, o.googleSub ?? null,
  );
  return id;
}

/** A signed-in session for an account: its Bearer token and its cookie pair. */
async function signedIn(id: string): Promise<{ token: string; cookie: string; sid: string }> {
  const token = await createSession(db.d1, id, 'test');
  return { token, cookie: `${SESSION}=${token}; ${MARKER}=${id}`, sid: await sha256Hex(token) };
}

/** A flow's binding as the server keeps it: by the SHA-256 of the cookie's secret, with the state's. */
async function binding(flow: { secret: string | null; state: string }, kind: string, userId: string, sid: string) {
  return { id: await sha256Hex(flow.secret!), kind, user_id: userId, session_id: sid, state_hash: await sha256Hex(flow.state) };
}

/** The pending link a web link's callback hands 我的 ('' when the answer is not that). */
const webPending = (r: Res): string => (/^\/\?link_pending=([A-Za-z0-9_-]{43})#\/account$/.exec(r.location) ?? [])[1] ?? '';

/** GET, POST (連結) or DELETE (取消) /api/me/links/pending/<id> from the client signed in with `token`. */
const pendingLink = (method: 'GET' | 'POST' | 'DELETE', id: string, token: string): Promise<Res> =>
  call(method, API + '/api/me/links/pending/' + id, { Authorization: 'Bearer ' + token }, method === 'GET' ? undefined : {});

/** The refresh tokens sent to Apple's revoke endpoint, in order. */
const revoked = (): string[] => sent.filter(x => x.url === APPLE.revoke).map(x => new URLSearchParams(String(x.init.body)).get('token') ?? '');

/** A stored password: the routes here only ask whether there is one. */
const PW_HASH = 'pbkdf2$100000$c2FsdA$aGFzaA';

/** Put an account in a group (a members row, as joining one or a 1:1 ledger makes). */
function inGroup(userId: string): void {
  const at = new Date().toISOString();
  db.exec("INSERT INTO groups (id, name, type, currency, invite_code, created_by, created_at, updated_at) VALUES (?, 'Trip', 'trip', 'TWD', ?, ?, ?, ?)", 'g-' + userId, 'inv-' + userId, userId, at, at);
  db.exec("INSERT INTO members (id, group_id, user_id, name, color, created_at) VALUES (?, ?, ?, 'M', '#2F6FB5', ?)", 'm-' + userId, 'g-' + userId, userId, at);
}

// ---------- the iPhone app's Apple sign-in ----------

/** POST /api/auth/apple as the iPhone app sends it (no Origin, no Fetch Metadata, its User-Agent). */
async function nativeSignIn(o: { name?: string | null; locale?: string; nonce?: string; tokenNonce?: string; aud?: string; currency?: unknown } = {}): Promise<Res> {
  const token = await identityToken(o.aud ?? APP_ID, o.tokenNonce ?? (await sha256Hex(RAW_NONCE)));
  const body: Record<string, unknown> = { identityToken: token, authorizationCode: 'c.authorization-code-1', nonce: o.nonce ?? RAW_NONCE, locale: o.locale ?? 'zh-TW' };
  if (o.name !== undefined) body.name = o.name;
  if (o.currency !== undefined) body.currency = o.currency;
  return call('POST', API + '/api/auth/apple', { 'User-Agent': APP_UA }, body);
}

describe('the identity token', () => {
  const nonce = 'n'.repeat(43);

  it('a good one names the Apple ID, the verified email and whether it is a relay address', async () => {
    const who = await verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce });
    expect(who).toEqual({ sub: SUB, email: RELAY, relay: true });
    claimsEdit = c => ({ ...c, email: 'Gino.Chang@iCloud.com', email_verified: true, is_private_email: false });
    expect(await verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce })).toEqual({ sub: SUB, email: 'gino.chang@icloud.com', relay: false });
    // Strings or booleans, both forms Apple writes.
    claimsEdit = c => ({ ...c, email: 'leo@example.org', email_verified: 'true', is_private_email: 'false' });
    expect((await verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce })).relay).toBe(false);
  });

  it('an email Apple has not verified (Sign in with Apple at Work & School) counts as none; no email is none', async () => {
    for (const edit of [{ email_verified: 'false' }, { email_verified: false }, { email_verified: undefined }, { email: undefined }]) {
      claimsEdit = c => ({ ...c, ...edit, is_private_email: undefined });
      const who = await verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce });
      expect(who.email, JSON.stringify(edit)).toBeNull();
    }
  });

  it('refuses the wrong audience: the web Services ID is not the app, nor the other way', async () => {
    await expect(verifyAppleToken(await identityToken(SERVICES_ID, nonce), { clientId: APP_ID, nonce })).rejects.toMatchObject({ code: 'failed', detail: 'identity token aud' });
    await expect(verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: SERVICES_ID, nonce })).rejects.toMatchObject({ code: 'failed', detail: 'identity token aud' });
  });

  it('refuses another issuer', async () => {
    claimsEdit = c => ({ ...c, iss: 'https://appleid.apple.com.evil.test' });
    await expect(verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce })).rejects.toMatchObject({ code: 'failed', detail: 'identity token iss' });
    claimsEdit = c => ({ ...c, iss: 'appleid.apple.com' });
    await expect(verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce })).rejects.toMatchObject({ detail: 'identity token iss' });
  });

  it('refuses an expired token (a minute of clock skew is fine), and one issued in the future', async () => {
    const now = Math.floor(Date.now() / 1000);
    claimsEdit = c => ({ ...c, iat: now - 700, exp: now - 61 });
    await expect(verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce })).rejects.toMatchObject({ detail: 'identity token expired' });
    claimsEdit = c => ({ ...c, iat: now - 700, exp: now - 30 });
    await expect(verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce })).resolves.toMatchObject({ sub: SUB });
    claimsEdit = c => ({ ...c, exp: undefined });
    await expect(verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce })).rejects.toMatchObject({ detail: 'identity token expired' });
    claimsEdit = c => ({ ...c, iat: now + 3600, exp: now + 7200 });
    await expect(verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce })).rejects.toMatchObject({ detail: 'identity token iat' });
  });

  it('refuses a nonce that is not the one expected, or none', async () => {
    await expect(verifyAppleToken(await identityToken(APP_ID, 'm'.repeat(43)), { clientId: APP_ID, nonce })).rejects.toMatchObject({ detail: 'identity token nonce' });
    claimsEdit = c => ({ ...c, nonce: undefined });
    await expect(verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce })).rejects.toMatchObject({ detail: 'identity token nonce' });
  });

  it('refuses a bad signature: a key Apple does not publish under that id, an edited payload, alg none, not a JWT', async () => {
    signWith = () => forger;
    await expect(verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce })).rejects.toMatchObject({ detail: 'identity token signature' });
    signWith = () => apple;
    const [h, , sig] = (await identityToken(APP_ID, nonce)).split('.');
    const edited = `${h}.${b64json({ ...appleClaims(APP_ID, nonce), sub: 'someone.else' })}.${sig}`;
    await expect(verifyAppleToken(edited, { clientId: APP_ID, nonce })).rejects.toMatchObject({ detail: 'identity token signature' });
    const none = `${b64json({ alg: 'none', kid: apple.kid })}.${b64json(appleClaims(APP_ID, nonce))}.`;
    await expect(verifyAppleToken(none, { clientId: APP_ID, nonce })).rejects.toMatchObject({ detail: 'identity token header' });
    await expect(verifyAppleToken('not.a.jwt!', { clientId: APP_ID, nonce })).rejects.toMatchObject({ detail: 'identity token is not a JWT' });
  });

  it("keeps Apple's keys (they say no-store) and fetches them again for an unknown key id, at most once a minute", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T20:00:00Z'));
    await verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce });
    await verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce });
    const fetches = () => sent.filter(x => x.url === APPLE.keys).length;
    expect(fetches()).toBe(1);
    // Apple rotates: a token signed with a key the kept set lacks.
    const next = await makeSigner('apple-key-2');
    appleKeys = () => [apple.jwk, next.jwk];
    signWith = () => next;
    // Within a minute of the last fetch, an unknown id is a made-up one: no fetch.
    await expect(verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce })).rejects.toMatchObject({ detail: 'identity token key unknown' });
    expect(fetches()).toBe(1);
    vi.setSystemTime(new Date('2026-10-29T20:02:00Z'));
    await expect(verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce })).resolves.toMatchObject({ sub: SUB });
    expect(fetches()).toBe(2);
    // A day later the set is fetched again even for a known id.
    vi.setSystemTime(new Date('2026-10-30T20:03:00Z'));
    await verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce });
    expect(fetches()).toBe(3);
  });

  it('keys Apple does not answer are unavailable, not a bad token', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
    await expect(verifyAppleToken(await identityToken(APP_ID, nonce), { clientId: APP_ID, nonce })).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('the client secret', () => {
  it('is an ES256 JWT: kid the key id; iss the team, sub the client, aud Apple, five minutes to live; signed with the key', async () => {
    const signing = (await appleSigning(env()))!;
    expect(signing).not.toBeNull();
    const at = Date.parse('2026-10-29T20:00:00Z');
    const jwt = await appleClientSecret(signing, SERVICES_ID, at);
    const [h, c, sig] = jwt.split('.');
    expect(unb64(h)).toEqual({ alg: 'ES256', kid: KEY_ID });
    const iat = at / 1000;
    expect(unb64(c)).toEqual({ iss: TEAM, iat, exp: iat + 300, aud: 'https://appleid.apple.com', sub: SERVICES_ID });
    expect(CLIENT_SECRET_TTL_SEC).toBe(300);
    const raw = Buffer.from(sig, 'base64url');
    expect(raw.length).toBe(64);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keyPublic, raw, new TextEncoder().encode(h + '.' + c))).toBe(true);
  });

  it('no key, no id, an id that is not Apple\'s, or a key that is not a P-256 PEM: Apple is not set up', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const v of [{ APPLE_SIGNIN_KEY: undefined }, { APPLE_SIGNIN_KEY_ID: '' }, { APPLE_SIGNIN_KEY_ID: 'short' }, { APPLE_SIGNIN_KEY: 'not a key' }, { APPLE_TEAM_ID: undefined }]) {
      vars = v;
      expect(await appleSigning(env()), JSON.stringify(v)).toBeNull();
    }
    // What is logged names the variable, never the key.
    const logged = error.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('APPLE_SIGNIN_KEY_ID is not an Apple key id');
    expect(logged).not.toContain('PRIVATE KEY');
  });
});

describe('the iPhone app signs in with Apple (POST /api/auth/apple)', () => {
  it('a new Apple ID makes an account: the relay email confirmed, the name the app passed, the language, a Bearer session, the grant kept', async () => {
    const before = Date.now();
    const r = await nativeSignIn({ name: '  張俊儒 ', locale: 'zh-TW' });
    expect(r.status, r.text).toBe(200);
    expect(r.data.arrival).toBe('new');
    expect(r.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.data.user).toMatchObject({ name: '張俊儒', email: RELAY, emailVerified: true, appleLinked: true, googleLinked: false, hasPassword: false, locale: 'zh-TW', currency: 'TWD' });
    const [u] = userRows();
    expect(u).toMatchObject({ name: '張俊儒', email: RELAY, apple_sub: SUB });
    expect(Date.parse(u.email_verified_at!)).toBeGreaterThanOrEqual(before - 1000);
    // A Bearer session like the app's other sign-ins (no cookies: not same-origin), labeled from the User-Agent.
    expect(r.setCookies).toEqual([]);
    expect(sessionRows()).toEqual([{ id: await sha256Hex(r.data.token), user_id: u.id, label: 'iPhone' }]);
    expect(grantRows()).toEqual([{ user_id: u.id, client_id: APP_ID, refresh_token: 'r.refresh-1' }]);
    // The code exchange: the app's client id, a client secret for it, the code, no redirect_uri.
    const ex = sent.filter(x => x.url === APPLE.token);
    expect(ex).toHaveLength(1);
    expect(ex[0].init.method).toBe('POST');
    expect(ex[0].init.redirect).toBe('manual');
    const form = Object.fromEntries(new URLSearchParams(String(ex[0].init.body)));
    expect(Object.keys(form).sort()).toEqual(['client_id', 'client_secret', 'code', 'grant_type']);
    expect(form).toMatchObject({ client_id: APP_ID, code: 'c.authorization-code-1', grant_type: 'authorization_code' });
    expect(unb64(form.client_secret.split('.')[1])).toMatchObject({ sub: APP_ID, iss: TEAM });
    // The token works and says Apple is linked.
    const me = await call('GET', API + '/api/me', { Authorization: 'Bearer ' + r.data.token });
    expect(me.data.user).toMatchObject({ id: u.id, appleLinked: true });
  });

  it('without a name from Apple: a relay address gives 「Apple 使用者」 or "Apple user", a real one its part before the @', async () => {
    const zh = await nativeSignIn({ locale: 'zh-TW' });
    expect(zh.data.user.name).toBe('Apple 使用者');
    db = new TestD1();
    const en = await nativeSignIn({ locale: 'en', name: null });
    expect(en.data.user).toMatchObject({ name: 'Apple user', locale: 'en', currency: 'USD' });
    db = new TestD1();
    claimsEdit = c => ({ ...c, email: 'gino.chang@icloud.com', is_private_email: 'false' });
    expect((await nativeSignIn({ name: '   ' })).data.user.name).toBe('gino.chang');
    expect(appleName({ name: 'a'.repeat(70), email: RELAY, relay: true, locale: 'en' })).toBe('a'.repeat(60));
    // A relay address without the claim is still known by its domain.
    expect(appleName({ name: '', email: RELAY, relay: false, locale: 'zh-TW' })).toBe('x7k2m9q4p1');
  });

  it('the Apple ID linked to an account signs in to it again (back), with any email or none, and keeps its name', async () => {
    const first = await nativeSignIn({ name: 'Gino Chang' });
    const id = first.data.user.id;
    db.exec('UPDATE users SET name = ?, email = ? WHERE id = ?', 'Gino', 'gino@other.test', id);
    claimsEdit = c => ({ ...c, email: undefined, email_verified: undefined });
    const again = await nativeSignIn({ name: 'Someone Else' });
    expect(again.status).toBe(200);
    expect(again.data).toMatchObject({ arrival: 'back', user: { id, name: 'Gino', email: 'gino@other.test' } });
    expect(userRows()).toHaveLength(1);
    // The newer grant replaces the older one for the same client.
    expect(grantRows()).toEqual([{ user_id: id, client_id: APP_ID, refresh_token: 'r.refresh-2' }]);
  });

  it('the account with the email, confirmed or not, gets linked (linked) and its email confirmed; its name stays', async () => {
    account('gino', 'gino.chang@icloud.com', { name: 'Gino 吉諾' });
    claimsEdit = c => ({ ...c, email: 'Gino.Chang@iCloud.com', is_private_email: false });
    const r = await nativeSignIn({ name: 'Other Name' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ arrival: 'linked', user: { id: 'gino', name: 'Gino 吉諾', email: 'gino.chang@icloud.com', emailVerified: true, appleLinked: true } });
    const [u] = userRows();
    expect(u.apple_sub).toBe(SUB);
    expect(u.email_verified_at).not.toBeNull();
    expect((await nativeSignIn()).data.arrival).toBe('back');
  });

  it('an account with the email and another Apple ID is refused (409 linked_other); nothing changes, no session', async () => {
    account('gino', RELAY, { confirmed: true, appleSub: '000999.ffff.0001' });
    const r = await nativeSignIn();
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('linked_other');
    expect(userRows()[0].apple_sub).toBe('000999.ffff.0001');
    expect(sessionRows()).toEqual([]);
    expect(grantRows()).toEqual([]);
  });

  it('no usable email and no linked account: 409 no_email, logged', async () => {
    const warn = vi.mocked(console.warn);
    claimsEdit = c => ({ ...c, email: undefined, email_verified: undefined, is_private_email: undefined });
    const r = await nativeSignIn();
    expect(r.status).toBe(409);
    expect(r.data.error.code).toBe('no_email');
    expect(userRows()).toEqual([]);
    expect(warn.mock.calls.flat().map(String).join('\n')).toContain('no usable email');
  });

  it('the nonce: the token must carry the SHA-256 hex of the raw nonce the app sends (401 apple_invalid otherwise)', async () => {
    const r = await nativeSignIn({ tokenNonce: RAW_NONCE });
    expect(r.status).toBe(401);
    expect(r.data.error.code).toBe('apple_invalid');
    const other = await nativeSignIn({ nonce: RAW_NONCE + 'x' });
    expect(other.data.error.code).toBe('apple_invalid');
    // A token for the web's Services ID is not the app's.
    expect((await nativeSignIn({ aud: SERVICES_ID })).data.error.code).toBe('apple_invalid');
    expect(userRows()).toEqual([]);
    // Nothing was exchanged for a token that failed.
    expect(sent.filter(x => x.url === APPLE.token)).toEqual([]);
  });

  it('the exchange is required: Apple refusing or not answering is 503 apple_unavailable, and nothing is made', async () => {
    tokenAnswer = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
    const r = await nativeSignIn();
    expect(r.status).toBe(503);
    expect(r.data.error.code).toBe('apple_unavailable');
    tokenAnswer = async () => {
      throw new TypeError('network down');
    };
    expect((await nativeSignIn()).data.error.code).toBe('apple_unavailable');
    tokenAnswer = async () => Response.json({ access_token: 'a' });
    expect((await nativeSignIn()).data.error.code).toBe('apple_unavailable');
    expect(userRows()).toEqual([]);
    expect(sessionRows()).toEqual([]);
  });

  it("the exchanged id_token must name the same Apple ID (401 apple_invalid)", async () => {
    exchangedSub = '000111.other.0002';
    const r = await nativeSignIn();
    expect(r.status).toBe(401);
    expect(r.data.error.code).toBe('apple_invalid');
    expect(userRows()).toEqual([]);
  });

  it('not set up (no key): 503 apple_unavailable, and Apple is asked nothing', async () => {
    vars = { APPLE_SIGNIN_KEY: undefined };
    const r = await nativeSignIn();
    expect(r.status).toBe(503);
    expect(r.data.error.code).toBe('apple_unavailable');
    expect(sent).toEqual([]);
  });

  it('a body that is not the credential: 400 validation', async () => {
    for (const body of [{}, { identityToken: 'x', authorizationCode: 'y' }, { identityToken: 'x', authorizationCode: 'y', nonce: 'short' }, { identityToken: 1, authorizationCode: 'y', nonce: RAW_NONCE }]) {
      const r = await call('POST', API + '/api/auth/apple', {}, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.data.error.code).toBe('validation');
    }
  });

  it('at most APPLE_IP_PER_15M an IP in 15 minutes (default 20): 429 with Retry-After', async () => {
    vars = { APPLE_IP_PER_15M: '2' };
    await nativeSignIn();
    await nativeSignIn();
    const third = await nativeSignIn();
    expect(third.status).toBe(429);
    expect(third.data.error.code).toBe('rate_limited');
    expect(Number(third.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('logs only what failed: never a token, the code, the nonce or an address', async () => {
    const warn = vi.mocked(console.warn);
    tokenAnswer = async () => Response.json({ error: 'invalid_grant', error_description: 'code c.authorization-code-1 for ' + RELAY }, { status: 400 });
    await nativeSignIn();
    await nativeSignIn({ tokenNonce: 'wrong' });
    const logged = warn.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('invalid_grant');
    for (const secret of ['c.authorization-code-1', RELAY, RAW_NONCE, 'eyJ', SUB]) expect(logged).not.toContain(secret);
  });
});

// ---------- providers ----------

describe('GET /api/auth/providers', () => {
  it('the web: apple true with the key and the Services ID, on APP_URL\'s site only', async () => {
    expect((await call('GET', '/api/auth/providers')).data).toEqual({ google: true, apple: true });
    expect((await call('GET', API + '/api/auth/providers')).data).toEqual({ google: false, apple: false });
    vars = { APPLE_SERVICES_ID: '' };
    expect((await call('GET', '/api/auth/providers')).data).toEqual({ google: true, apple: false });
    vars = { APPLE_SIGNIN_KEY: undefined };
    expect((await call('GET', '/api/auth/providers')).data).toEqual({ google: true, apple: false });
  });

  it('the iPhone app (?client=ios): Apple when the key is loaded; Google only together with it, its start on APP_URL\'s origin', async () => {
    const r = await call('GET', API + '/api/auth/providers?client=ios');
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ google: true, apple: true, googleStartUrl: SITE + '/api/auth/google/start' });
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    vars = { GOOGLE_CLIENT_SECRET: undefined, APPLE_APP_ID: undefined };
    expect((await call('GET', API + '/api/auth/providers?client=ios')).data).toEqual({ google: false, apple: false, googleStartUrl: null });
    // Google set up and Apple not: no Google either (App Review 4.8 asks for Apple next to it).
    vars = { APPLE_SIGNIN_KEY: undefined };
    expect((await call('GET', API + '/api/auth/providers?client=ios')).data).toEqual({ google: false, apple: false, googleStartUrl: null });
    vars = { GOOGLE_CLIENT_SECRET: undefined };
    expect((await call('GET', API + '/api/auth/providers?client=ios')).data).toEqual({ google: false, apple: true, googleStartUrl: null });
    vars = { APPLE_SIGNIN_KEY: 'not a key' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await call('GET', API + '/api/auth/providers?client=ios')).data).toMatchObject({ google: false, apple: false });
  });
});

// ---------- Google in the iPhone app ----------

/** The app's PKCE pair. */
const VERIFIER = 'app-verifier-' + 'v'.repeat(40);

/**
 * The iPhone app's start in ASWebAuthenticationSession; `session`: its session token as
 * additionalHeaderFields sends it, X-Evenly-Session (`bearer`: as Authorization, as builds before it).
 */
async function iosStart(query?: string, session?: string, header: 'x' | 'bearer' = 'x'): Promise<{ res: Res; cookie: string; nonce: string; state: string }> {
  const q = query ?? `?client=ios&challenge=${await pkceChallenge(VERIFIER)}&locale=en`;
  // ASWebAuthenticationSession opens the URL itself: no Sec-Fetch-Site, no Referer.
  const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15' };
  if (session && header === 'x') headers['X-Evenly-Session'] = session;
  if (session && header === 'bearer') headers.Authorization = 'Bearer ' + session;
  const res = await call('GET', '/api/auth/google/start' + q, headers);
  const c = cookiesOf(res)[GOOGLE_FLOW];
  const flow = c ? decodeFlow(c.value) : null;
  return { res, cookie: c ? `${GOOGLE_FLOW}=${c.value}` : '', nonce: flow?.nonce ?? '', state: res.location ? new URL(res.location).searchParams.get('state') ?? '' : '' };
}

async function iosCallback(s: { cookie: string; nonce: string; state: string }, query?: string): Promise<Res> {
  googleNonce = s.nonce;
  return call('GET', '/api/auth/google/callback' + (query ?? `?state=${encodeURIComponent(s.state)}&code=4%2F0Acode`), {
    'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', ...(s.cookie ? { Cookie: s.cookie } : {}),
  });
}

/** What the app's way back carries when `key` is all its query holds ('' when the answer is not that). */
function backTo(r: Res, key: 'code' | 'pending' | 'error'): string {
  if (!r.location.startsWith(IOS_CALLBACK + '?')) return '';
  const q = new URLSearchParams(r.location.slice(IOS_CALLBACK.length + 1));
  const v = q.get(key) ?? '';
  if ([...q.keys()].join(',') !== key) return '';
  return (key === 'error' ? /^[a-z_]+$/ : /^[A-Za-z0-9_-]{43}$/).test(v) ? v : '';
}
const appCode = (r: Res): string => backTo(r, 'code');
const appPending = (r: Res): string => backTo(r, 'pending');
const appError = (r: Res): string => backTo(r, 'error');

const exchange = (code: string, verifier = VERIFIER) => call('POST', API + '/api/auth/google/exchange', { 'User-Agent': APP_UA }, { code, verifier });
const signInCodes = () =>
  db.rows<{ id: string; challenge: string; identity: string; expires_at: string; used_at: string | null; created_at: string }>('SELECT * FROM google_sign_in_codes');

describe('Google in the iPhone app', () => {
  it('the start needs no same-origin page: it keeps client, challenge and currency in the flow and marks the state', async () => {
    const s = await iosStart(`?client=ios&challenge=${await pkceChallenge(VERIFIER)}&locale=en&currency=jpy`);
    expect(s.res.status).toBe(302);
    expect(s.res.location.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    const flow = decodeFlow(cookiesOf(s.res)[GOOGLE_FLOW].value)!;
    expect(flow).toMatchObject({ client: 'ios', challenge: await pkceChallenge(VERIFIER), locale: 'en', currency: 'JPY', link: false });
    expect(flowRows()).toEqual([]);
    expect(s.state).toBe('i.' + flow.state);
    // Google's own PKCE uses the Worker's verifier, not the app's; the cookie's secret goes nowhere.
    expect(new URL(s.res.location).searchParams.get('code_challenge')).toBe(await pkceChallenge(flow.verifier));
    expect(s.res.location).not.toContain(flow.secret!);
  });

  it('a start without a challenge, or with a malformed one, ends at the app\'s way back with error=start; unavailable likewise', async () => {
    for (const q of ['?client=ios', '?client=ios&challenge=short', `?client=ios&challenge=${'a'.repeat(44)}`]) {
      const r = await call('GET', '/api/auth/google/start' + q);
      expect(r.status, q).toBe(302);
      expect(r.location, q).toBe(IOS_CALLBACK + '?error=start');
      expect(cookiesOf(r)[GOOGLE_FLOW]).toBeUndefined();
    }
    vars = { GOOGLE_CLIENT_SECRET: undefined };
    expect(appError((await iosStart()).res)).toBe('unavailable');
  });

  it('the callback hands the app a one-time code with what Google verified, and changes nothing: no account, no session, no cookie', async () => {
    const s = await iosStart();
    const cb = await iosCallback(s);
    expect(cb.status).toBe(302);
    const code = appCode(cb);
    expect(code, cb.location).not.toBe('');
    expect(cookiesOf(cb)[SESSION]).toBeUndefined();
    expect(cleared(cookiesOf(cb)[GOOGLE_FLOW])).toBe(true);
    expect(cb.headers.get('Referrer-Policy')).toBe('no-referrer');
    // No account is found or made before the exchange: a code nobody exchanges changes nothing.
    expect(userRows()).toEqual([]);
    expect(sessionRows()).toEqual([]);
    // Kept as SHA-256 only, for 5 minutes, with the challenge and the verified identity.
    const rows = signInCodes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: await sha256Hex(code), challenge: await pkceChallenge(VERIFIER), used_at: null });
    expect(JSON.parse(rows[0].identity)).toEqual({ sub: G_SUB, email: 'abbie.lin@gmail.com', givenName: 'Abbie', name: 'Abbie Lin', locale: 'en', currency: null });
    expect(Date.parse(rows[0].expires_at) - Date.parse(rows[0].created_at)).toBe(300_000);
    expect(db.rows('SELECT 1 FROM google_app_codes')).toEqual([]);
  });

  it('the exchange with the verifier signs in: the account found or made only then, in the start\'s language and currency', async () => {
    const s = await iosStart(`?client=ios&challenge=${await pkceChallenge(VERIFIER)}&locale=en&currency=EUR`);
    const r = await exchange(appCode(await iosCallback(s)));
    expect(r.status, r.text).toBe(200);
    expect(r.data.arrival).toBe('new');
    expect(r.data.notice).toBeUndefined();
    expect(r.data.user).toMatchObject({ name: 'Abbie', email: 'abbie.lin@gmail.com', emailVerified: true, googleLinked: true, appleLinked: false, locale: 'en', currency: 'EUR' });
    expect(sessionRows()).toEqual([{ id: await sha256Hex(r.data.token), user_id: r.data.user.id, label: 'iPhone' }]);
    expect(r.setCookies).toEqual([]);
    expect(signInCodes()[0].used_at).not.toBeNull();
    // The same Google account next time: back.
    const again = await exchange(appCode(await iosCallback(await iosStart())));
    expect(again.data).toMatchObject({ arrival: 'back', user: { id: r.data.user.id } });
    // A currency that is not a known code: the language's.
    db = new TestD1();
    const zh = await iosStart(`?client=ios&challenge=${await pkceChallenge(VERIFIER)}&locale=zh-TW&currency=ZZZ`);
    expect((await exchange(appCode(await iosCallback(zh)))).data.user).toMatchObject({ locale: 'zh-TW', currency: 'TWD' });
  });

  it('a code works once: the second exchange is 401 code_invalid', async () => {
    const code = appCode(await iosCallback(await iosStart()));
    expect((await exchange(code)).status).toBe(200);
    const second = await exchange(code);
    expect(second.status).toBe(401);
    expect(second.data.error.code).toBe('code_invalid');
  });

  it('a wrong verifier is 401 code_invalid and spends the code; an unknown code too; no account is made', async () => {
    const code = appCode(await iosCallback(await iosStart()));
    const wrong = await exchange(code, 'another-verifier-' + 'w'.repeat(40));
    expect(wrong.status).toBe(401);
    expect(wrong.data.error.code).toBe('code_invalid');
    expect((await exchange(code)).status).toBe(401);
    expect((await exchange('x'.repeat(43))).status).toBe(401);
    expect((await exchange(code.slice(0, 20), 'short')).status).toBe(401);
    expect(sessionRows()).toEqual([]);
    expect(userRows()).toEqual([]);
  });

  it('a code older than 5 minutes is 401 code_invalid, and the daily cleanup deletes it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T20:00:00Z'));
    const code = appCode(await iosCallback(await iosStart()));
    vi.setSystemTime(new Date('2026-10-29T20:05:01Z'));
    expect((await exchange(code)).status).toBe(401);
    expect(userRows()).toEqual([]);
    expect(signInCodes()).toHaveLength(1);
    await db.d1.batch(cleanupStmts(db.d1, new Date()) as never);
    expect(signInCodes()).toEqual([]);
  });

  it('errors end at the app\'s way back: Google said no (denied), the cookie gone (state, by the state\'s mark)', async () => {
    const s = await iosStart();
    expect(appError(await iosCallback(s, `?error=access_denied&state=${encodeURIComponent(s.state)}`))).toBe('denied');
    const t = await iosStart();
    expect(appError(await iosCallback({ ...t, cookie: '' }))).toBe('state');
    expect(signInCodes()).toEqual([]);
  });

  it('linked_other comes from the exchange (409), which changes nothing', async () => {
    account('abbie', 'abbie.lin@gmail.com', { googleSub: '111111111111111111111' });
    const code = appCode(await iosCallback(await iosStart()));
    expect(code).not.toBe('');
    const r = await exchange(code);
    expect([r.status, r.data.error.code]).toEqual([409, 'linked_other']);
    expect(userRows().map(u => [u.id, u.google_sub])).toEqual([['abbie', '111111111111111111111']]);
    expect(sessionRows()).toEqual([]);
  });

  it('no email an account can have ends in the app (unverified, failed), unless an account is linked to the Google account', async () => {
    googleClaims = n => ({ ...goodGoogleClaims(n), email_verified: false });
    expect(appError(await iosCallback(await iosStart()))).toBe('unverified');
    googleClaims = n => ({ ...goodGoogleClaims(n), email: 'a'.repeat(120) + '@gmail.com' });
    expect(appError(await iosCallback(await iosStart()))).toBe('failed');
    expect(signInCodes()).toEqual([]);
    // Linked from 我的 earlier: the link is what counts.
    account('abbie', null, { googleSub: G_SUB });
    for (const edit of [{ email_verified: false }, { email: 'a'.repeat(120) + '@gmail.com' }]) {
      googleClaims = n => ({ ...goodGoogleClaims(n), ...edit });
      const r = await exchange(appCode(await iosCallback(await iosStart())));
      expect(r.status, JSON.stringify(edit)).toBe(200);
      expect(r.data).toMatchObject({ arrival: 'back', user: { id: 'abbie' } });
    }
  });

  it('the web flow is unchanged: no mark on its state, cookies, the app at its page', async () => {
    const r = await call('GET', '/api/auth/google/start?return=%2F&locale=en', { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate' });
    const flow = decodeFlow(cookiesOf(r)[GOOGLE_FLOW].value)!;
    expect(flow).toMatchObject({ client: 'web', challenge: null, link: false });
    expect(new URL(r.location).searchParams.get('state')).toBe(flow.state);
  });
});

// ---------- the web's Sign in with Apple ----------

const FROM_APP = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };

interface AppleStarted {
  res: Res;
  cookie: string;
  state: string;
  nonce: string;
}

async function webStart(query = '?return=%2Fjoin%2Fabc&locale=en', headers: Record<string, string> = FROM_APP): Promise<AppleStarted> {
  const res = await call('GET', '/api/auth/apple/start' + query, headers);
  const c = cookiesOf(res)[APPLE_FLOW];
  const flow = c ? decodeAppleFlow(c.value) : null;
  return { res, cookie: c ? `${APPLE_FLOW}=${c.value}` : '', state: res.location.startsWith(APPLE.authorize) ? new URL(res.location).searchParams.get('state') ?? '' : '', nonce: flow?.nonce ?? '' };
}

/** Apple's form post back: a cross-site POST that carries only the SameSite=None flow cookie. */
async function webCallback(s: AppleStarted, fields?: Record<string, string>, o: { cookie?: string } = {}): Promise<Res> {
  const f = fields ?? { state: s.state, code: 'c.web-code-1', id_token: await identityToken(SERVICES_ID, s.nonce) };
  const cookie = o.cookie ?? s.cookie;
  return call(
    'POST',
    '/api/auth/apple/callback',
    {
      'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://appleid.apple.com', Referer: 'https://appleid.apple.com/',
      'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', ...(cookie ? { Cookie: cookie } : {}),
    },
    new URLSearchParams(f).toString(),
  );
}

const webError = (r: Res): string => (/^\/\?apple_error=([a-z_]+)#\/login$/.exec(r.location) ?? [])[1] ?? '';

describe('the web: Sign in with Apple', () => {
  it('the start keeps the flow in an HttpOnly, Secure, SameSite=None __Host- cookie for 10 minutes and sends the browser to Apple', async () => {
    const s = await webStart();
    expect(s.res.status).toBe(302);
    const c = cookiesOf(s.res)[APPLE_FLOW];
    expect(c.attrs).toEqual(expect.arrayContaining([`max-age=${APPLE_FLOW_TTL_SEC}`, 'path=/', 'httponly', 'secure', 'samesite=none']));
    expect(APPLE_FLOW_TTL_SEC).toBe(600);
    expect(c.attrs.some(a => a.startsWith('domain'))).toBe(false);
    expect(Object.keys(cookiesOf(s.res))).toEqual([APPLE_FLOW]);
    const u = new URL(s.res.location);
    expect(u.origin + u.pathname).toBe(APPLE.authorize);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: SERVICES_ID,
      redirect_uri: SITE + '/api/auth/apple/callback',
      response_type: 'code id_token',
      response_mode: 'form_post',
      scope: 'name email',
      state: s.state,
      nonce: s.nonce,
    });
    // Spaces as %20, as Apple writes them.
    expect(s.res.location).toContain('response_type=code%20id_token');
    expect(s.res.location).toContain('scope=name%20email');
    expect(sent).toEqual([]);
  });

  it('only from a page of this app, only where it is set up, and at most APPLE_IP_PER_15M starts', async () => {
    const other = await webStart('?return=%2F', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' });
    expect(webError(other.res)).toBe('start');
    vars = { APPLE_SIGNIN_KEY: undefined };
    expect(webError((await webStart()).res)).toBe('unavailable');
    const elsewhere = await call('GET', API + '/api/auth/apple/start?return=%2F', FROM_APP);
    expect(elsewhere.location).toBe('/?apple_error=unavailable#/login');
    vars = { APPLE_IP_PER_15M: '1' };
    await webStart();
    expect(webError((await webStart()).res)).toBe('rate_limited');
  });

  it('the callback: a new account named from the user JSON, the session in both cookies, the flow cleared, the app at its page', async () => {
    const s = await webStart('?return=%2Fjoin%2Fabc&locale=en');
    const r = await webCallback(s, {
      state: s.state, code: 'c.web-code-1', id_token: await identityToken(SERVICES_ID, s.nonce),
      user: JSON.stringify({ name: { firstName: 'Gino', lastName: 'Chang' }, email: RELAY }),
    });
    expect(r.status).toBe(303);
    expect(r.location).toBe('/?apple=new#/join/abc');
    expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');
    const [u] = userRows();
    expect(u).toMatchObject({ name: 'Gino Chang', email: RELAY, apple_sub: SUB, locale: 'en', currency: 'USD' });
    const c = cookiesOf(r);
    expect(cleared(c[APPLE_FLOW])).toBe(true);
    expect(c[APPLE_FLOW].attrs).toContain('samesite=none');
    expect(c[SESSION].attrs).toEqual(expect.arrayContaining(['httponly', 'secure', 'samesite=lax', 'path=/']));
    expect(c[MARKER].value).toBe(u.id);
    expect(sessionRows().map(x => x.id)).toEqual([await sha256Hex(c[SESSION].value)]);
    // The web's grant is the Services ID's; its exchange named the same redirect_uri.
    expect(grantRows()).toEqual([{ user_id: u.id, client_id: SERVICES_ID, refresh_token: 'r.refresh-1' }]);
    const form = Object.fromEntries(new URLSearchParams(String(sent.find(x => x.url === APPLE.token)!.init.body)));
    expect(form).toMatchObject({ client_id: SERVICES_ID, code: 'c.web-code-1', grant_type: 'authorization_code', redirect_uri: SITE + '/api/auth/apple/callback' });
    expect(unb64(form.client_secret.split('.')[1])).toMatchObject({ sub: SERVICES_ID });
  });

  it('the user JSON\'s name: family first in Chinese script; none or not JSON falls back as in the app', async () => {
    expect(nameFromAppleUser(JSON.stringify({ name: { firstName: '俊儒', lastName: '張' } }))).toBe('張俊儒');
    expect(nameFromAppleUser(JSON.stringify({ name: { firstName: 'Gino', lastName: 'Chang' } }))).toBe('Gino Chang');
    expect(nameFromAppleUser(JSON.stringify({ name: { firstName: 'Gino' } }))).toBe('Gino');
    for (const bad of [null, '', 'not json', '[]', '{"name": 3}', JSON.stringify({ email: RELAY })]) expect(nameFromAppleUser(bad)).toBe('');
    expect(formatPersonName(' 張 ', '')).toBe('張');
    const s = await webStart('?locale=zh-TW');
    await webCallback(s, { state: s.state, code: 'c', id_token: await identityToken(SERVICES_ID, s.nonce), user: '{"name":{"firstName":"俊儒","lastName":"張"}}' });
    expect(userRows()[0].name).toBe('張俊儒');
    db = new TestD1();
    const t = await webStart('?locale=zh-TW');
    await webCallback(t);
    expect(userRows()[0].name).toBe('Apple 使用者');
  });

  it('a state that is not the flow\'s, or no flow cookie (its SameSite=None is what lets it ride), is state; Apple is not asked', async () => {
    const s = await webStart();
    const r = await webCallback(s, { state: 'x'.repeat(43), code: 'c', id_token: await identityToken(SERVICES_ID, s.nonce) });
    expect(r.status).toBe(303);
    expect(webError(r)).toBe('state');
    // Another site's post with another state leaves the flow, so the real answer still signs in.
    expect(cookiesOf(r)[APPLE_FLOW]).toBeUndefined();
    const other = await webCallback(s, { state: 'x'.repeat(43), error: 'user_cancelled_authorize' });
    expect(cookiesOf(other)[APPLE_FLOW]).toBeUndefined();
    expect(sent.filter(x => x.url === APPLE.token)).toEqual([]);
    const real = await webCallback(s);
    expect(real.location).toBe('/?apple=new#/join/abc');
    expect(cleared(cookiesOf(real)[APPLE_FLOW])).toBe(true);
    db = new TestD1();
    sent = [];
    expect(webError(await webCallback(s, undefined, { cookie: '' }))).toBe('state');
    // A state marked for the iPhone app's Google flow still answers on the web.
    expect(webError(await webCallback(s, { state: 'i.' + 'x'.repeat(43), code: 'c', id_token: 'a.b.c' }, { cookie: '' }))).toBe('state');
    expect(userRows()).toEqual([]);
    expect(sent.filter(x => x.url === APPLE.token)).toEqual([]);
  });

  it('the person said no (denied), Apple\'s other errors (failed), a bad identity token (failed), the exchange failing (unavailable)', async () => {
    const s = await webStart();
    expect(webError(await webCallback(s, { state: s.state, error: 'user_cancelled_authorize' }))).toBe('denied');
    const t = await webStart();
    expect(webError(await webCallback(t, { state: t.state, error: 'invalid_request' }))).toBe('failed');
    const u = await webStart();
    expect(webError(await webCallback(u, { state: u.state, code: 'c', id_token: await identityToken(APP_ID, u.nonce) }))).toBe('failed');
    const v = await webStart();
    tokenAnswer = async () => Response.json({ error: 'invalid_client' }, { status: 400 });
    expect(webError(await webCallback(v))).toBe('unavailable');
    expect(userRows()).toEqual([]);
  });

  it('replaces the session the browser held at the start, which Apple\'s cross-site POST does not carry', async () => {
    account('old', 'old@split.test', { confirmed: true });
    const old = await signedIn('old');
    const s = await webStart('?return=%2F', { ...FROM_APP, Cookie: old.cookie });
    // Kept on the server by the SHA-256 of the cookie's secret, which Apple never sees, with the
    // state's; the cookie holds only random values.
    const flow = decodeAppleFlow(cookiesOf(s.res)[APPLE_FLOW].value)!;
    expect(flowRows()).toEqual([await binding(flow, 'replace', 'old', old.sid)]);
    expect(Object.keys(unb64(cookiesOf(s.res)[APPLE_FLOW].value) as object).sort()).toEqual(['l', 'n', 'r', 's', 'x']);
    expect(s.res.location).not.toContain(flow.secret!);
    const r = await webCallback(s);
    expect(r.location).toBe('/?apple=new#/');
    const sessions = sessionRows();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].user_id).not.toBe('old');
    expect(flowRows()).toEqual([]);
  });

  it('a session id written into the flow cookie by hand deletes nothing', async () => {
    account('victim', 'victim@split.test', { confirmed: true });
    const victim = await signedIn('victim');
    const s = await webStart();
    const flow = unb64(cookiesOf(s.res)[APPLE_FLOW].value) as Record<string, unknown>;
    const r = await webCallback(s, undefined, { cookie: handMade(APPLE_FLOW, { ...flow, p: victim.sid }) });
    expect(r.location).toBe('/?apple=new#/join/abc');
    expect(sessionRows().map(x => x.id)).toContain(victim.sid);
  });

  it('is exempt from the cookie CSRF check: a cross-site POST with a session cookie still signs in', async () => {
    account('old', 'old@split.test', { confirmed: true });
    const old = await signedIn('old');
    const s = await webStart();
    const r = await webCallback(s, undefined, { cookie: `${s.cookie}; ${old.cookie}` });
    expect(r.status).toBe(303);
    expect(r.location).toBe('/?apple=new#/join/abc');
  });
});

// ---------- linking from 我的 ----------

const linkResult = (r: Res, provider: 'apple' | 'google'): string => (new RegExp(`^/\\?${provider}_link=([a-z_]+)#/account$`).exec(r.location) ?? [])[1] ?? '';

/** POST /api/me/apple as the iPhone app sends it for the account of session `token`. */
async function linkInApp(token: string, o: { tokenNonce?: string } = {}): Promise<Res> {
  return call('POST', API + '/api/me/apple', { Authorization: 'Bearer ' + token }, {
    identityToken: await identityToken(APP_ID, o.tokenNonce ?? (await sha256Hex(RAW_NONCE))), authorizationCode: 'c.link-code', nonce: RAW_NONCE,
  });
}

/** An Apple link from 我的 on the web, in the browser with `cookie`: Apple's answer. */
async function appleWebLink(cookie: string): Promise<Res> {
  return webCallback(await webStart('?link=1', { ...FROM_APP, Cookie: cookie }));
}

/** A Google link from 我的 on the web, in the browser with `cookie`: the start and Google's answer. */
async function googleWebLink(cookie: string): Promise<{ start: Res; callback: Res }> {
  const start = await call('GET', '/api/auth/google/start?link=1', { ...FROM_APP, Cookie: cookie });
  const fc = cookiesOf(start)[GOOGLE_FLOW];
  googleNonce = decodeFlow(fc.value)!.nonce;
  const state = new URL(start.location).searchParams.get('state')!;
  const callback = await call('GET', `/api/auth/google/callback?state=${encodeURIComponent(state)}&code=4%2F0Acode`, {
    'Sec-Fetch-Site': 'cross-site', Cookie: `${GOOGLE_FLOW}=${fc.value}; ${cookie}`,
  });
  return { start, callback };
}

describe('linking from 我的', () => {
  it('Apple on the web: bound to the session at the start; Apple\'s answer waits as a pending link, which 連結 links', async () => {
    account('gino', 'gino@split.test', { confirmed: true });
    const me = await signedIn('gino');
    const s = await webStart('?link=1', { ...FROM_APP, Cookie: me.cookie });
    const flow = decodeAppleFlow(cookiesOf(s.res)[APPLE_FLOW].value)!;
    expect(flow.link).toBe(true);
    expect(flowRows()).toEqual([await binding(flow, 'link', 'gino', me.sid)]);
    expect(s.state).toBe('l.' + flow.state);
    const r = await webCallback(s);
    expect(r.status).toBe(303);
    const id = webPending(r);
    expect(id, r.location).not.toBe('');
    // Nothing is linked yet and no session is made; the grant waits with the Apple ID.
    expect(userRows()[0]).toMatchObject({ id: 'gino', email: 'gino@split.test', apple_sub: null });
    expect(cookiesOf(r)[SESSION]).toBeUndefined();
    expect(sessionRows().map(x => x.id)).toEqual([me.sid]);
    expect(grantRows()).toEqual([]);
    expect(flowRows()).toEqual([]);
    const [p] = pendingRows();
    expect(p).toMatchObject({ id: await sha256Hex(id), user_id: 'gino', session_id: me.sid, provider: 'apple', sub: SUB, email: RELAY, client_id: SERVICES_ID, refresh_token: 'r.refresh-1' });
    expect(Date.parse(p.expires_at) - Date.parse(p.created_at)).toBe(600_000);
    // 我的 asks first (the app on this origin, with its cookie), then links.
    const web = { Cookie: me.cookie, Origin: SITE, 'Sec-Fetch-Site': 'same-origin' };
    const shown = await call('GET', '/api/me/links/pending/' + id, web);
    expect(shown.status, shown.text).toBe(200);
    expect(shown.data).toEqual({ provider: 'apple', email: RELAY, expiresAt: p.expires_at });
    const done = await call('POST', '/api/me/links/pending/' + id, web, {});
    expect(done.status, done.text).toBe(200);
    expect(done.data).toEqual({ user: expect.objectContaining({ id: 'gino', email: 'gino@split.test', appleLinked: true }), movedFromEmpty: false });
    expect(userRows()[0].apple_sub).toBe(SUB);
    expect(grantRows()).toEqual([{ user_id: 'gino', client_id: SERVICES_ID, refresh_token: 'r.refresh-1' }]);
    expect(pendingRows()).toEqual([]);
    expect(revoked()).toEqual([]);
    // Once.
    expect((await call('POST', '/api/me/links/pending/' + id, web, {})).status).toBe(404);
    // Afterwards the Apple ID signs in to it, whatever email it carries.
    expect((await nativeSignIn()).data).toMatchObject({ arrival: 'back', user: { id: 'gino' } });
  });

  it('取消 drops it: nothing is linked, and the grant no account keeps is revoked', async () => {
    account('gino', 'gino@split.test', { confirmed: true });
    const me = await signedIn('gino');
    const id = webPending(await appleWebLink(me.cookie));
    const r = await pendingLink('DELETE', id, me.token);
    expect(r.status, r.text).toBe(200);
    expect(r.data).toEqual({ ok: true });
    expect(userRows()[0].apple_sub).toBeNull();
    expect(pendingRows()).toEqual([]);
    expect(grantRows()).toEqual([]);
    const revokes = sent.filter(x => x.url === APPLE.revoke).map(x => Object.fromEntries(new URLSearchParams(String(x.init.body))));
    expect(revokes.map(f => [f.client_id, f.token, f.token_type_hint])).toEqual([[SERVICES_ID, 'r.refresh-1', 'refresh_token']]);
    for (const m of ['GET', 'POST', 'DELETE'] as const) expect((await pendingLink(m, id, me.token)).status, m).toBe(404);
  });

  it('a pending link is this session\'s only, for 10 minutes: another session, another account, a made-up or expired id get 404', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T09:00:00Z'));
    account('gino', 'gino@split.test', { confirmed: true });
    account('leo', 'leo@split.test', { confirmed: true });
    const me = await signedIn('gino');
    const other = await signedIn('gino');
    const leo = await signedIn('leo');
    const id = webPending(await appleWebLink(me.cookie));
    for (const token of [other.token, leo.token]) {
      for (const m of ['GET', 'POST', 'DELETE'] as const) {
        const r = await pendingLink(m, id, token);
        expect([r.status, r.data.error.code], m).toEqual([404, 'not_found']);
      }
    }
    for (const made of ['x'.repeat(43), 'short', id + 'x']) expect((await pendingLink('GET', made, me.token)).status, made).toBe(404);
    expect((await call('GET', '/api/me/links/pending/' + id)).status).toBe(401);
    expect((await pendingLink('GET', id, me.token)).data).toEqual({ provider: 'apple', email: RELAY, expiresAt: '2026-10-30T09:10:00.000Z' });
    vi.setSystemTime(new Date('2026-10-30T09:10:01Z'));
    expect((await pendingLink('POST', id, me.token)).status).toBe(404);
    expect(userRows().map(u => u.apple_sub)).toEqual([null, null]);
  });

  it('Apple on the web refuses at 連結: another account has it (409 apple_taken, the grant kept for it), this one has another (409 already_linked, revoked)', async () => {
    account('gino', 'gino@split.test', { confirmed: true });
    account('other', 'other@split.test', { confirmed: true, appleSub: SUB });
    const me = await signedIn('gino');
    const taken = await pendingLink('POST', webPending(await appleWebLink(me.cookie)), me.token);
    expect([taken.status, taken.data.error.code]).toEqual([409, 'apple_taken']);
    expect(grantRows()).toEqual([{ user_id: 'other', client_id: SERVICES_ID, refresh_token: 'r.refresh-1' }]);
    db.exec('UPDATE users SET apple_sub = NULL WHERE id = ?', 'other');
    db.exec('UPDATE users SET apple_sub = ? WHERE id = ?', '000777.mine.0007', 'gino');
    const already = await pendingLink('POST', webPending(await appleWebLink(me.cookie)), me.token);
    expect([already.status, already.data.error.code]).toEqual([409, 'already_linked']);
    expect(revoked()).toEqual(['r.refresh-2']);
    expect(userRows().map(u => u.apple_sub)).toEqual(['000777.mine.0007', null]);
    expect(pendingRows()).toEqual([]);
  });

  it('the callback refuses: the session ended (state, before Apple is asked), not signed in (start), the cookie gone (state, by the mark)', async () => {
    account('gino', 'gino@split.test', { confirmed: true });
    const me = await signedIn('gino');
    const s = await webStart('?link=1', { ...FROM_APP, Cookie: me.cookie });
    db.exec('DELETE FROM sessions WHERE id = ?', me.sid);
    expect(linkResult(await webCallback(s), 'apple')).toBe('state');
    expect(sent.filter(x => x.url === APPLE.token)).toEqual([]);
    expect(linkResult((await webStart('?link=1')).res, 'apple')).toBe('start');
    const t = await webStart('?link=1', { ...FROM_APP, Cookie: (await signedIn('gino')).cookie });
    expect(linkResult(await webCallback(t, undefined, { cookie: '' }), 'apple')).toBe('state');
    expect(userRows().map(u => u.apple_sub)).toEqual([null]);
    expect(pendingRows()).toEqual([]);
  });

  it('Google on the web: start with link=1 and the session cookie; Google\'s answer waits as a pending link with its email; 連結 links it', async () => {
    account('gino', 'gino@split.test', { confirmed: true });
    const me = await signedIn('gino');
    const start = await call('GET', '/api/auth/google/start?link=1', { ...FROM_APP, Cookie: me.cookie });
    const fc = cookiesOf(start)[GOOGLE_FLOW];
    const flow = decodeFlow(fc.value)!;
    expect(flow.link).toBe(true);
    expect(flowRows()).toEqual([await binding(flow, 'link', 'gino', me.sid)]);
    const state = new URL(start.location).searchParams.get('state')!;
    expect(state).toBe('l.' + flow.state);
    expect(start.location).not.toContain(flow.secret!);
    googleNonce = flow.nonce;
    const r = await call('GET', `/api/auth/google/callback?state=${encodeURIComponent(state)}&code=4%2F0Acode`, { 'Sec-Fetch-Site': 'cross-site', Cookie: `${GOOGLE_FLOW}=${fc.value}; ${me.cookie}` });
    const id = webPending(r);
    expect(id, r.location).not.toBe('');
    expect(cookiesOf(r)[SESSION]).toBeUndefined();
    expect(userRows()[0].google_sub).toBeNull();
    expect(pendingRows()[0]).toMatchObject({ provider: 'google', sub: G_SUB, email: 'abbie.lin@gmail.com', client_id: null, refresh_token: null, session_id: me.sid });
    expect((await pendingLink('GET', id, me.token)).data).toMatchObject({ provider: 'google', email: 'abbie.lin@gmail.com' });
    const done = await pendingLink('POST', id, me.token);
    expect(done.data).toEqual({ user: expect.objectContaining({ id: 'gino', email: 'gino@split.test', googleLinked: true }), movedFromEmpty: false });
    expect(userRows()[0]).toMatchObject({ id: 'gino', email: 'gino@split.test', google_sub: G_SUB });
    // Not signed in: start.
    expect(linkResult(await call('GET', '/api/auth/google/start?link=1', FROM_APP), 'google')).toBe('start');
  });

  it('Google on the web refuses at 連結: google_taken and already_linked (409)', async () => {
    account('gino', 'gino@split.test', { confirmed: true });
    account('other', 'other@split.test', { confirmed: true, googleSub: G_SUB });
    const me = await signedIn('gino');
    const confirm = async () => pendingLink('POST', webPending((await googleWebLink(me.cookie)).callback), me.token);
    const taken = await confirm();
    expect([taken.status, taken.data.error.code]).toEqual([409, 'google_taken']);
    db.exec('UPDATE users SET google_sub = NULL WHERE id = ?', 'other');
    db.exec('UPDATE users SET google_sub = ? WHERE id = ?', '222222222222222222222', 'gino');
    const already = await confirm();
    expect([already.status, already.data.error.code]).toEqual([409, 'already_linked']);
    expect(pendingRows()).toEqual([]);
  });

  it('a callback with someone else\'s code opened in the person\'s own browser only proposes a link, which they see and refuse', async () => {
    account('victim', 'victim@split.test', { confirmed: true });
    const victim = await signedIn('victim');
    // The victim's own flow cookie; the code is another person's, from their consent on the leaked URL.
    googleClaims = n => ({ ...goodGoogleClaims(n), sub: '199999999999999999999', email: 'mallory@gmail.com' });
    const id = webPending((await googleWebLink(victim.cookie)).callback);
    expect(userRows()[0].google_sub).toBeNull();
    expect((await pendingLink('GET', id, victim.token)).data).toMatchObject({ provider: 'google', email: 'mallory@gmail.com' });
    expect((await pendingLink('DELETE', id, victim.token)).data).toEqual({ ok: true });
    expect(userRows()[0].google_sub).toBeNull();
  });

  it('a leaked authorize URL links nothing: its state without the cookie\'s secret finds no binding, which stays for the real answer', async () => {
    account('victim', 'victim@split.test', { confirmed: true });
    const victim = await signedIn('victim');
    // Apple: the victim's start. The attacker has its URL (the state and the nonce) and writes a
    // flow cookie to match in their own browser, with no secret or one of their own.
    const s = await webStart('?link=1', { ...FROM_APP, Cookie: victim.cookie });
    const apple = { s: s.state.slice(2), n: new URL(s.res.location).searchParams.get('nonce')!, r: '/', l: 'en', k: 1 };
    for (const forged of [apple, { ...apple, x: 'a'.repeat(43) }]) {
      expect(linkResult(await webCallback(s, undefined, { cookie: handMade(APPLE_FLOW, forged) }), 'apple'), JSON.stringify(forged)).toBe('state');
    }
    expect(sent.filter(x => x.url === APPLE.token)).toEqual([]);
    // Google on the web: the URL has the state and the nonce; the verifier stays in the cookie.
    const g = await call('GET', '/api/auth/google/start?link=1', { ...FROM_APP, Cookie: victim.cookie });
    const gu = new URL(g.location);
    const gState = gu.searchParams.get('state')!;
    googleNonce = gu.searchParams.get('nonce')!;
    const google = { s: gState.slice(2), n: googleNonce, v: 'v'.repeat(43), r: '/', l: 'en', k: 1 };
    const gcb = await call('GET', `/api/auth/google/callback?state=${encodeURIComponent(gState)}&code=4%2F0Acode`, { Cookie: handMade(GOOGLE_FLOW, google) });
    expect(linkResult(gcb, 'google')).toBe('state');
    // The iPhone app's ticket flow.
    const t = await call('POST', API + '/api/me/google/ticket', { Authorization: 'Bearer ' + victim.token }, {});
    const i = await iosStart(new URL(t.data.url).search, victim.token);
    const ios = { s: i.state.slice(2), n: i.nonce, v: 'v'.repeat(43), r: '/', l: 'en', c: 'ios', k: 1 };
    expect(appError(await iosCallback({ ...i, cookie: handMade(GOOGLE_FLOW, ios) }))).toBe('state');
    expect(flowRows()).toHaveLength(3);
    expect(sent.filter(x => x.url === GOOGLE_TOKEN_URL)).toEqual([]);
    expect(pendingRows()).toEqual([]);
    // The real answers, with the victim's own cookies, still come back as pending links.
    expect(webPending(await webCallback(s))).not.toBe('');
    expect(appPending(await iosCallback(i))).not.toBe('');
    expect(userRows().map(u => [u.apple_sub, u.google_sub])).toEqual([[null, null]]);
  });

  it('Apple in the iPhone app (POST /api/me/apple): links at once, whatever the email; the same again is fine; 409s; a bad token is 400, never 401', async () => {
    account('gino', 'gino@split.test', { confirmed: true });
    const me = await signedIn('gino');
    const r = await linkInApp(me.token);
    expect(r.status, r.text).toBe(200);
    expect(r.data).toEqual({ user: expect.objectContaining({ id: 'gino', email: 'gino@split.test', appleLinked: true }), movedFromEmpty: false });
    expect(pendingRows()).toEqual([]);
    expect(grantRows()).toEqual([{ user_id: 'gino', client_id: APP_ID, refresh_token: 'r.refresh-1' }]);
    expect((await linkInApp(me.token)).status).toBe(200);
    const bad = await linkInApp(me.token, { tokenNonce: 'nope' });
    expect([bad.status, bad.data.error.code]).toEqual([400, 'apple_invalid']);
    db.exec('UPDATE users SET apple_sub = ? WHERE id = ?', '000777.mine.0007', 'gino');
    const already = await linkInApp(me.token);
    expect([already.status, already.data.error.code]).toEqual([409, 'already_linked']);
    db.exec('UPDATE users SET apple_sub = NULL WHERE id = ?', 'gino');
    account('other', 'other@split.test', { appleSub: SUB });
    const taken = await linkInApp(me.token);
    expect([taken.status, taken.data.error.code]).toEqual([409, 'apple_taken']);
    vars = { APPLE_SIGNIN_KEY: undefined };
    expect((await linkInApp(me.token)).data.error.code).toBe('apple_unavailable');
    expect((await call('POST', API + '/api/me/apple', {}, {})).status).toBe(401);
  });

  it('Google in the iPhone app: a ticket for this account and session, spent by its start with X-Evenly-Session; a pending link back in the app', async () => {
    account('gino', 'gino@split.test', { confirmed: true });
    const me = await signedIn('gino');
    const t = await call('POST', API + '/api/me/google/ticket', { Authorization: 'Bearer ' + me.token }, {});
    expect(t.status).toBe(200);
    const url = new URL(t.data.url);
    expect(url.origin + url.pathname).toBe(SITE + '/api/auth/google/start');
    expect(url.searchParams.get('client')).toBe('ios');
    const ticket = url.searchParams.get('ticket')!;
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(db.rows<{ id: string; session_id: string }>("SELECT id, session_id FROM google_app_codes WHERE kind = 'link'")).toEqual([{ id: await sha256Hex(ticket), session_id: me.sid }]);
    // Opened without the session that asked (a URL that reached someone else), with another's, or a
    // header that is not a token: start, and the ticket stays.
    expect(appError((await iosStart(url.search)).res)).toBe('start');
    account('leo', 'leo@split.test', { confirmed: true });
    const leo = await signedIn('leo');
    expect(appError((await iosStart(url.search, leo.token)).res)).toBe('start');
    expect(appError((await iosStart(url.search, 'not a token!')).res)).toBe('start');
    expect(db.rows("SELECT 1 FROM google_app_codes WHERE kind = 'link' AND used_at IS NULL")).toHaveLength(1);
    const s = await iosStart(url.search, me.token);
    expect(s.res.location.startsWith('https://accounts.google.com/')).toBe(true);
    const flow = decodeFlow(cookiesOf(s.res)[GOOGLE_FLOW].value)!;
    expect(flow).toMatchObject({ client: 'ios', link: true });
    expect(flowRows()).toEqual([await binding(flow, 'link', 'gino', me.sid)]);
    const cb = await iosCallback(s);
    const id = appPending(cb);
    expect(id, cb.location).not.toBe('');
    expect(userRows()[0].google_sub).toBeNull();
    // The app asks, then links, with its own session.
    expect((await pendingLink('GET', id, me.token)).data).toMatchObject({ provider: 'google', email: 'abbie.lin@gmail.com' });
    expect((await pendingLink('POST', id, me.token)).data).toMatchObject({ user: { googleLinked: true }, movedFromEmpty: false });
    expect(userRows()[0].google_sub).toBe(G_SUB);
    // Once only.
    expect(appError((await iosStart(url.search, me.token)).res)).toBe('start');
    // A new ticket replaces an unused older one; Authorization: Bearer (builds before X-Evenly-Session) works too.
    const a = new URL((await call('POST', API + '/api/me/google/ticket', { Authorization: 'Bearer ' + me.token }, {})).data.url).search;
    const b = new URL((await call('POST', API + '/api/me/google/ticket', { Authorization: 'Bearer ' + me.token }, {})).data.url).search;
    expect(appError((await iosStart(a, me.token)).res)).toBe('start');
    expect((await iosStart(b, me.token, 'bearer')).res.location.startsWith('https://accounts.google.com/')).toBe(true);
  });

  it('a link written into a flow cookie by hand reaches no account: it is not bound on the server', async () => {
    account('victim', 'victim@split.test', { confirmed: true });
    const victim = await signedIn('victim');
    // Apple: the attacker's own start and Apple sign-in, with a cookie that says link and names the victim.
    const s = await webStart();
    const flow = unb64(cookiesOf(s.res)[APPLE_FLOW].value) as Record<string, unknown>;
    const forged = handMade(APPLE_FLOW, { ...flow, k: 1, u: 'victim', si: victim.sid });
    const r = await webCallback({ ...s, state: 'l.' + flow.s }, undefined, { cookie: forged });
    expect(linkResult(r, 'apple')).toBe('state');
    // The same names in a cookie that does not say link: a sign-in of the attacker's own.
    const t = await webStart();
    const tf = unb64(cookiesOf(t.res)[APPLE_FLOW].value) as Record<string, unknown>;
    expect((await webCallback(t, undefined, { cookie: handMade(APPLE_FLOW, { ...tf, u: 'victim', si: victim.sid }) })).location).toBe('/?apple=new#/join/abc');
    expect(userRows().find(u => u.id === 'victim')!.apple_sub).toBeNull();
    // Google, on the web and for the iPhone app.
    for (const extra of [{ k: 1 }, { k: 1, c: 'ios' }]) {
      const g = await call('GET', '/api/auth/google/start?return=%2F', FROM_APP);
      const gf = unb64(cookiesOf(g)[GOOGLE_FLOW].value) as Record<string, unknown>;
      googleNonce = String(gf.n);
      const mark = extra.c ? 'i.' : 'l.';
      const cb = await call('GET', `/api/auth/google/callback?state=${encodeURIComponent(mark + gf.s)}&code=4%2F0Acode`, { Cookie: handMade(GOOGLE_FLOW, { ...gf, ...extra, u: 'victim', si: victim.sid }) });
      expect(extra.c ? appError(cb) : linkResult(cb, 'google'), JSON.stringify(extra)).toBe('state');
    }
    expect(userRows().find(u => u.id === 'victim')!.google_sub).toBeNull();
    expect(pendingRows()).toEqual([]);
  });

  it('Google in the iPhone app: google_taken and already_linked come at 連結 (409); a session that ended is state in the app', async () => {
    account('gino', 'gino@split.test', { confirmed: true });
    account('other', 'other@split.test', { googleSub: G_SUB });
    const me = await signedIn('gino');
    const ticketUrl = async () => new URL((await call('POST', API + '/api/me/google/ticket', { Authorization: 'Bearer ' + me.token }, {})).data.url).search;
    const confirm = async () => pendingLink('POST', appPending(await iosCallback(await iosStart(await ticketUrl(), me.token))), me.token);
    const taken = await confirm();
    expect([taken.status, taken.data.error.code]).toEqual([409, 'google_taken']);
    db.exec('UPDATE users SET google_sub = NULL WHERE id = ?', 'other');
    db.exec('UPDATE users SET google_sub = ? WHERE id = ?', '333333333333333333333', 'gino');
    const already = await confirm();
    expect([already.status, already.data.error.code]).toEqual([409, 'already_linked']);
    db.exec('UPDATE users SET google_sub = NULL WHERE id = ?', 'gino');
    const s = await iosStart(await ticketUrl(), me.token);
    db.exec('DELETE FROM sessions WHERE id = ?', me.sid);
    expect(appError(await iosCallback(s))).toBe('state');
    expect(userRows().map(u => u.google_sub)).toEqual([null, null]);
  });

  it('an Apple link nobody answered: the daily job keeps its grant for the account that has the Apple ID by then, else revokes it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T09:00:00Z'));
    account('gino', 'gino@split.test', { confirmed: true });
    const me = await signedIn('gino');
    expect(webPending(await appleWebLink(me.cookie))).not.toBe('');
    claimsEdit = c => ({ ...c, sub: '000555.other.0005' });
    exchangedSub = '000555.other.0005';
    expect(webPending(await appleWebLink(me.cookie))).not.toBe('');
    // A Google link waits too; it has nothing to settle.
    expect(webPending((await googleWebLink(me.cookie)).callback)).not.toBe('');
    account('holder', 'holder@split.test', { confirmed: true, appleSub: '000555.other.0005' });
    vi.setSystemTime(new Date('2026-10-30T09:10:01Z'));
    // The cleanup leaves the Apple rows with a grant to the settling step.
    await db.d1.batch(cleanupStmts(db.d1, new Date()) as never);
    expect(pendingRows().map(x => x.provider)).toEqual(['apple', 'apple']);
    expect(await settleExpiredPendingLinks(env() as never, new Date())).toBe(2);
    expect(pendingRows()).toEqual([]);
    expect(revoked()).toEqual(['r.refresh-1']);
    expect(grantRows()).toEqual([{ user_id: 'holder', client_id: SERVICES_ID, refresh_token: 'r.refresh-2' }]);
    expect(await settleExpiredPendingLinks(env() as never, new Date())).toBe(0);
  });
});

// ---------- an empty account gives its Apple ID or Google account up ----------

describe('an empty account gives up its Apple ID or Google account to a link', () => {
  it('Hide My Email made a new account a moment ago: 連結 Apple in the app moves the Apple ID there and deletes the empty one with its sessions', async () => {
    const made = await nativeSignIn({ name: 'Gino' });
    expect(made.data).toMatchObject({ arrival: 'new', user: { email: RELAY } });
    account('gino', 'gino@split.test', { confirmed: true });
    const me = await signedIn('gino');
    const r = await linkInApp(me.token);
    expect(r.status, r.text).toBe(200);
    expect(r.data).toEqual({ user: expect.objectContaining({ id: 'gino', email: 'gino@split.test', appleLinked: true }), movedFromEmpty: true });
    expect(userRows().map(u => [u.id, u.apple_sub])).toEqual([['gino', SUB]]);
    expect(sessionRows().map(x => x.user_id)).toEqual(['gino']);
    expect((await call('GET', API + '/api/me', { Authorization: 'Bearer ' + made.data.token })).status).toBe(401);
    // The grant comes along (the link's own is the newest for the app); nothing is revoked.
    expect(grantRows()).toEqual([{ user_id: 'gino', client_id: APP_ID, refresh_token: 'r.refresh-2' }]);
    expect(revoked()).toEqual([]);
    // From now on the Apple ID signs in to the old account.
    expect((await nativeSignIn()).data).toMatchObject({ arrival: 'back', user: { id: 'gino' } });
  });

  it('on the web the pending link moves it the same way, the empty account\'s grants with it; a Google account too', async () => {
    const made = await nativeSignIn();
    account('gino', 'gino@split.test', { confirmed: true });
    const me = await signedIn('gino');
    const r = await pendingLink('POST', webPending(await appleWebLink(me.cookie)), me.token);
    expect(r.data).toEqual({ user: expect.objectContaining({ id: 'gino', appleLinked: true }), movedFromEmpty: true });
    expect(userRows().map(u => u.id)).toEqual(['gino']);
    expect(userRows().map(u => u.id)).not.toContain(made.data.user.id);
    expect(grantRows()).toEqual([
      { user_id: 'gino', client_id: APP_ID, refresh_token: 'r.refresh-1' },
      { user_id: 'gino', client_id: SERVICES_ID, refresh_token: 'r.refresh-2' },
    ]);
    // Google: an account the iPhone app's Google sign-in made (its Gmail address and nothing else).
    expect((await exchange(appCode(await iosCallback(await iosStart())))).data.arrival).toBe('new');
    const moved = await pendingLink('POST', webPending((await googleWebLink(me.cookie)).callback), me.token);
    expect(moved.data).toEqual({ user: expect.objectContaining({ id: 'gino', googleLinked: true, appleLinked: true }), movedFromEmpty: true });
    expect(userRows().map(u => [u.id, u.google_sub])).toEqual([['gino', G_SUB]]);
  });

  it('an email that is the Apple ID\'s own (not hidden), or none, counts as empty too', async () => {
    claimsEdit = c => ({ ...c, email: 'gino.chang@icloud.com', is_private_email: false });
    await nativeSignIn();
    account('gino', 'gino@split.test', { confirmed: true });
    expect((await linkInApp((await signedIn('gino')).token)).data.movedFromEmpty).toBe(true);
    db = new TestD1();
    const none = await nativeSignIn();
    db.exec('UPDATE users SET email = NULL WHERE id = ?', none.data.user.id);
    account('gino', 'gino@split.test', { confirmed: true });
    expect((await linkInApp((await signedIn('gino')).token)).data.movedFromEmpty).toBe(true);
  });

  it('an account that is not empty keeps it (409 apple_taken as before): in a group, a password, Google too, another email', async () => {
    const cases: [string, (id: string) => void][] = [
      ['in a group', id => inGroup(id)],
      ['a password', id => db.exec('UPDATE users SET pw_hash = ? WHERE id = ?', PW_HASH, id)],
      ['Google too', id => db.exec('UPDATE users SET google_sub = ? WHERE id = ?', '444444444444444444444', id)],
      ['another email', id => db.exec('UPDATE users SET email = ? WHERE id = ?', 'someone@split.test', id)],
    ];
    for (const [what, edit] of cases) {
      db = new TestD1();
      const made = await nativeSignIn();
      edit(made.data.user.id);
      account('gino', 'gino@split.test', { confirmed: true });
      const r = await linkInApp((await signedIn('gino')).token);
      expect([r.status, r.data.error?.code], what).toEqual([409, 'apple_taken']);
      expect(userRows().map(u => [u.id, u.apple_sub]), what).toEqual([[made.data.user.id, SUB], ['gino', null]]);
      // The refused link's grant is kept for the account that has the Apple ID.
      expect(grantRows().map(g => g.user_id), what).toEqual([made.data.user.id]);
    }
  });

  it('emptiness is checked inside the batch: an account that joins a group in between keeps it (409), and nothing is half done', async () => {
    const made = await nativeSignIn();
    const holder = made.data.user.id;
    account('gino', 'gino@split.test', { confirmed: true });
    const me = await signedIn('gino');
    const batch = db.batch.bind(db);
    let joined = false;
    (db as unknown as { batch: typeof batch }).batch = async stmts => {
      if (!joined && stmts.some(st => st.sql.includes('SET apple_sub = NULL'))) {
        joined = true;
        inGroup(holder);
      }
      return batch(stmts);
    };
    const r = await linkInApp(me.token);
    expect(joined).toBe(true);
    expect([r.status, r.data.error?.code]).toEqual([409, 'apple_taken']);
    expect(userRows().map(u => [u.id, u.apple_sub])).toEqual([[holder, SUB], ['gino', null]]);
    expect(sessionRows().map(x => x.user_id).sort()).toEqual(['gino', holder].sort());
  });
});

// ---------- deleting the account ----------

describe('deleting the account', () => {
  it('revokes every Apple grant, each with its own client, once the batch that deletes the account has taken them', async () => {
    const r = await nativeSignIn({ name: 'Gino' });
    const id = r.data.user.id;
    const s = await webStart();
    await webCallback(s);
    expect(grantRows().map(g => g.client_id)).toEqual([APP_ID, SERVICES_ID]);
    const token = r.data.token;
    const del = await call('DELETE', API + '/api/me', { Authorization: 'Bearer ' + token }, {});
    expect(del.status, del.text).toBe(200);
    const revokes = sent.filter(x => x.url === APPLE.revoke).map(x => Object.fromEntries(new URLSearchParams(String(x.init.body))));
    expect(revokes.map(f => [f.client_id, f.token, f.token_type_hint]).sort()).toEqual([
      [APP_ID, 'r.refresh-1', 'refresh_token'],
      [SERVICES_ID, 'r.refresh-2', 'refresh_token'],
    ]);
    for (const f of revokes) expect(unb64(f.client_secret.split('.')[1])).toMatchObject({ sub: f.client_id, iss: TEAM, aud: 'https://appleid.apple.com' });
    expect(userRows().find(u => u.id === id)).toBeUndefined();
    expect(grantRows()).toEqual([]);
  });

  it('a revoke Apple refuses or does not answer is logged and does not stop the deletion', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await nativeSignIn();
    revokeAnswer = async () => Response.json({ error: 'invalid_client' }, { status: 400 });
    const del = await call('DELETE', API + '/api/me', { Authorization: 'Bearer ' + r.data.token }, {});
    expect(del.status).toBe(200);
    expect(userRows()).toEqual([]);
    const logged = error.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('apple revoke for com.ginochang.evenly: revoke endpoint answered 400 invalid_client');
    expect(logged).not.toContain('r.refresh-1');
  });

  it('the export says appleLinked, never the Apple ID; the same Apple ID afterwards is a new account', async () => {
    const r = await nativeSignIn();
    const ex = await call('GET', API + '/api/me/export', { Authorization: 'Bearer ' + r.data.token });
    expect(ex.data.user.appleLinked).toBe(true);
    expect(ex.text).not.toContain(SUB);
    expect(ex.text).not.toContain('apple_sub');
    expect(ex.text).not.toContain('r.refresh');
    await call('DELETE', API + '/api/me', { Authorization: 'Bearer ' + r.data.token }, {});
    const again = await nativeSignIn();
    expect(again.data.arrival).toBe('new');
    expect(again.data.user.id).not.toBe(r.data.user.id);
  });

  it('a grant stored a moment before is among those the deletion\'s own batch takes, so it is revoked too', async () => {
    const r = await nativeSignIn();
    const batch = db.batch.bind(db);
    (db as unknown as { batch: typeof batch }).batch = async stmts => {
      if (stmts.some(st => st.sql.startsWith('DELETE FROM apple_grants WHERE user_id = ? RETURNING'))) {
        db.exec('INSERT INTO apple_grants (user_id, client_id, refresh_token, created_at) VALUES (?, ?, ?, ?)', r.data.user.id, SERVICES_ID, 'r.just-now', new Date().toISOString());
      }
      return batch(stmts);
    };
    expect((await call('DELETE', API + '/api/me', { Authorization: 'Bearer ' + r.data.token }, {})).status).toBe(200);
    expect(revoked().sort()).toEqual(['r.just-now', 'r.refresh-1']);
  });

  it('a pending Apple link\'s grant is settled with it: revoked when no account keeps the Apple ID', async () => {
    account('gino', 'gino@split.test', { confirmed: true });
    const me = await signedIn('gino');
    expect(webPending(await appleWebLink(me.cookie))).not.toBe('');
    const del = await call('DELETE', API + '/api/me', { Authorization: 'Bearer ' + me.token }, {});
    expect(del.status, del.text).toBe(200);
    expect(pendingRows()).toEqual([]);
    expect(revoked()).toEqual(['r.refresh-1']);
  });
});

// ---------- a grant Apple made for a refused sign-in or link ----------

describe('a grant Apple made for a sign-in or link that is then refused', () => {
  it('is revoked when no account has that Apple ID (linked_other), so no grant is left that nothing could revoke', async () => {
    account('gino', RELAY, { confirmed: true, appleSub: '000999.ffff.0001' });
    const r = await nativeSignIn();
    expect(r.data.error.code).toBe('linked_other');
    const revokes = sent.filter(x => x.url === APPLE.revoke).map(x => Object.fromEntries(new URLSearchParams(String(x.init.body))));
    expect(revokes.map(f => [f.client_id, f.token, f.token_type_hint])).toEqual([[APP_ID, 'r.refresh-1', 'refresh_token']]);
    expect(grantRows()).toEqual([]);
  });

  it('is kept for the account that has the Apple ID when a link is refused (apple_taken), not revoked', async () => {
    account('holder', 'holder@split.test', { confirmed: true, appleSub: SUB });
    account('gino', 'gino@split.test', { confirmed: true });
    const me = await signedIn('gino');
    const r = await call('POST', API + '/api/me/apple', { Authorization: 'Bearer ' + me.token }, {
      identityToken: await identityToken(APP_ID, await sha256Hex(RAW_NONCE)), authorizationCode: 'c.link-code', nonce: RAW_NONCE,
    });
    expect(r.data.error.code).toBe('apple_taken');
    expect(sent.filter(x => x.url === APPLE.revoke)).toEqual([]);
    expect(grantRows()).toEqual([{ user_id: 'holder', client_id: APP_ID, refresh_token: 'r.refresh-1' }]);
  });

  it('a revoke that fails is logged by its client and Apple\'s error name only', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    revokeAnswer = async () => Response.json({ error: 'invalid_client' }, { status: 400 });
    claimsEdit = c => ({ ...c, email: undefined, email_verified: undefined });
    expect((await nativeSignIn()).data.error.code).toBe('no_email');
    const logged = error.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('apple refused grant for com.ginochang.evenly: revoke endpoint answered 400 invalid_client');
    expect(logged).not.toContain('r.refresh-1');
  });
});

describe('two sign-ins with the same Apple ID at once', () => {
  it('the one that finds the email\'s account linked to this very Apple ID a moment ago is back, not linked_other', async () => {
    account('gino', 'gino.chang@icloud.com', { confirmed: true, appleSub: SUB });
    claimsEdit = c => ({ ...c, email: 'gino.chang@icloud.com', is_private_email: false });
    // The lookup by Apple ID misses once, as it would for a request that read it before the other one linked.
    const prepare = db.d1.prepare.bind(db.d1);
    let missed = false;
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      if (!missed && sql === 'SELECT * FROM users WHERE apple_sub = ?') {
        missed = true;
        return { bind: () => ({ first: async () => null }) };
      }
      return prepare(sql);
    };
    const r = await nativeSignIn();
    expect(missed).toBe(true);
    expect(r.status, r.text).toBe(200);
    expect(r.data).toMatchObject({ arrival: 'back', user: { id: 'gino' } });
  });
});

// ---------- an unconfirmed email taken over ----------

describe('a sign-in that first proves an unconfirmed email takes the account over', () => {
  it('Apple in the app: the password goes and every other session ends in the same batch; notice "claimed", once', async () => {
    account('gino', 'gino.chang@icloud.com', { name: 'Gino' });
    db.exec('UPDATE users SET pw_hash = ? WHERE id = ?', PW_HASH, 'gino');
    const old = await signedIn('gino');
    claimsEdit = c => ({ ...c, email: 'gino.chang@icloud.com', is_private_email: false });
    const r = await nativeSignIn();
    expect(r.status, r.text).toBe(200);
    expect(r.data).toMatchObject({ arrival: 'linked', notice: 'claimed', user: { id: 'gino', emailVerified: true, hasPassword: false, appleLinked: true } });
    expect(db.rows('SELECT pw_hash FROM users')).toEqual([{ pw_hash: null }]);
    expect(sessionRows().map(x => x.id)).toEqual([await sha256Hex(r.data.token)]);
    expect((await call('GET', API + '/api/me', { Authorization: 'Bearer ' + old.token })).status).toBe(401);
    const again = await nativeSignIn();
    expect(again.data.arrival).toBe('back');
    expect(again.data.notice).toBeUndefined();
  });

  it('nothing to take (no password, no session), or an email confirmed before: no notice, and nothing ends', async () => {
    account('gino', 'gino.chang@icloud.com');
    claimsEdit = c => ({ ...c, email: 'gino.chang@icloud.com', is_private_email: false });
    const quiet = await nativeSignIn();
    expect(quiet.data).toMatchObject({ arrival: 'linked', user: { emailVerified: true } });
    expect(quiet.data.notice).toBeUndefined();
    db = new TestD1();
    account('gino', 'gino.chang@icloud.com', { confirmed: true });
    db.exec('UPDATE users SET pw_hash = ? WHERE id = ?', PW_HASH, 'gino');
    await signedIn('gino');
    const r = await nativeSignIn();
    expect(r.data).toMatchObject({ arrival: 'linked', user: { hasPassword: true } });
    expect(r.data.notice).toBeUndefined();
    expect(sessionRows()).toHaveLength(2);
  });

  it('the web\'s Apple callback says &notice=claimed', async () => {
    account('gino', RELAY);
    db.exec('UPDATE users SET pw_hash = ? WHERE id = ?', PW_HASH, 'gino');
    expect((await webCallback(await webStart('?return=%2F'))).location).toBe('/?apple=linked&notice=claimed#/');
    expect(db.rows('SELECT pw_hash FROM users')).toEqual([{ pw_hash: null }]);
  });

  it('Google in the iPhone app: the exchange says notice "claimed"', async () => {
    account('abbie', 'abbie.lin@gmail.com');
    db.exec('UPDATE users SET pw_hash = ? WHERE id = ?', PW_HASH, 'abbie');
    const r = await exchange(appCode(await iosCallback(await iosStart())));
    expect(r.data).toMatchObject({ arrival: 'linked', notice: 'claimed', user: { id: 'abbie', hasPassword: false, googleLinked: true } });
  });
});

// ---------- what the per-IP limits count ----------

describe('what counts against the per-IP limits', () => {
  it('Apple\'s callback counts only once it is this browser\'s flow: another site\'s posts spend nothing', async () => {
    vars = { APPLE_IP_PER_15M: '1' };
    const s = await webStart();
    for (const f of [{ state: 'x'.repeat(43), code: 'c', id_token: 'a.b.c' }, { error: 'user_cancelled_authorize' }, { state: s.state.slice(0, 20) }]) {
      await webCallback(s, f);
      await webCallback(s, f, { cookie: '' });
    }
    expect(db.rows("SELECT 1 FROM rate_limits WHERE key LIKE 'apple-callback:%'")).toEqual([]);
    expect((await webCallback(s)).location).toBe('/?apple=new#/join/abc');
  });

  it('the iPhone app\'s Google starts count under their own key: pages that start it spend none of the web\'s', async () => {
    vars = { GOOGLE_IP_PER_15M: '1' };
    await iosStart();
    expect(appError((await iosStart()).res)).toBe('rate_limited');
    expect((await call('GET', '/api/auth/google/start?return=%2F', FROM_APP)).location.startsWith('https://accounts.google.com/')).toBe(true);
  });

  it('POST /api/auth/apple and /google/exchange refuse a browser request from another site with 403, before anything is counted', async () => {
    vars = { APPLE_IP_PER_15M: '1', GOOGLE_IP_PER_15M: '1' };
    const token = await identityToken(APP_ID, await sha256Hex(RAW_NONCE));
    for (const h of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'https://evil.test' }]) {
      const a = await call('POST', API + '/api/auth/apple', h, { identityToken: token, authorizationCode: 'c', nonce: RAW_NONCE });
      expect([a.status, a.data.error.code], JSON.stringify(h)).toEqual([403, 'forbidden']);
      const g = await call('POST', API + '/api/auth/google/exchange', h, { code: 'x'.repeat(43), verifier: VERIFIER });
      expect([g.status, g.data.error.code], JSON.stringify(h)).toEqual([403, 'forbidden']);
    }
    expect(db.rows('SELECT key FROM rate_limits')).toEqual([]);
    expect(sent).toEqual([]);
    // The app (no Origin, no Fetch Metadata) and the origins CORS allows still get through.
    expect((await nativeSignIn()).status).toBe(200);
    expect((await call('POST', API + '/api/auth/google/exchange', { Origin: 'https://old.test' }, { code: 'x'.repeat(43), verifier: VERIFIER })).status).toBe(401);
  });
});

// ---------- the associated domain file and the app's way back ----------

describe('the associated domain file and the iPhone app\'s way back', () => {
  it('GET /.well-known/apple-app-site-association names the app for webcredentials: JSON, no redirect, on every host of the Worker', async () => {
    for (const host of [SITE, API]) {
      const r = await call('GET', host + '/.well-known/apple-app-site-association');
      expect(r.status, host).toBe(200);
      expect(r.headers.get('Content-Type')).toBe('application/json');
      expect(r.location).toBe('');
      expect(r.text).toBe('{"webcredentials":{"apps":["7XHV5223X7.com.ginochang.evenly"]}}');
    }
  });

  it('/app/auth/google in a plain browser says to go back to the app, in both languages, and never shows what it carries', async () => {
    const r = await call('GET', '/app/auth/google?code=' + 'c'.repeat(43), { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' });
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(r.headers.get('Content-Security-Policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(r.text).toContain('請回到吉諾分帳所 App');
    expect(r.text).toContain("Go back to the Gino's Split Lab app");
    expect(r.text).not.toContain('c'.repeat(43));
    expect(r.text).not.toContain('<script');
  });
});

// ---------- a new account's currency ----------

describe("a new account's home currency from an Apple sign-in", () => {
  it('POST /api/auth/apple takes currency (a known code, any case); an unknown one or none is the language\'s', async () => {
    expect((await nativeSignIn({ locale: 'zh-TW', currency: 'jpy' })).data.user.currency).toBe('JPY');
    db = new TestD1();
    expect((await nativeSignIn({ locale: 'en', currency: 'ZZZ' })).data.user.currency).toBe('USD');
    db = new TestD1();
    expect((await nativeSignIn({ locale: 'zh-TW', currency: 42 })).data.user.currency).toBe('TWD');
    // An account that exists keeps its own.
    db.exec("UPDATE users SET currency = 'EUR'");
    expect((await nativeSignIn({ currency: 'JPY' })).data.user.currency).toBe('EUR');
  });

  it('the web\'s Apple start takes &currency= for the account its callback makes', async () => {
    const s = await webStart('?return=%2F&locale=en&currency=eur');
    expect(decodeAppleFlow(cookiesOf(s.res)[APPLE_FLOW].value)!.currency).toBe('EUR');
    expect(Object.keys(unb64(cookiesOf(s.res)[APPLE_FLOW].value) as object).sort()).toEqual(['cu', 'l', 'n', 'r', 's', 'x']);
    await webCallback(s);
    expect(userRows()[0]).toMatchObject({ locale: 'en', currency: 'EUR' });
  });
});

// ---------- the owner's check of the key ----------

describe("the owner's check of the client secret (POST /api/admin/apple-check)", () => {
  it('exchanges a made-up code for each client: ok when Apple refuses only the code (invalid_grant); owners only; no secret in the answer', async () => {
    account('owner', 'owner@split.test', { confirmed: true });
    account('leo', 'leo@split.test', { confirmed: true });
    const owner = await signedIn('owner');
    const leo = await signedIn('leo');
    vars = { OWNER_EMAILS: 'owner@split.test' };
    tokenAnswer = async body => Response.json({ error: body.get('client_id') === APP_ID ? 'invalid_grant' : 'invalid_client' }, { status: 400 });
    const r = await call('POST', API + '/api/admin/apple-check', { Authorization: 'Bearer ' + owner.token }, {});
    expect(r.status, r.text).toBe(200);
    expect(r.data).toEqual({
      configured: true,
      checks: [
        { clientId: APP_ID, status: 400, error: 'invalid_grant', ok: true },
        { clientId: SERVICES_ID, status: 400, error: 'invalid_client', ok: false },
      ],
    });
    const forms = sent.filter(x => x.url === APPLE.token).map(x => Object.fromEntries(new URLSearchParams(String(x.init.body))));
    expect(forms.find(f => f.client_id === SERVICES_ID)!.redirect_uri).toBe(SITE + '/api/auth/apple/callback');
    expect(forms.find(f => f.client_id === APP_ID)!.redirect_uri).toBeUndefined();
    for (const f of forms) expect(r.text).not.toContain(f.client_secret);
    expect(userRows()).toHaveLength(2);
    expect(grantRows()).toEqual([]);
    expect((await call('POST', API + '/api/admin/apple-check', { Authorization: 'Bearer ' + leo.token }, {})).status).toBe(404);
    vars = { OWNER_EMAILS: 'owner@split.test', APPLE_SIGNIN_KEY: undefined };
    const off = await call('POST', API + '/api/admin/apple-check', { Authorization: 'Bearer ' + owner.token }, {});
    expect(off.data.configured).toBe(false);
    expect(off.data.checks.map((x: { error: string }) => x.error)).toEqual(['not_configured', 'not_configured']);
  });
});

// ---------- the schema ----------

describe('migrations 0013 to 0015', () => {
  const columns = (table: string) => db.rows<{ name: string; type: string; notnull: number; pk: number }>(`PRAGMA table_info(${table})`).map(c => [c.name, c.type, c.notnull, c.pk]);
  const keys = (table: string) => db.rows<{ table: string; from: string; to: string; on_delete: string }>(`PRAGMA foreign_key_list(${table})`).map(k => [k.from, k.table, k.to, k.on_delete]);
  const indexes = (table: string) => db.rows<{ name: string }>(`PRAGMA index_list(${table})`).map(i => i.name).filter(n => !n.startsWith('sqlite_')).sort();

  it('adds users.apple_sub with a unique index, apple_grants and google_app_codes, with their keys and cascades; additive only', () => {
    expect(columns('users').at(-1)).toEqual(['apple_sub', 'TEXT', 0, 0]);
    expect(indexes('users')).toContain('idx_users_apple_sub');
    expect(columns('apple_grants')).toEqual([['user_id', 'TEXT', 1, 1], ['client_id', 'TEXT', 1, 2], ['refresh_token', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0]]);
    expect(keys('apple_grants')).toEqual([['user_id', 'users', 'id', 'CASCADE']]);
    expect(columns('google_app_codes')).toEqual([
      ['id', 'TEXT', 0, 1], ['kind', 'TEXT', 1, 0], ['user_id', 'TEXT', 1, 0], ['session_id', 'TEXT', 0, 0], ['challenge', 'TEXT', 0, 0],
      ['arrival', 'TEXT', 0, 0], ['expires_at', 'TEXT', 1, 0], ['used_at', 'TEXT', 0, 0], ['created_at', 'TEXT', 1, 0],
    ]);
    expect(keys('google_app_codes')).toEqual([['user_id', 'users', 'id', 'CASCADE']]);
    expect(indexes('google_app_codes')).toEqual(['idx_google_app_codes_user']);
    const sql = readFileSync(new URL('../../migrations/0013_apple_sign_in.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
    expect(sql.match(/\b(CREATE TABLE|CREATE UNIQUE INDEX|CREATE INDEX|ALTER TABLE users ADD COLUMN)\b/g)).toHaveLength(5);
    expect(sql).not.toMatch(/^\s*(DROP|UPDATE|DELETE|INSERT|REPLACE)\b/im);
  });

  it('0014 adds sign_in_flows with its cascade; additive only', () => {
    expect(columns('sign_in_flows').slice(0, 6)).toEqual([
      ['id', 'TEXT', 0, 1], ['kind', 'TEXT', 1, 0], ['user_id', 'TEXT', 1, 0], ['session_id', 'TEXT', 1, 0], ['expires_at', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0],
    ]);
    expect(keys('sign_in_flows')).toEqual([['user_id', 'users', 'id', 'CASCADE']]);
    expect(indexes('sign_in_flows')).toEqual(['idx_sign_in_flows_user']);
    const sql = readFileSync(new URL('../../migrations/0014_sign_in_flows.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
    expect(sql.match(/\b(CREATE TABLE|CREATE INDEX)\b/g)).toHaveLength(2);
    expect(sql).not.toMatch(/^\s*(ALTER|DROP|UPDATE|DELETE|INSERT|REPLACE)\b/im);
    account('a', 'a@split.test');
    const now = new Date().toISOString();
    db.exec("INSERT INTO sign_in_flows (id, kind, user_id, session_id, expires_at, created_at) VALUES ('h', 'link', 'a', 's', ?, ?)", now, now);
    db.exec('DELETE FROM users WHERE id = ?', 'a');
    expect(flowRows()).toEqual([]);
  });

  it('0015 adds sign_in_flows.state_hash, pending_links and google_sign_in_codes, with their keys; additive only', () => {
    expect(columns('sign_in_flows').at(-1)).toEqual(['state_hash', 'TEXT', 0, 0]);
    expect(columns('pending_links')).toEqual([
      ['id', 'TEXT', 0, 1], ['user_id', 'TEXT', 1, 0], ['session_id', 'TEXT', 1, 0], ['provider', 'TEXT', 1, 0], ['sub', 'TEXT', 1, 0], ['email', 'TEXT', 0, 0],
      ['client_id', 'TEXT', 0, 0], ['refresh_token', 'TEXT', 0, 0], ['expires_at', 'TEXT', 1, 0], ['created_at', 'TEXT', 1, 0],
    ]);
    expect(keys('pending_links')).toEqual([['user_id', 'users', 'id', 'CASCADE']]);
    expect(indexes('pending_links')).toEqual(['idx_pending_links_user']);
    expect(columns('google_sign_in_codes')).toEqual([
      ['id', 'TEXT', 0, 1], ['challenge', 'TEXT', 1, 0], ['identity', 'TEXT', 1, 0], ['expires_at', 'TEXT', 1, 0], ['used_at', 'TEXT', 0, 0], ['created_at', 'TEXT', 1, 0],
    ]);
    expect(keys('google_sign_in_codes')).toEqual([]);
    const sql = readFileSync(new URL('../../migrations/0015_sign_in_review.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
    expect(sql.match(/\b(CREATE TABLE|CREATE INDEX|ALTER TABLE sign_in_flows ADD COLUMN)\b/g)).toHaveLength(4);
    expect(sql).not.toMatch(/^\s*(DROP|UPDATE|DELETE|INSERT|REPLACE)\b/im);
    account('a', 'a@split.test');
    const now = new Date().toISOString();
    db.exec("INSERT INTO pending_links (id, user_id, session_id, provider, sub, expires_at, created_at) VALUES ('h', 'a', 's', 'google', 'g', ?, ?)", now, now);
    db.exec('DELETE FROM users WHERE id = ?', 'a');
    expect(pendingRows()).toEqual([]);
  });

  it('a binding from before 0015 (no state_hash) is never found: its flow ends in state, never a link', async () => {
    account('gino', 'gino@split.test', { confirmed: true });
    const me = await signedIn('gino');
    const s = await webStart('?link=1', { ...FROM_APP, Cookie: me.cookie });
    db.exec('UPDATE sign_in_flows SET state_hash = NULL');
    expect(linkResult(await webCallback(s), 'apple')).toBe('state');
    expect(pendingRows()).toEqual([]);
  });

  it('two accounts can never hold the same Apple ID; many hold none; deleting an account takes its rows', () => {
    account('a', 'a@split.test', { appleSub: SUB });
    account('b', 'b@split.test');
    account('c', null);
    expect(() => db.exec('UPDATE users SET apple_sub = ? WHERE id = ?', SUB, 'b')).toThrow(/UNIQUE constraint failed: users\.apple_sub/);
    const now = new Date().toISOString();
    db.exec('INSERT INTO apple_grants (user_id, client_id, refresh_token, created_at) VALUES (?, ?, ?, ?)', 'a', APP_ID, 'r', now);
    expect(() => db.exec('INSERT INTO apple_grants (user_id, client_id, refresh_token, created_at) VALUES (?, ?, ?, ?)', 'a', APP_ID, 'r2', now)).toThrow(/UNIQUE|PRIMARY/);
    db.exec("INSERT INTO google_app_codes (id, kind, user_id, expires_at, created_at) VALUES ('h', 'link', 'a', ?, ?)", now, now);
    db.exec('DELETE FROM users WHERE id = ?', 'a');
    expect(db.rows('SELECT 1 FROM apple_grants')).toEqual([]);
    expect(db.rows('SELECT 1 FROM google_app_codes')).toEqual([]);
  });
});
