// Sign in with Google (services/google.ts and the /api/auth/google routes and /providers in
// routes/auth.ts; docs/SPEC.md section 3, Google): whether the button may show, the start (from
// the app only, the flow cookie's flags, what Google is sent, the page to come back to), the
// callback's checks (state, the code exchange, the id_token's signature, issuer, audience, expiry,
// nonce and verified email), which account signs in (linked by `sub`, linked by email with the
// email confirmed, or a new one), the session cookies, the per-IP limits, the key cache, what is
// logged, the export and account deletion. Runs the real Worker against the real schema in SQLite
// (d1-sqlite.ts) with https://split.test as the app's origin. fetch is a stub that plays Google's
// token endpoint and its keys; the id_tokens are signed in the test with an RSA key pair made by
// WebCrypto.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, hashPassword } from '../../src/worker/auth';
import { sha256Hex } from '../../src/worker/http';
import worker from '../../src/worker/index';
import {
  decodeFlow, FLOW_TTL_SEC, forgetGoogleKeys, GOOGLE_AUTH_URL, GOOGLE_JWKS_URL, GOOGLE_SCOPE, GOOGLE_TOKEN_URL, googleName, keepFor,
  pkceChallenge, safeReturn,
} from '../../src/worker/services/google';
import { TestD1 } from './d1-sqlite';

const SITE = 'https://split.test';
const SESSION = '__Host-evenly_session';
const MARKER = '__Host-evenly_user';
const FLOW = '__Host-evenly_google';
const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const SECRET = 'test-secret-value-not-real';
const CALLBACK = SITE + '/api/auth/google/callback';
/** The code Google hands back in the address. */
const CODE = '4/0AcodeFromGoogle-xyz';
const SUB = '109876543210987654321';

let db: TestD1;
/** Vars on top of the defaults (Google set up) for the calls that follow. */
let vars: Record<string, string | undefined>;

interface Sent {
  url: string;
  init: RequestInit;
}
/** Every request the Worker sent out (Google's token endpoint and keys only). */
let sent: Sent[];

// ---------- a test Google: a key pair, its JWKS and signed id_tokens ----------

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

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
const b64json = (o: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function signJwt(signer: Signer, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const head = b64json({ alg: 'RS256', kid: signer.kid, typ: 'JWT', ...header });
  const body = b64json(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer.privateKey, new TextEncoder().encode(head + '.' + body));
  return head + '.' + body + '.' + b64url(new Uint8Array(sig));
}

let google: Signer;
/** Another key pair (a forger's), for bad signatures. */
let forger: Signer;

beforeAll(async () => {
  google = await makeSigner('google-key-1');
  forger = await makeSigner('google-key-1');
});

/** What the next id_token says, on top of good claims for the flow's nonce; null for a key to drop. */
let claimsFor: (nonce: string) => Record<string, unknown>;
/** Signs the next id_token. */
let signWith: () => Signer;
/** How the token endpoint answers (the default: an id_token from claimsFor and signWith). */
let tokenAnswer: (body: URLSearchParams) => Promise<Response>;
/** The keys Google publishes, and their Cache-Control. */
let jwks: () => { keys: JsonWebKey[]; cacheControl: string };

function goodClaims(nonce: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    azp: CLIENT_ID,
    aud: CLIENT_ID,
    sub: SUB,
    email: 'abbie.lin@gmail.com',
    email_verified: true,
    name: 'Abbie Lin',
    given_name: 'Abbie',
    family_name: 'Lin',
    picture: 'https://lh3.googleusercontent.com/a/photo',
    iat: now,
    exp: now + 3600,
    nonce,
  };
}

/** The nonce of the flow the token endpoint is answering for (the test knows it from the cookie). */
let currentNonce = '';

