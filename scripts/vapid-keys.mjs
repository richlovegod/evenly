// Make a VAPID key pair for Web Push (RFC 8292) and store the private key as a Worker secret.
// The private key goes straight into `wrangler secret put` on stdin and is never printed or
// written to disk. Prints only the public key, which goes in wrangler.toml as VAPID_PUBLIC_KEY.
//   node scripts/vapid-keys.mjs              production (evenly-api)
//   node scripts/vapid-keys.mjs staging      staging (evenly-api-staging)
// A new pair makes every existing push subscription invalid (browsers bind a subscription to the
// public key), so only rotate when the old private key may have leaked.
import { spawn } from 'node:child_process';
import { webcrypto as crypto } from 'node:crypto';

const env = process.argv[2] === 'staging' ? 'staging' : null;

const b64url = bytes => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)); // 65 bytes, 0x04 || x || y
const secret = JSON.stringify({ kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y });

const args = ['wrangler', 'secret', 'put', 'VAPID_PRIVATE_JWK', ...(env ? ['--env', env] : [])];
const child = spawn('npx', args, { stdio: ['pipe', 'inherit', 'inherit'], shell: process.platform === 'win32' });
child.stdin.end(secret);
const code = await new Promise(resolve => child.on('close', resolve));
if (code !== 0) {
  console.error('wrangler secret put failed (exit ' + code + '); nothing to put in wrangler.toml');
  process.exit(1);
}
console.log('VAPID_PUBLIC_KEY' + (env ? ' (staging)' : '') + ' = "' + b64url(raw) + '"');
