// Profile photos in the app. The resize helper (features/account/avatarPhoto.ts: the middle
// square, 256 x 256, JPEG 0.85) with the decoder and the canvas faked on globalThis; and Avatar
// (components/Avatar.tsx with lib/avatars.ts): the photo in an <img> when the person has one, the
// initial in the same size and outline when it does not load, and in bearer mode the photo fetched
// with the token. Rendered with react-dom/server, so no DOM is needed.

import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class MemoryStorage {
    readonly map = new Map<string, string>();
    getItem(k: string): string | null {
      return this.map.get(k) ?? null;
    }
    setItem(k: string, v: string): void {
      this.map.set(k, String(v));
    }
    removeItem(k: string): void {
      this.map.delete(k);
    }
  }
  const storage = new MemoryStorage();
  // config.ts reads both as it loads: the API on this page's own origin, so cookie mode.
  storage.setItem('evenly.api', 'same-origin');
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage = storage;
  g.location = { origin: 'https://split.test', href: 'https://split.test/', pathname: '/', search: '', hash: '' };
  return { storage };
});

import { Avatar, AvatarStack, type AvatarProps } from '../../src/web/components/Avatar';
import { AVATAR_QUALITY, AVATAR_SIDE, AvatarPhotoError, avatarErrorText, avatarImage, centerSquare } from '../../src/web/features/account/avatarPhoto';
import { ApiError } from '../../src/web/lib/api';
import { avatarUrl, retryAvatars } from '../../src/web/lib/avatars';

afterEach(() => {
  vi.unstubAllGlobals();
  retryAvatars();
});

// ---------- the resize helper ----------

/** A canvas that records what is drawn on it and what it is encoded as. */
function fakeCanvas() {
  const ctx = {
    fillStyle: '',
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    fills: [] as { style: string; rect: number[] }[],
    draws: [] as unknown[][],
    fillRect(...rect: number[]) {
      this.fills.push({ style: this.fillStyle, rect });
    },
    drawImage(...args: unknown[]) {
      this.draws.push(args);
    },
  };
  const canvas = {
    width: 300,
    height: 150,
    /** [type, quality, width, height] of each toDataURL. */
    encoded: [] as [string, number, number, number][],
    result: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    getContext: (kind: string) => (kind === '2d' ? ctx : null),
    toDataURL(type: string, quality: number) {
      this.encoded.push([type, quality, this.width, this.height]);
      return this.result;
    },
  };
  return { canvas, ctx };
}

/** The browser around avatarImage: createImageBitmap decodes a `width` x `height` photo onto this canvas. */
function fakeBrowser(width: number, height: number, opts: { decodes?: boolean } = {}) {
  const { canvas, ctx } = fakeCanvas();
  const bitmap = { width, height, close: vi.fn() };
  const decode = vi.fn(async () => {
    if (opts.decodes === false) throw new Error('InvalidStateError');
    return bitmap;
  });
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal('document', { createElement: (tag: string) => (tag === 'canvas' ? canvas : null), cookie: '', documentElement: {} });
  return { canvas, ctx, bitmap, decode };
}

const photo = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' });

describe('centerSquare', () => {
  it('takes the largest square from the middle', () => {
    expect(centerSquare(4032, 3024)).toEqual({ x: 504, y: 0, side: 3024 });
    expect(centerSquare(3024, 4032)).toEqual({ x: 0, y: 504, side: 3024 });
    expect(centerSquare(256, 256)).toEqual({ x: 0, y: 0, side: 256 });
    expect(centerSquare(401, 300)).toEqual({ x: 50, y: 0, side: 300 });
    expect(centerSquare(1, 9)).toEqual({ x: 0, y: 4, side: 1 });
  });
});

