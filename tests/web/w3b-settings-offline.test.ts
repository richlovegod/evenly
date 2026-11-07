// 設定 without a connection (review-1106, B6a-01; features/groups/SettingsTab.tsx): changing
// settings needs one, so the name box, the cover and the type are disabled, and the whiteboard is
// read-only (a door code in it can still be selected and copied) with a hint that says why.
// Whiteboard text that did not save is kept for the group (notesDrafts) and shown again when the
// tab opens, saying it is not saved yet. Also the invite card's note (B6b-11). Rendered with
// react-dom/server, offline from the start (navigator.onLine is false as the store loads).

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const map = new Map<string, string>([['evenly.api', 'same-origin']]);
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage ??= storage;
  g.sessionStorage ??= storage;
  g.location ??= { origin: 'https://split.test', href: 'https://split.test/', pathname: '/', search: '', hash: '' };
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false, userAgent: 'test' }, configurable: true, writable: true });
});

import type { GroupSnapshotDTO, MemberDTO } from '../../src/shared/types';
import { InviteCard } from '../../src/web/features/groups/InviteCard';
import { notesDrafts, SettingsTab } from '../../src/web/features/groups/SettingsTab';
import { getLocale, setLocale } from '../../src/web/lib/i18n';
import { getState, type GroupView } from '../../src/web/lib/store';

const startLocale = getLocale();
afterEach(() => {
  setLocale(startLocale);
  notesDrafts.clear();
});

function member(id: string, name: string, over: Partial<MemberDTO> = {}): MemberDTO {
  return {
    id, groupId: 'g1', userId: null, name, color: '#2F6FB5', role: 'member', active: true, sort: 0,
    createdAt: '2026-10-01T00:00:00.000Z', claimedAt: null, payInfo: '', venmo: '', paypal: '', avatar: null, ...over,
  };
}

const snap: GroupSnapshotDTO = {
  group: {
    id: 'g1', name: '北海道', type: 'trip', currency: 'TWD', emoji: '⛷️', color: '#2F6FB5', simplify: true, notes: '集合：札幌站',
    createdBy: 'u-gino', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', version: 1, defaultSplit: null,
  },
  members: [member('m-gino', 'Gino', { userId: 'u-gino', role: 'admin' }), member('m-abbie', 'Abbie', { userId: 'u-abbie' })],
  expenses: [],
  me: { memberId: 'm-gino', role: 'admin' },
  inviteCode: 'INVITE1234',
};
const view: GroupView = { snap, pending: {}, pendingComments: {}, pendingPhotos: {}, pendingReceipts: {}, loading: false, error: null };
const render = () => renderToStaticMarkup(createElement(SettingsTab, { gid: 'g1', view }));

/** The opening tag of the element with this data-testid. */
function tagOf(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  if (at < 0) throw new Error('no ' + testId);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

describe('設定 offline', () => {
  it('starts offline here', () => {
    expect(getState().online).toBe(false);
  });

  it('disables the name, the cover and the type, and makes the whiteboard read-only', () => {
    setLocale('zh-TW');
    const html = render();
    expect(tagOf(html, 'settings-name')).toContain('disabled=""');
    expect(tagOf(html, 'settings-type-home')).toContain('disabled=""');
    const notes = tagOf(html, 'settings-notes');
    // React writes the attribute as readOnly (HTML attribute names ignore case).
    expect(notes).toContain('readOnly=""');
    expect(notes).not.toContain('disabled');
    expect(html).toContain('離線中，連上網路才能修改白板');
    // The cover picker's emoji and colors.
    expect(html).toMatch(/aria-label="⛷️"[^>]*disabled=""/);
    setLocale('en');
    expect(render()).toContain('You are offline. Connect to edit the whiteboard');
  });

  it('shows whiteboard text that did not save, and says it saves once back online', () => {
    setLocale('zh-TW');
    notesDrafts.set('g1:m-gino', { text: 'Airbnb 門鎖 4321', base: '集合：札幌站' });
    const html = render();
    expect(html).toContain('Airbnb 門鎖 4321</textarea>');
    expect(html).toContain('還沒存到，連上網路後會自動儲存');
    // Another member's draft for the same group is not mine.
    notesDrafts.clear();
    notesDrafts.set('g1:m-abbie', { text: '別人的草稿', base: '' });
    expect(render()).not.toContain('別人的草稿');
  });
});

describe('the invite card (B6b-11)', () => {
  it('says joining takes an email code, not that no sign-up is needed', () => {
    setLocale('zh-TW');
    const html = renderToStaticMarkup(createElement(InviteCard, { gid: 'g1', snap }));
    expect(html).toContain('打開後選自己的名字，用 Email 收驗證碼就加入了，不用下載 App');
    expect(html).not.toContain('不用註冊');
    setLocale('en');
    expect(renderToStaticMarkup(createElement(InviteCard, { gid: 'g1', snap }))).toContain('They pick their own name and confirm an email code to join, no app to install');
  });
});
