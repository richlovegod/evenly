// A group that failed to load (review-1106, B6a-14; features/groups/GroupPage.tsx): once a load has
// failed, the error page with 再試一次 stays while the next tries run in the background (every 20 s,
// or the button), its button spinning, instead of the page going back to the skeleton each time.
// Rendered with react-dom/server; the API is a stand-in (lib/api.ts apiRaw).

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

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
});

vi.mock('../../src/web/lib/api', async importOriginal => {
  const mod = await importOriginal<typeof import('../../src/web/lib/api')>();
  return { ...mod, apiRaw: vi.fn() };
});

import { GroupPage } from '../../src/web/features/groups/GroupPage';
import { ApiError, apiRaw } from '../../src/web/lib/api';
import { setLocale } from '../../src/web/lib/i18n';
import { actions } from '../../src/web/lib/store';

const render = () => renderToStaticMarkup(createElement(GroupPage, { gid: 'g-down', tab: 'expenses' }));

describe('a group that cannot load', () => {
  it('keeps its error page while the next try runs, with the button spinning', async () => {
    setLocale('zh-TW');
    vi.mocked(apiRaw).mockRejectedValueOnce(new ApiError(0, 'offline', 'offline'));
    await actions.loadGroup('g-down');
    let html = render();
    expect(html).toContain('現在無法載入這個群組');
    expect(html).toContain('再試一次');
    expect(html).not.toContain('aria-busy="true"');

    // The next try never answers (a connection that swallows requests): still the error page.
    vi.mocked(apiRaw).mockReturnValueOnce(new Promise(() => undefined));
    void actions.loadGroup('g-down', { force: true });
    html = render();
    expect(html).toContain('現在無法載入這個群組');
    expect(html).toContain('再試一次');
    // The button is busy (its spinner), not the page as a skeleton.
    expect(html).toMatch(/<button[^>]*aria-busy="true"/);
    expect(html).not.toContain('載入中');
  });
});
