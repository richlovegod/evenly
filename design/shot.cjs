// Screenshot an HTML file or URL in WebKit (Safari's engine) with iPhone emulation.
// Usage: node shot.cjs <html file or URL> <png out> [device name, default "iPhone 14"]
// FULL=1 for a full-page screenshot.
const path = require('path');
const { webkit, devices } = require('C:/Users/chunju/.claude/tmp/webkit-test/node_modules/playwright');

(async () => {
  const [target, out, dev] = process.argv.slice(2);
  if (!target || !out) {
    console.log('usage: node shot.cjs <file|url> <out.png> [device]');
    process.exit(2);
  }
  const url = /^https?:/.test(target) ? target : 'file:///' + path.resolve(target).replace(/\\/g, '/');
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...devices[dev || 'iPhone 14'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: out, fullPage: process.env.FULL === '1' });
  const overflow = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const bad = [];
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > w + 1 || r.left < -1)) bad.push(el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : '') + ' right=' + Math.round(r.right));
    });
    return { viewport: w, scrollWidth: document.documentElement.scrollWidth, offenders: bad.slice(0, 10) };
  });
  console.log('saved ' + out);
  console.log('layout: ' + JSON.stringify(overflow));
  if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