describe('avatarImage', () => {
  it('draws the middle square of a landscape photo at 256 x 256 on white, as a JPEG at 0.85', async () => {
    const b = fakeBrowser(4032, 3024);
    const url = await avatarImage(photo);
    expect(url).toBe(b.canvas.result);
    // Decoded with the camera's orientation applied.
    expect(b.decode).toHaveBeenCalledWith(photo, { imageOrientation: 'from-image' });
    expect(b.ctx.fills).toEqual([{ style: '#fff', rect: [0, 0, AVATAR_SIDE, AVATAR_SIDE] }]);
    expect(b.ctx.draws).toEqual([[b.bitmap, 504, 0, 3024, 3024, 0, 0, 256, 256]]);
    expect(b.ctx.imageSmoothingQuality).toBe('high');
    expect(b.canvas.encoded).toEqual([['image/jpeg', AVATAR_QUALITY, 256, 256]]);
    expect(AVATAR_QUALITY).toBe(0.85);
    // The memory goes back right away.
    expect(b.bitmap.close).toHaveBeenCalled();
    expect([b.canvas.width, b.canvas.height]).toEqual([0, 0]);
  });

  it('crops a portrait photo from the middle, and blows up a small one to 256', async () => {
    const tall = fakeBrowser(3024, 4032);
    await avatarImage(photo);
    expect(tall.ctx.draws[0].slice(1)).toEqual([0, 504, 3024, 3024, 0, 0, 256, 256]);
    vi.unstubAllGlobals();
    const small = fakeBrowser(100, 60);
    await avatarImage(photo);
    expect(small.ctx.draws[0].slice(1)).toEqual([20, 0, 60, 60, 0, 0, 256, 256]);
  });

  it('throws AvatarPhotoError when the file cannot be opened or the canvas gives nothing back', async () => {
    // createImageBitmap fails and there is no <img> to fall back on.
    fakeBrowser(10, 10, { decodes: false });
    await expect(avatarImage(photo)).rejects.toBeInstanceOf(AvatarPhotoError);
    vi.unstubAllGlobals();
    const empty = fakeBrowser(10, 10);
    empty.canvas.result = 'data:,';
    await expect(avatarImage(photo)).rejects.toBeInstanceOf(AvatarPhotoError);
    expect(empty.bitmap.close).toHaveBeenCalled();
    vi.unstubAllGlobals();
    fakeBrowser(0, 0);
    await expect(avatarImage(photo)).rejects.toBeInstanceOf(AvatarPhotoError);
  });

  it('says what went wrong', () => {
    expect(avatarErrorText(new AvatarPhotoError())).toBe('This photo cannot be opened. Try another one.');
    expect(avatarErrorText(new ApiError(400, 'bad_request', 'The photo is not a JPEG', { fields: ['image'] }))).toBe('This photo cannot be used. Try another one.');
    expect(avatarErrorText(new ApiError(413, 'payload_too_large', 'too large'))).toBe('This photo cannot be used. Try another one.');
    expect(avatarErrorText(new ApiError(429, 'rate_limited', 'Too many', { retryAfter: 60 }))).toBe('You have changed your photo too many times today. Try again tomorrow.');
    expect(avatarErrorText(new ApiError(0, 'offline', 'No connection'))).toBe('No connection. Try again when you are online.');
  });
});

// ---------- Avatar ----------

/** Avatar rendered once, and the element it returned (to reach the <img> and its onError). */
function render(props: AvatarProps): { html: string; el: ReactElement<{ children?: unknown }> } {
  let el: ReactElement<{ children?: unknown }> | null = null;
  const Probe = () => {
    el = Avatar(props) as ReactElement<{ children?: unknown }>;
    return el;
  };
  const html = renderToStaticMarkup(createElement(Probe));
  return { html, el: el! };
}

/** The style attribute of the sticker: its size and outline. (React puts a preload <link> for an <img> first.) */
const styleOf = (html: string): string => /<span[^>]* style="([^"]*)"/.exec(html)?.[1] ?? '';

const ABBIE: AvatarProps = { name: 'Abbie', color: '#C2410C', userId: 'u-abbie', avatar: 'a1b2c3d4e5f60718' };

