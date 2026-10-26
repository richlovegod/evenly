// Renders the PNG app icons from the logo, public/icons/icon.svg, in WebKit (the same Playwright
// install as tests/e2e):
//   icon-192.png, icon-512.png    the logo as drawn: the cream tile with round corners, clear outside
//   apple-touch-icon.png (180)    a full square tile (iOS rounds it and would turn clear corners black)
//   icon-maskable-512.png         a full square tile, the robot at 80 % so it stays inside the 80 %
//                                 safe circle Android crops to
// and the link preview every shared link gets (index.html og:image and twitter:image):
//   ../og-image.png (1200 x 630)  the welcome page's picture at preview size: the robot standing on
//                                 a grass hill under a sky-tinted sky with two paper clouds, centered,
//                                 so a square crop (LINE's small preview) keeps the robot whole
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

// The preview's colors are the tokens of src/web/styles/tokens.css: --water-t sky, --paper clouds,
// --green hill, --pb-ink lines. The cloud is the welcome page's (WelcomePage.tsx Scene, 120 x 80).
const SKY = '#E6F2F8';
const PAPER = '#FFFCF6';
const GRASS = '#B9DAA5';
const INK = '#3E3A39';
const CLOUD = 'M9 23h21a4.6 4.6 0 0 0-1.5-9A6.6 6.6 0 0 0 15.8 12 5.6 5.6 0 0 0 9 23z';
const OG = { name: path.join(__dirname, '..', 'public', 'og-image.png'), width: 1200, height: 630 };
const ogSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="${SKY}"/>
  <g fill="${PAPER}" stroke="${INK}" stroke-width="9" stroke-linejoin="round" stroke-linecap="round">
    <path transform="translate(60 40) scale(7)" vector-effect="non-scaling-stroke" d="${CLOUD}"/>
    <path transform="translate(880 100) scale(5)" vector-effect="non-scaling-stroke" d="${CLOUD}"/>
  </g>
  <path d="M-10 540q310-60 610 0t610 0v100H-10z" fill="${GRASS}" stroke="${INK}" stroke-width="9" stroke-linejoin="round"/>
  <g transform="translate(600 318) scale(1.08) translate(-256 -245)">${robot}</g>
</svg>`;

(async () => {
  const browser = await webkit.launch();
  for (const [name, size, kind] of outputs) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${shapes[kind](size)}</body></html>`);
    await page.screenshot({ path: path.join(DIR, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log('wrote ' + name + ' (' + size + ', ' + kind + ')');
  }
  const page = await browser.newPage({ viewport: { width: OG.width, height: OG.height }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><body style="margin:0">${ogSvg()}</body></html>`);
  await page.screenshot({ path: OG.name, clip: { x: 0, y: 0, width: OG.width, height: OG.height } });
  await page.close();
  console.log('wrote ' + path.basename(OG.name) + ' (' + OG.width + ' x ' + OG.height + ')');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
