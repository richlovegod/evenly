// Renders the PNG app icons from the logo, public/icons/icon.svg, in WebKit (the same Playwright
// install as tests/e2e):
//   icon-192.png, icon-512.png    the logo as drawn: the cream tile with round corners, clear outside
//   apple-touch-icon.png (180)    a full square tile (iOS rounds it and would turn clear corners black)
//   icon-maskable-512.png         a full square tile, the robot at 80 % so it stays inside the 80 %
//                                 safe circle Android crops to
//   node scripts/make-icons.cjs
const fs = require('fs');
const path = require('path');
const { webkit } = require('C:/Users/chunju/.claude/tmp/webkit-test/node_modules/playwright');

const DIR = path.join(__dirname, '..', 'public', 'icons');
const src = fs.readFileSync(path.join(DIR, 'icon.svg'), 'utf8');
const TILE = /<rect width="512" height="512" rx="96" fill="(#[0-9A-Fa-f]{6})"\/>/;
const tile = src.match(TILE);
if (!tile) throw new Error('icon.svg: the cream tile rect was not found');
const cream = tile[1];
const robot = src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^[\s\S]*?<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '')
  .replace(TILE, '')
  .trim();

const svg = (size, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">${inner}</svg>`;
// The robot spans x 129 to 383 and y 38 to 452 (strokes included): centered across, 245 down.
const shapes = {
  any: size => svg(size, `<rect width="512" height="512" rx="96" fill="${cream}"/>${robot}`),
  square: size => svg(size, `<rect width="512" height="512" fill="${cream}"/>${robot}`),
  maskable: size => svg(size, `<rect width="512" height="512" fill="${cream}"/><g transform="translate(256 256) scale(0.8) translate(-256 -245)">${robot}</g>`),
};
const outputs = [
  ['icon-192.png', 192, 'any'],
  ['icon-512.png', 512, 'any'],
  ['apple-touch-icon.png', 180, 'square'],
  ['icon-maskable-512.png', 512, 'maskable'],
];

(async () => {
  const browser = await webkit.launch();
  for (const [name, size, kind] of outputs) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${shapes[kind](size)}</body></html>`);
    await page.screenshot({ path: path.join(DIR, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log('wrote ' + name + ' (' + size + ', ' + kind + ')');
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