describe('Avatar', () => {
  it('shows the photo in an <img> when the person has one, in the 2 px outline at the size asked', () => {
    const { html } = render(ABBIE);
    expect(html).toContain(`<img`);
    expect(html).toContain(`src="${avatarUrl('u-abbie', 'a1b2c3d4e5f60718')}"`);
    expect(avatarUrl('u-abbie', 'a1b2c3d4e5f60718')).toBe('/api/users/u-abbie/avatar?v=a1b2c3d4e5f60718');
    expect(html).toContain('alt=""');
    expect(html).not.toContain('>A<');
    expect(styleOf(html)).toContain('--av-line:2px');
    expect(styleOf(html)).toContain('width:40px;height:40px');
    expect(styleOf(render({ ...ABBIE, size: 26 }).html)).toContain('width:26px;height:26px');
  });

  it('falls back to the initial, in the same size and outline, when the photo does not load', () => {
    const first = render(ABBIE);
    const img = first.el.props.children as ReactElement<{ src: string; onError: () => void }>;
    expect(img.type).toBe('img');
    img.props.onError();
    const after = render(ABBIE);
    expect(after.html).not.toContain('<img');
    expect(after.html).toMatch(/>A<\/span>$/);
    expect(styleOf(after.html)).toBe(styleOf(first.html));
    // Everywhere else the same photo is drawn, without asking for it again.
    expect(render({ ...ABBIE, size: 26, ring: true }).html).not.toContain('<img');
    // Back online, it is tried again.
    retryAvatars();
    expect(render(ABBIE).html).toContain('<img');
  });

  it('a new photo (another version) is tried even after the old one failed', () => {
    (render(ABBIE).el.props.children as ReactElement<{ onError: () => void }>).props.onError();
    expect(render(ABBIE).html).not.toContain('<img');
    expect(render({ ...ABBIE, avatar: 'ffffffffffffffff' }).html).toContain('src="/api/users/u-abbie/avatar?v=ffffffffffffffff"');
  });

  it('draws the initial without a photo: none, a placeholder, or a DTO kept from before the field existed', () => {
    const cases: AvatarProps[] = [
      { name: 'Kai', color: '#15803D', userId: 'u-kai', avatar: null },
      { name: 'Kai', color: '#15803D', userId: null, avatar: 'a1b2c3d4e5f60718' },
      { name: 'Kai', color: '#15803D', userId: 'u-kai' },
      { name: 'Kai', color: '#15803D' },
    ];
    for (const props of cases) {
      const { html } = render(props);
      expect(html).not.toContain('<img');
      expect(html).toMatch(/>K<\/span>$/);
    }
  });

  it('AvatarStack shows each person with a photo by it', () => {
    const html = renderToStaticMarkup(
      createElement(AvatarStack, {
        people: [
          { name: 'Gino', color: '#2F6FB5', userId: 'u-gino', avatar: '0123456789abcdef', ring: true },
          { name: 'Kai', color: '#15803D', userId: null, avatar: null },
        ],
      }),
    );
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).toContain('src="/api/users/u-gino/avatar?v=0123456789abcdef"');
    expect(html).toContain('>K</span>');
  });
});

// ---------- bearer mode ----------

describe('Avatar in bearer mode (the API on another origin)', () => {
  it('fetches the photo once with the token and shows it from an object URL; a refused one and another session show the initial', async () => {
    // A fresh copy of the modules with the API elsewhere (vite dev, tests): bearer mode.
    vi.resetModules();
    h.storage.setItem('evenly.api', 'https://api.test');
    try {
      const api = await import('../../src/web/lib/api');
      const avatars = await import('../../src/web/lib/avatars');
      const { Avatar: BearerAvatar } = await import('../../src/web/components/Avatar');
      expect(api.authMode()).toBe('bearer');
      const token = 'tok-' + 'x'.repeat(40);
      api.setToken(token, false);
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const html = (props: AvatarProps) => renderToStaticMarkup(createElement(BearerAvatar, props));

      const url = avatars.avatarUrl('u-abbie', 'a1b2c3d4e5f60718');
      expect(url).toBe('https://api.test/api/users/u-abbie/avatar?v=a1b2c3d4e5f60718');
      // Until it has come: the initial (an <img> could not send the token).
      expect(html(ABBIE)).not.toContain('<img');
      await avatars.loadAvatar(url);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]).toEqual([url, { headers: { Authorization: 'Bearer ' + token } }]);
      expect(html(ABBIE)).toMatch(/<img[^>]* src="blob:/);
      await avatars.loadAvatar(url);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // A photo the server refuses (replaced since: 404) shows the initial.
      fetchMock.mockResolvedValueOnce(new Response('{"error":{"code":"not_found","message":"Not found"}}', { status: 404 }));
      await avatars.loadAvatar(avatars.avatarUrl('u-abbie', 'old'));
      expect(html({ ...ABBIE, avatar: 'old' })).not.toContain('<img');

      // Another account on this device: what the first one fetched is not shown.
      api.setToken('tok-' + 'y'.repeat(40), false);
      expect(html(ABBIE)).not.toContain('<img');
    } finally {
      h.storage.setItem('evenly.api', 'same-origin');
      vi.resetModules();
    }
  });
});
