// Ids made on this device: queued changes, comments, new entries and groups. Random v4 UUIDs, which
// the Worker's ID_RE takes. crypto.randomUUID came with Safari 15.4, and the build still targets
// Safari 15 (vite.config.ts), so an older one gets the same shape from crypto.getRandomValues (the
// store falls back the same way for BroadcastChannel and Web Locks, both 15.4 too).

export function newUuid(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // the RFC 4122 variant
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
