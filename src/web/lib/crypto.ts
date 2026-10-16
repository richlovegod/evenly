// The typed password never leaves the device. The app sends a key derived from it with
// PBKDF2-SHA256 (210,000 iterations, salted with the account's email); the Worker stores only a
// light hash of that key. A stolen database therefore needs a full PBKDF2 per guess and per
// email, while sign-in stays within the Workers Free CPU limit.

const ITERATIONS = 210_000;

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Key sent instead of the password: "k1." + base64url(PBKDF2(password, "evenly-v1:" + email)). */
export async function passwordKey(email: string, password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = enc.encode('evenly-v1:' + email.trim().toLowerCase());
  const material = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, material, 256);
  return 'k1.' + b64url(new Uint8Array(bits));
}

/** The rule shown to people before anything is sent: at least 8 characters, not only spaces. */
export function passwordOk(pw: string): boolean {
  return pw.length >= 8 && pw.length <= 200 && pw.trim().length > 0;
}
