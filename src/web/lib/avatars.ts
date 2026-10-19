// Profile photos on this device (docs/SPEC.md section 8.1). An account's photo is at
// <API base>/api/users/<id>/avatar?v=<version>, the version coming with the person in the DTOs
// (UserDTO, MemberDTO, FriendDTO `avatar`). In cookie mode an <img> loads it with the session
// cookie, and the browser keeps it a year (a new photo is a new address). In bearer mode an <img>
// cannot send the token, so the photo is fetched with it and shown from an object URL. A photo that
// does not load (removed or replaced since, no connection) shows the initial instead, and is not
// asked for again until the browser is back online.

import { useEffect, useSyncExternalStore } from 'react';
import { API_BASE } from '../config';
import { authMode, getToken } from './api';

/** The address of an account's photo at this version. */
export function avatarUrl(userId: string, version: string): string {
  return `${API_BASE}/api/users/${encodeURIComponent(userId)}/avatar?v=${encodeURIComponent(version)}`;
}

let tick = 0;
const listeners = new Set<() => void>();

function changed(): void {
  tick++;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const snapshot = (): number => tick;

/** Addresses that did not load here. */
const failed = new Set<string>();

/** Bearer mode: object URLs of the photos fetched with `blobToken`, by address. */
const blobs = new Map<string, string>();
const loading = new Set<string>();
let blobToken: string | null = null;

/** A photo did not load: wherever it is drawn, the initial shows instead. */
export function noteAvatarFailed(url: string): void {
  if (failed.has(url)) return;
  failed.add(url);
  changed();
}

/** Ask again for every photo that did not load (the browser is back online). */
export function retryAvatars(): void {
  if (!failed.size) return;
  failed.clear();
  changed();
}

if (typeof window !== 'undefined') window.addEventListener('online', retryAvatars);

/**
 * Bearer mode: fetch a photo with the token, once, for the session that asks. useAvatarPhoto calls
 * it; it never throws (a failure shows the initial).
 */
export function loadAvatar(url: string): Promise<void> {
  const token = getToken();
  if (token !== blobToken) {
    // Signed out or into another account: what was fetched or refused before was that session's.
    for (const u of blobs.values()) URL.revokeObjectURL(u);
    blobs.clear();
    loading.clear();
    failed.clear();
    blobToken = token;
    changed();
  }
  if (!token || blobs.has(url) || loading.has(url) || failed.has(url)) return Promise.resolve();
  loading.add(url);
  return fetch(url, { headers: { Authorization: 'Bearer ' + token } })
    .then(async res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      if (blobToken === token) blobs.set(url, URL.createObjectURL(blob));
    })
    .catch(() => {
      if (blobToken === token) failed.add(url);
    })
    .finally(() => {
      if (blobToken === token) loading.delete(url);
      changed();
    });
}

export interface AvatarPhoto {
  /** What the <img> shows; null: draw the initial. */
  src: string | null;
  /** For the <img>'s onError. */
  onError: () => void;
}

const NONE: AvatarPhoto = { src: null, onError: () => undefined };

/**
 * The photo of the account `userId` at `version` (the DTO's `avatar`) while it can be shown here.
 * A placeholder (no userId), no photo (a null or missing version), one still on its way in bearer
 * mode, and one that did not load: src null.
 */
export function useAvatarPhoto(userId: string | null | undefined, version: string | null | undefined): AvatarPhoto {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const url = userId && version ? avatarUrl(userId, version) : null;
  const token = authMode() === 'bearer' ? getToken() : null;
  useEffect(() => {
    if (url && token) void loadAvatar(url);
  }, [url, token]);
  if (!url || failed.has(url)) return NONE;
  const src = authMode() === 'bearer' ? (token && token === blobToken ? blobs.get(url) ?? null : null) : url;
  return src ? { src, onError: () => noteAvatarFailed(url) } : NONE;
}