beforeEach(() => {
  db = new TestD1();
  vars = {};
  sent = [];
  forgetGoogleKeys();
  // Every refused sign-in logs what failed (by name); the tests that care read it.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  claimsFor = goodClaims;
  signWith = () => google;
  jwks = () => ({ keys: [google.jwk], cacheControl: 'public, max-age=22000, must-revalidate, no-transform' });
  tokenAnswer = async () => {
    const id = await signJwt(signWith(), claimsFor(currentNonce));
    return Response.json({ access_token: 'ya29.access-token-value', expires_in: 3599, scope: GOOGLE_SCOPE, token_type: 'Bearer', id_token: id });
  };
  vi.stubGlobal('fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    sent.push({ url: u, init });
    if (u === GOOGLE_TOKEN_URL) return tokenAnswer(new URLSearchParams(String(init.body)));
    if (u === GOOGLE_JWKS_URL) {
      const k = jwks();
      return new Response(JSON.stringify({ keys: k.keys }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': k.cacheControl } });
    }
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
    GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: SECRET, ...vars,
  };
}

interface Res {
  status: number;
  headers: Headers;
  location: string;
  text: string;
  setCookies: string[];
}

async function call(method: string, url: string, headers: Record<string, string> = {}, body?: unknown): Promise<Res> {
  const h: Record<string, string> = { 'cf-connecting-ip': '203.0.113.7', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const req = new Request(url.startsWith('http') ? url : SITE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env() as never, ctx);
  const text = await res.text();
  return { status: res.status, headers: res.headers, location: res.headers.get('Location') ?? '', text, setCookies: res.headers.getSetCookie() };
}

interface SetCookie {
  name: string;
  value: string;
  attrs: string[];
}

function cookiesOf(r: Res): Record<string, SetCookie> {
  const out: Record<string, SetCookie> = {};
  for (const line of r.setCookies) {
    const [pair, ...attrs] = line.split(';').map(s => s.trim());
    const eq = pair.indexOf('=');
    out[pair.slice(0, eq)] = { name: pair.slice(0, eq), value: decodeURIComponent(pair.slice(eq + 1)), attrs: attrs.map(a => a.toLowerCase()) };
  }
  return out;
}

const cleared = (c: SetCookie | undefined): boolean => !!c && c.value === '' && c.attrs.includes('max-age=0');

/** A tap on the button in the app: a same-origin page load. */
const FROM_APP = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
/** Google sending the browser back: a cross-site page load. */
const FROM_GOOGLE = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };

interface Started {
  res: Res;
  /** The flow cookie as the browser sends it back. */
  cookie: string;
  state: string;
  nonce: string;
  verifier: string;
  google: URL;
}

async function start(query = '?return=%2Fjoin%2Fabc&locale=en', headers: Record<string, string> = FROM_APP): Promise<Started> {
  const res = await call('GET', '/api/auth/google/start' + query, headers);
  expect(res.status, res.location).toBe(302);
  const flowCookie = cookiesOf(res)[FLOW];
  expect(flowCookie, res.location).toBeDefined();
  const flow = decodeFlow(flowCookie.value)!;
  expect(flow).not.toBeNull();
  return { res, cookie: `${FLOW}=${flowCookie.value}`, state: flow.state, nonce: flow.nonce, verifier: flow.verifier, google: new URL(res.location) };
}

/** Google's redirect back, with the flow's cookie (and any other cookies the browser has). */
async function callback(s: Started, o: { query?: string; cookie?: string } = {}): Promise<Res> {
  currentNonce = s.nonce;
  const q = o.query ?? `?state=${encodeURIComponent(s.state)}&code=${encodeURIComponent(CODE)}&scope=email+profile+openid&authuser=0&prompt=consent`;
  const cookie = [s.cookie, o.cookie].filter(Boolean).join('; ');
  return call('GET', '/api/auth/google/callback' + q, { ...FROM_GOOGLE, ...(cookie ? { Cookie: cookie } : {}) });
}

/** The whole round trip, from the tap to the app. */
async function signIn(query?: string, cookie?: string): Promise<Res> {
  return callback(await start(query), { cookie });
}

/** The error code a redirect to 登入 carries ('' when it is not one). */
function errorOf(r: Res): string {
  const m = /^\/\?google_error=([a-z_]+)#\/login$/.exec(r.location);
  return m ? m[1] : '';
}

const userRows = () => db.rows<{ id: string; name: string; email: string | null; email_verified_at: string | null; google_sub: string | null; locale: string; currency: string }>('SELECT * FROM users ORDER BY created_at, rowid');
const sessionRows = () => db.rows<{ id: string; user_id: string }>('SELECT id, user_id FROM sessions');

/** An account from before email codes: an email nobody confirmed, a password. */
async function legacyAccount(name: string, email: string): Promise<string> {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  db.exec(
    'INSERT INTO users (id, name, email, pw_hash, color, activity_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, name, email, await hashPassword('old password 1'), '#2F6FB5', at, at, at,
  );
  return id;
}

// ---------- configuration ----------

describe('whether Google sign-in is offered', () => {
  it('GET /api/auth/providers says google: true once the id and the secret are set, on APP_URL\'s site', async () => {
    const r = await call('GET', '/api/auth/providers', { 'Sec-Fetch-Site': 'same-origin' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ google: true });
    expect(r.headers.get('Cache-Control')).toBe('no-store');
  });

  it('says false without an id, with the "SET_ME" placeholder, without the secret, or on another site of the same Worker', async () => {
    for (const v of [{ GOOGLE_CLIENT_ID: undefined }, { GOOGLE_CLIENT_ID: 'SET_ME' }, { GOOGLE_CLIENT_ID: ' SET_ME ' }, { GOOGLE_CLIENT_SECRET: undefined }, { GOOGLE_CLIENT_SECRET: '  ' }]) {
      vars = v;
      const r = await call('GET', '/api/auth/providers');
      expect(JSON.parse(r.text), JSON.stringify(v)).toEqual({ google: false });
    }
    vars = {};
    // Production also answers on workers.dev, whose callback is not registered at Google.
    const other = await call('GET', 'https://evenly-api.test/api/auth/providers');
    expect(JSON.parse(other.text)).toEqual({ google: false });
    // Local wrangler dev counts as the site.
    const local = await call('GET', 'http://127.0.0.1:8787/api/auth/providers');
    expect(JSON.parse(local.text)).toEqual({ google: true });
  });

  it('without the configuration, start and callback send people to 登入 with unavailable, set no flow and ask Google nothing', async () => {
    for (const v of [{ GOOGLE_CLIENT_ID: 'SET_ME' }, { GOOGLE_CLIENT_SECRET: undefined }]) {
      vars = v;
      const s = await call('GET', '/api/auth/google/start?return=%2F', FROM_APP);
      expect(s.status).toBe(302);
      expect(errorOf(s)).toBe('unavailable');
      expect(cookiesOf(s)[FLOW]).toBeUndefined();
      const cb = await call('GET', '/api/auth/google/callback?state=x&code=y', FROM_GOOGLE);
      expect(errorOf(cb)).toBe('unavailable');
    }
    expect(sent).toEqual([]);
  });
});

// ---------- the start ----------

describe('the start', () => {
  it('keeps the flow in an HttpOnly, Secure, SameSite=Lax __Host- cookie for 10 minutes and sends the browser to Google', async () => {
    const s = await start();
    const c = cookiesOf(s.res)[FLOW];
    expect(c.attrs).toEqual(expect.arrayContaining([`max-age=${FLOW_TTL_SEC}`, 'path=/', 'httponly', 'secure', 'samesite=lax']));
    expect(FLOW_TTL_SEC).toBe(600);
    expect(c.attrs.some(a => a.startsWith('domain'))).toBe(false);
    expect(s.res.headers.get('Cache-Control')).toBe('no-store');
    // Nothing else: no session cookie, no request to Google from the Worker yet.
    expect(Object.keys(cookiesOf(s.res))).toEqual([FLOW]);
    expect(sent).toEqual([]);

    expect(s.google.origin + s.google.pathname).toBe(GOOGLE_AUTH_URL);
    const p = s.google.searchParams;
    expect(Object.fromEntries(p)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      scope: 'openid email profile',
      state: s.state,
      nonce: s.nonce,
      code_challenge: await pkceChallenge(s.verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    // The verifier and the secret never go to the browser's address bar.
    expect(s.res.location).not.toContain(s.verifier);
    expect(s.res.location).not.toContain(SECRET);
    for (const v of [s.state, s.nonce, s.verifier]) expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([s.state, s.nonce, s.verifier]).size).toBe(3);
    // S256: base64url of SHA-256 of the verifier (RFC 7636's own example).
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('each start makes new random values', async () => {
    const a = await start();
    const b = await start();
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.verifier).not.toBe(b.verifier);
  });

  it('only from a page of this app: another site, or the address typed in, gets start; older Safari passes with its same-origin Referer', async () => {
    for (const h of [
      { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' },
      { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'navigate' },
      { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' },
      {},
      { Referer: 'https://evil.test/page' },
      { Referer: 'not a url' },
    ]) {
      const r = await call('GET', '/api/auth/google/start?return=%2F', h);
      expect(errorOf(r), JSON.stringify(h)).toBe('start');
      expect(cookiesOf(r)[FLOW], JSON.stringify(h)).toBeUndefined();
    }
    const old = await start('?return=%2F', { Referer: SITE + '/#/login' });
    expect(old.google.origin).toBe('https://accounts.google.com');
  });

  it('takes the language from ?locale=, else Accept-Language, else zh-TW', async () => {
    expect(decodeFlow(cookiesOf((await start('?locale=en')).res)[FLOW].value)!.locale).toBe('en');
    expect(decodeFlow(cookiesOf((await start('?locale=zh-TW')).res)[FLOW].value)!.locale).toBe('zh-TW');
    expect(decodeFlow(cookiesOf((await start('', { ...FROM_APP, 'Accept-Language': 'en-US,en;q=0.9' })).res)[FLOW].value)!.locale).toBe('en');
    expect(decodeFlow(cookiesOf((await start('', { ...FROM_APP, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' })).res)[FLOW].value)!.locale).toBe('zh-TW');
    expect(decodeFlow(cookiesOf((await start('', FROM_APP)).res)[FLOW].value)!.locale).toBe('zh-TW');
  });
});

describe('the page to come back to', () => {
  it('is a hash route of this app, never a URL; anything else is Home', () => {
    for (const ok of ['/', '/join/AbCd1234EfGh5678', '/claim/tok_en-1', '/g/0b6f/settle?from=a&to=b&amount=100', '/f/u%3Aabc']) expect(safeReturn(ok), ok).toBe(ok);
    for (const bad of [
      'https://evil.test/', '//evil.test', '/\\evil.test', 'javascript:alert(1)', '#/join/x', 'join/x', '', '/a b', '/a\nb', '/<script>',
      '/' + 'a'.repeat(300), '/welcome', '/login', '/login?x=1', undefined, 42, null,
    ]) {
      expect(safeReturn(bad), String(bad)).toBe('/');
    }
  });

  it('the start keeps it in the flow, and the callback opens it after "/#"', async () => {
    const evil = await start('?return=' + encodeURIComponent('https://evil.test/x'));
    expect(decodeFlow(cookiesOf(evil.res)[FLOW].value)!.returnTo).toBe('/');
    const r = await signIn('?return=' + encodeURIComponent('/g/0b6f/settle?from=a&to=b'));
    expect(r.location).toBe('/?google=new#/g/0b6f/settle?from=a&to=b');
    const none = await signIn('');
    expect(none.location).toBe('/?google=back#/');
  });

  it('a flow cookie edited by hand cannot carry another destination either', async () => {
    const s = await start('?return=%2Fjoin%2Fabc');
    const raw = JSON.parse(Buffer.from(cookiesOf(s.res)[FLOW].value, 'base64url').toString('utf8'));
    raw.r = 'https://evil.test/';
    const edited = Buffer.from(JSON.stringify(raw)).toString('base64url');
    const r = await callback({ ...s, cookie: `${FLOW}=${edited}` });
    expect(r.location).toBe('/?google=new#/');
  });
});

// ---------- the callback ----------

describe('the callback signs in', () => {
  it('a new Google account makes an account with Google\'s given name, the email confirmed, the start\'s language, and a cookie session', async () => {
    const s = await start('?return=%2Fjoin%2Fabc&locale=en');
    const before = Date.now();
    const r = await callback(s);
    expect(r.status).toBe(302);
    expect(r.location).toBe('/?google=new#/join/abc');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');

    const users = userRows();
    expect(users).toHaveLength(1);
    const u = users[0];
    expect(u).toMatchObject({ name: 'Abbie', email: 'abbie.lin@gmail.com', google_sub: SUB, locale: 'en', currency: 'USD' });
    expect(Date.parse(u.email_verified_at!)).toBeGreaterThanOrEqual(before - 1000);

    const c = cookiesOf(r);
    expect(cleared(c[FLOW])).toBe(true);
    expect(c[SESSION].attrs).toEqual(expect.arrayContaining(['httponly', 'secure', 'samesite=lax', 'path=/']));
    expect(c[MARKER].value).toBe(u.id);
    const sessions = sessionRows();
    expect(sessions).toEqual([{ id: await sha256Hex(c[SESSION].value), user_id: u.id }]);

    // The code exchange: the code, the PKCE verifier, the secret and the same redirect_uri.
    const token = sent.filter(x => x.url === GOOGLE_TOKEN_URL);
    expect(token).toHaveLength(1);
    expect(token[0].init.method).toBe('POST');
    expect(token[0].init.redirect).toBe('manual');
    expect(new Headers(token[0].init.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(String(token[0].init.body)))).toEqual({
      grant_type: 'authorization_code', code: CODE, client_id: CLIENT_ID, client_secret: SECRET, redirect_uri: CALLBACK, code_verifier: s.verifier,
    });

    // The app then works with that cookie, and says Google is linked.
    const me = await call('GET', '/api/me', { 'Sec-Fetch-Site': 'same-origin', Cookie: `${SESSION}=${c[SESSION].value}; ${MARKER}=${u.id}` });
    expect(me.status).toBe(200);
    expect(JSON.parse(me.text).user).toMatchObject({ id: u.id, name: 'Abbie', email: 'abbie.lin@gmail.com', emailVerified: true, googleLinked: true, hasPassword: false });
  });

  it('zh-TW gets TWD; a missing given name takes the full name, trimmed to 60 characters without splitting one', async () => {
    claimsFor = nonce => ({ ...goodClaims(nonce), given_name: '  ', name: '  ' + '林'.repeat(59) + '😀😀 ' });
    await signIn('?locale=zh-TW');
    const u = userRows()[0];
    expect(u.locale).toBe('zh-TW');
    expect(u.currency).toBe('TWD');
    expect(u.name).toBe('林'.repeat(59));
    expect(googleName({ givenName: '', name: '', email: 'leo.chen@gmail.com' })).toBe('leo.chen');
    expect(googleName({ givenName: ' Leo ', name: 'Leo Chen', email: 'x@y.com' })).toBe('Leo');
    expect(googleName({ givenName: 'a'.repeat(70), name: '', email: 'x@y.com' })).toBe('a'.repeat(60));
  });

  it('the account linked to this Google account signs in again (back), whatever its email is now', async () => {
    await signIn();
    const [u] = userRows();
    db.exec('UPDATE users SET email = ? WHERE id = ?', 'abbie@other.test', u.id);
    const r = await signIn('?return=%2Factivity');
    expect(r.location).toBe('/?google=back#/activity');
    expect(userRows()).toHaveLength(1);
    expect(cookiesOf(r)[MARKER].value).toBe(u.id);
  });

  it('an account with the email and no link gets linked (linked), and an unconfirmed email counts as confirmed from now on', async () => {
    const id = await legacyAccount('Abbie 林', 'abbie.lin@gmail.com');
    claimsFor = nonce => ({ ...goodClaims(nonce), email: 'Abbie.Lin@Gmail.com', name: 'Someone Else', given_name: 'Someone' });
    const r = await signIn();
    expect(r.location).toBe('/?google=linked#/join/abc');
    const rows = userRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, name: 'Abbie 林', email: 'abbie.lin@gmail.com', google_sub: SUB });
    expect(rows[0].email_verified_at).not.toBeNull();
    // The password stays (as after an email code).
    expect(db.rows<{ pw_hash: string | null }>('SELECT pw_hash FROM users WHERE id = ?', id)[0].pw_hash).not.toBeNull();
    expect(cookiesOf(r)[MARKER].value).toBe(id);
    // Next time it is the link that finds it.
    expect((await signIn()).location).toBe('/?google=back#/join/abc');
  });

  it('an email confirmed earlier keeps its date', async () => {
    const id = await legacyAccount('Abbie', 'abbie.lin@gmail.com');
    db.exec('UPDATE users SET email_verified_at = ? WHERE id = ?', '2026-10-01T00:00:00.000Z', id);
    await signIn();
    expect(userRows()[0].email_verified_at).toBe('2026-10-01T00:00:00.000Z');
  });

  it('an account with the email that is linked to another Google account is refused (linked_other), nothing changes', async () => {
    const id = await legacyAccount('Abbie', 'abbie.lin@gmail.com');
    db.exec('UPDATE users SET google_sub = ? WHERE id = ?', '111111111111111111111', id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await signIn();
    expect(errorOf(r)).toBe('linked_other');
    expect(userRows()).toHaveLength(1);
    expect(userRows()[0].google_sub).toBe('111111111111111111111');
    expect(sessionRows()).toEqual([]);
    expect(cookiesOf(r)[SESSION]).toBeUndefined();
    expect(cleared(cookiesOf(r)[FLOW])).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('replaces the session the browser\'s cookie held before, as any sign-in does', async () => {
    const oldId = await legacyAccount('Leo', 'leo@split.test');
    const oldToken = await createSession(db.d1, oldId, 'test');
    const r = await signIn(undefined, `${SESSION}=${oldToken}; ${MARKER}=${oldId}`);
    expect(r.location).toBe('/?google=new#/join/abc');
    const sessions = sessionRows();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].user_id).not.toBe(oldId);
    expect(sessions[0].id).toBe(await sha256Hex(cookiesOf(r)[SESSION].value));
  });
});

describe('the callback refuses', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  /** Nothing was made or signed in, and the flow is gone. */
  function nothingHappened(r: Res): void {
    expect(userRows()).toEqual([]);
    expect(sessionRows()).toEqual([]);
    const c = cookiesOf(r);
    expect(c[SESSION]).toBeUndefined();
    expect(cleared(c[FLOW])).toBe(true);
  }

  it('a state that is not the cookie\'s (state), and no flow cookie at all (state); Google is not asked', async () => {
    const s = await start();
    const r = await callback(s, { query: `?state=${'x'.repeat(43)}&code=${CODE}` });
    expect(errorOf(r)).toBe('state');
    nothingHappened(r);
    const none = await call('GET', `/api/auth/google/callback?state=${s.state}&code=${CODE}`, FROM_GOOGLE);
    expect(errorOf(none)).toBe('state');
    const empty = await callback(s, { query: `?code=${CODE}` });
    expect(errorOf(empty)).toBe('state');
    expect(sent).toEqual([]);
  });

  it('the flow works once: the same callback again finds no cookie (the first answer cleared it)', async () => {
    const s = await start();
    const first = await callback(s);
    expect(first.location).toBe('/?google=new#/join/abc');
    expect(cleared(cookiesOf(first)[FLOW])).toBe(true);
    const again = await call('GET', `/api/auth/google/callback?state=${s.state}&code=${CODE}`, FROM_GOOGLE);
    expect(errorOf(again)).toBe('state');
  });

  it('a person who said no on Google\'s page (denied), any other error from Google (failed)', async () => {
    const s = await start();
    const r = await callback(s, { query: `?error=access_denied&state=${s.state}` });
    expect(errorOf(r)).toBe('denied');
    nothingHappened(r);
    const other = await callback(await start(), { query: '?error=server_error' });
    expect(errorOf(other)).toBe('failed');
    expect(sent).toEqual([]);
  });

  it('a nonce that is not the flow\'s (failed)', async () => {
    claimsFor = () => goodClaims('n'.repeat(43));
    const r = await signIn();
    expect(errorOf(r)).toBe('failed');
    nothingHappened(r);
  });

  it('a token for another client (failed); an aud list must hold ours and azp must be ours', async () => {
    claimsFor = nonce => ({ ...goodClaims(nonce), aud: 'other-client.apps.googleusercontent.com' });
    expect(errorOf(await signIn())).toBe('failed');
    claimsFor = nonce => ({ ...goodClaims(nonce), aud: [CLIENT_ID, 'other'], azp: 'other' });
    expect(errorOf(await signIn())).toBe('failed');
    expect(userRows()).toEqual([]);
    claimsFor = nonce => ({ ...goodClaims(nonce), aud: [CLIENT_ID, 'other'], azp: CLIENT_ID });
    expect((await signIn()).location).toBe('/?google=new#/join/abc');
  });

  it('an expired token (failed), and one issued in the future (failed)', async () => {
    const now = Math.floor(Date.now() / 1000);
    claimsFor = nonce => ({ ...goodClaims(nonce), iat: now - 7200, exp: now - 3600 });
    const r = await signIn();
    expect(errorOf(r)).toBe('failed');
    nothingHappened(r);
    claimsFor = nonce => ({ ...goodClaims(nonce), exp: undefined });
    expect(errorOf(await signIn())).toBe('failed');
    claimsFor = nonce => ({ ...goodClaims(nonce), iat: now + 3600, exp: now + 7200 });
    expect(errorOf(await signIn())).toBe('failed');
  });

  it('another issuer (failed); both of Google\'s forms pass', async () => {
    claimsFor = nonce => ({ ...goodClaims(nonce), iss: 'https://accounts.evil.test' });
    expect(errorOf(await signIn())).toBe('failed');
    claimsFor = nonce => ({ ...goodClaims(nonce), iss: 'accounts.google.com' });
    expect((await signIn()).location).toBe('/?google=new#/join/abc');
  });

  it('a bad signature: a key Google does not publish under that id, an edited payload, another algorithm, an unknown key (failed)', async () => {
    signWith = () => forger;
    const r = await signIn();
    expect(errorOf(r)).toBe('failed');
    nothingHappened(r);
    signWith = () => google;
    tokenAnswer = async () => {
      const good = await signJwt(google, claimsFor(currentNonce));
      const [h, , sig] = good.split('.');
      const edited = b64json({ ...claimsFor(currentNonce), sub: 'someone-else' });
      return Response.json({ id_token: `${h}.${edited}.${sig}` });
    };
    expect(errorOf(await signIn())).toBe('failed');
    tokenAnswer = async () => {
      const t = await signJwt(google, claimsFor(currentNonce));
      const [, body] = t.split('.');
      return Response.json({ id_token: `${b64json({ alg: 'none', kid: google.kid })}.${body}.` });
    };
    expect(errorOf(await signIn())).toBe('failed');
    tokenAnswer = async () => Response.json({ id_token: await signJwt(google, claimsFor(currentNonce), { kid: 'unknown-key' }) });
    expect(errorOf(await signIn())).toBe('failed');
    tokenAnswer = async () => Response.json({ id_token: 'not.a.jwt!' });
    expect(errorOf(await signIn())).toBe('failed');
    expect(userRows()).toEqual([]);
  });

  it('an email Google has not verified (unverified), or no email (unverified)', async () => {
    claimsFor = nonce => ({ ...goodClaims(nonce), email_verified: false });
    const r = await signIn();
    expect(errorOf(r)).toBe('unverified');
    nothingHappened(r);
    claimsFor = nonce => ({ ...goodClaims(nonce), email_verified: undefined });
    expect(errorOf(await signIn())).toBe('unverified');
    claimsFor = nonce => ({ ...goodClaims(nonce), email: undefined });
    expect(errorOf(await signIn())).toBe('unverified');
    // An unverified email never links an account that has it.
    await legacyAccount('Abbie', 'abbie.lin@gmail.com');
    claimsFor = nonce => ({ ...goodClaims(nonce), email_verified: false });
    expect(errorOf(await signIn())).toBe('unverified');
    expect(userRows()[0].google_sub).toBeNull();
  });

  it('the token endpoint refusing the code (failed), not answering (failed), or answering without an id_token (failed)', async () => {
    tokenAnswer = async () => Response.json({ error: 'invalid_grant', error_description: 'Bad Request' }, { status: 400 });
    const r = await signIn();
    expect(errorOf(r)).toBe('failed');
    nothingHappened(r);
    tokenAnswer = async () => {
      throw new TypeError('network down');
    };
    expect(errorOf(await signIn())).toBe('failed');
    tokenAnswer = async () => Response.json({ access_token: 'ya29.x' });
    expect(errorOf(await signIn())).toBe('failed');
    tokenAnswer = async () => new Response('<html>', { status: 502 });
    expect(errorOf(await signIn())).toBe('failed');
  });

  it('logs only what failed: never the code, a token, the verifier, the secret or the address', async () => {
    const warn = vi.mocked(console.warn);
    const error = vi.mocked(console.error);
    tokenAnswer = async () => Response.json({ error: 'invalid_grant', error_description: 'Code ' + CODE + ' for abbie.lin@gmail.com' }, { status: 400 });
    await signIn();
    claimsFor = nonce => ({ ...goodClaims(nonce), email_verified: false });
    tokenAnswer = async () => Response.json({ id_token: await signJwt(google, claimsFor(currentNonce)) });
    const s = await start();
    await callback(s);
    const logged = [...warn.mock.calls, ...error.mock.calls].flat().map(String).join('\n');
    expect(logged).toContain('invalid_grant');
    for (const secret of [CODE, SECRET, 'abbie.lin@gmail.com', s.verifier, s.state, s.nonce, 'eyJ']) expect(logged).not.toContain(secret);
  });
});

// ---------- limits and keys ----------

describe('limits', () => {
  it('starts and callbacks per IP in 15 minutes (GOOGLE_IP_PER_15M): past it, 登入 with rate_limited', async () => {
    vars = { GOOGLE_IP_PER_15M: '2' };
    await start();
    await start();
    const third = await call('GET', '/api/auth/google/start?return=%2F', FROM_APP);
    expect(errorOf(third)).toBe('rate_limited');
    expect(cookiesOf(third)[FLOW]).toBeUndefined();
    // Another network still starts.
    const elsewhere = await call('GET', '/api/auth/google/start?return=%2F', { ...FROM_APP, 'cf-connecting-ip': '198.51.100.9' });
    expect(elsewhere.location.startsWith(GOOGLE_AUTH_URL)).toBe(true);

    const s = await start('?return=%2F', { ...FROM_APP, 'cf-connecting-ip': '198.51.100.9' });
    for (let i = 0; i < 2; i++) await call('GET', `/api/auth/google/callback?state=x&code=y`, FROM_GOOGLE);
    currentNonce = s.nonce;
    const late = await call('GET', `/api/auth/google/callback?state=${s.state}&code=${CODE}`, { ...FROM_GOOGLE, Cookie: s.cookie });
    expect(errorOf(late)).toBe('rate_limited');
    expect(sessionRows()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('the default is 20 of each', async () => {
    for (let i = 0; i < 20; i++) await start();
    expect(errorOf(await call('GET', '/api/auth/google/start', FROM_APP))).toBe('rate_limited');
  });
});

describe("Google's keys", () => {
  it('are fetched once and kept as long as Cache-Control says, then fetched again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T08:00:00Z'));
    jwks = () => ({ keys: [google.jwk], cacheControl: 'public, max-age=600' });
    await signIn();
    await signIn();
    expect(sent.filter(x => x.url === GOOGLE_JWKS_URL)).toHaveLength(1);
    vi.setSystemTime(new Date('2026-10-25T08:11:00Z'));
    await signIn();
    expect(sent.filter(x => x.url === GOOGLE_JWKS_URL)).toHaveLength(2);
  });

  it('a key id the kept set does not have is fetched again (Google rotated its keys)', async () => {
    await signIn();
    const next = await makeSigner('google-key-2');
    jwks = () => ({ keys: [google.jwk, next.jwk], cacheControl: 'public, max-age=22000' });
    signWith = () => next;
    const r = await signIn();
    expect(r.location).toBe('/?google=back#/join/abc');
    expect(sent.filter(x => x.url === GOOGLE_JWKS_URL)).toHaveLength(2);
  });

  it('no-store, no-cache or no max-age keeps nothing; Age counts; a day at most', () => {
    expect(keepFor('public, max-age=22000, must-revalidate, no-transform', null)).toBe(22000);
    expect(keepFor('public, max-age=22000', '2000')).toBe(20000);
    expect(keepFor('max-age=999999', null)).toBe(86400);
    expect(keepFor('no-store', null)).toBe(0);
    expect(keepFor('max-age=600, no-cache', null)).toBe(0);
    expect(keepFor(null, null)).toBe(0);
    expect(keepFor('max-age=60', '90')).toBe(0);
  });
});

// ---------- the account afterwards ----------

describe('the account afterwards', () => {
  async function signedIn(): Promise<{ id: string; cookie: string }> {
    const r = await signIn();
    const c = cookiesOf(r);
    return { id: c[MARKER].value, cookie: `${SESSION}=${c[SESSION].value}; ${MARKER}=${c[MARKER].value}` };
  }

  it('the export says Google is linked, never the Google account id', async () => {
    const me = await signedIn();
    const r = await call('GET', '/api/me/export', { 'Sec-Fetch-Site': 'same-origin', Cookie: me.cookie });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).user.googleLinked).toBe(true);
    expect(r.text).not.toContain(SUB);
    expect(r.text).not.toContain('google_sub');
  });

  it('no answer about the account carries the id', async () => {
    const me = await signedIn();
    for (const path of ['/api/me', '/api/auth/sessions']) {
      const r = await call('GET', path, { 'Sec-Fetch-Site': 'same-origin', Cookie: me.cookie });
      expect(r.status, path).toBe(200);
      expect(r.text, path).not.toContain(SUB);
    }
  });

  it('deleting the account deletes the link with it: the same Google account then makes a new account', async () => {
    const me = await signedIn();
    const del = await call('DELETE', '/api/me', { 'Sec-Fetch-Site': 'same-origin', Origin: SITE, Cookie: me.cookie }, {});
    expect(del.status).toBe(200);
    expect(userRows()).toEqual([]);
    const again = await signIn();
    expect(again.location).toBe('/?google=new#/join/abc');
    expect(userRows()[0].id).not.toBe(me.id);
  });

  it('accounts made other ways say googleLinked: false', async () => {
    const r = await call('POST', '/api/auth/signup', {}, { name: 'Leo' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).user.googleLinked).toBe(false);
  });

  it('two accounts can never hold the same Google account (the unique index)', async () => {
    const a = await legacyAccount('A', 'a@split.test');
    const b = await legacyAccount('B', 'b@split.test');
    db.exec('UPDATE users SET google_sub = ? WHERE id = ?', SUB, a);
    expect(() => db.exec('UPDATE users SET google_sub = ? WHERE id = ?', SUB, b)).toThrow(/UNIQUE constraint failed: users\.google_sub/);
    // Many accounts without one are fine.
    expect(db.rows('SELECT id FROM users WHERE google_sub IS NULL')).toHaveLength(1);
  });
});
