// Validate crawlable content without JavaScript, and navigation with JavaScript.
const { chromium } = require('playwright');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.join(__dirname, '../site');
const server = http.createServer((req, res) => {
  let route = new URL(req.url, 'http://localhost').pathname;
  if (route.endsWith('/')) route += 'index.html';
  const file = path.join(root, route);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  if (file.endsWith('.html')) res.setHeader('Content-Security-Policy', fs.readFileSync(path.join(root, '_headers'), 'utf8').match(/Content-Security-Policy: (.+)/)[1].replace('upgrade-insecure-requests', ''));
  res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' })[path.extname(file)] || 'text/plain');
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(8903, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
  try {
    const urls = [...fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8').matchAll(/<loc>https:\/\/acedigitalsolutionsbiz.org([^<]*)<\/loc>/g)].map(m => m[1]);
    assert.equal(urls.length, 22);
    const noJS = await browser.newContext({ javaScriptEnabled: false });
    const page = await noJS.newPage();
    await page.route('https://**', route => route.abort());
    for (const route of urls.filter(u => /articles|about/.test(u))) {
      const response = await page.goto('http://127.0.0.1:8903' + route);
      assert.equal(response.status(), 200);
      assert.equal(await page.locator('h1:visible').count(), 1, route);
      assert.equal(await page.locator('link[rel=canonical]').getAttribute('href'), 'https://acedigitalsolutionsbiz.org' + route);
      assert.equal(await page.locator('link[hreflang]').count(), 4);
      assert.ok((await page.locator('main').innerText()).length > 150, route);
      assert.equal(await page.locator('main script').count(), 0);
      for (const src of await page.locator('img[src^="/"]').evaluateAll(nodes => nodes.map(n => n.getAttribute('src')))) assert.ok(fs.existsSync(path.join(root, src)), route + ': ' + src);
      for (const text of await page.locator('script[type="application/ld+json"]').allTextContents()) JSON.parse(text);
      if (/articles\/.+/.test(route)) assert.ok((await page.locator('article').innerText()).length > 700, route);
      for (const raw of await page.locator('a[href^="/"]').evaluateAll(nodes => nodes.map(n => n.getAttribute('href')))) {
        const target = new URL(raw, 'http://localhost').pathname;
        assert.ok(fs.existsSync(path.join(root, target, target.endsWith('/') ? 'index.html' : '')), route + ': ' + raw);
      }
    }
    console.log('PASS 18 crawlable content pages without JavaScript, canonicals, language alternates and local links');
    await noJS.close();
    const context = await browser.newContext();
    const p = await context.newPage();
    await p.route('https://**', route => route.abort());
    const errors = [];
    await p.addInitScript(() => { window.__violations = []; document.addEventListener('securitypolicyviolation', e => window.__violations.push(e.violatedDirective)); });
    p.on('pageerror', e => errors.push(e.message));
    for (const base of ['/', '/bm/', '/zh/']) {
      await p.goto('http://127.0.0.1:8903' + base + '#post-website-cost-malaysia-2026');
      await p.waitForURL('**' + base + 'articles/website-cost-malaysia-2026/');
      assert.equal(await p.locator('h1:visible').count(), 1);
    }
    assert.deepEqual(errors, []);
    await p.setViewportSize({ width: 1440, height: 1000 });
    await p.goto('http://127.0.0.1:8903/articles/website-cost-malaysia-2026/');
    await p.screenshot({ path: path.join(__dirname, '../seo-desktop.png') });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.goto('http://127.0.0.1:8903/zh/articles/website-cost-malaysia-2026/');
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await p.locator('#burger').click();
    assert.equal(await p.locator('#burger').getAttribute('aria-expanded'), 'true');
    await p.keyboard.press('Escape');
    assert.equal(await p.locator('#burger').getAttribute('aria-expanded'), 'false');
    assert.deepEqual(await p.evaluate(() => window.__violations), []);
    assert.ok(await p.locator('#burger svg path').count());
    await p.waitForTimeout(350); // Let the existing menu close transition finish before the screenshot.
    await p.screenshot({ path: path.join(__dirname, '../seo-mobile-zh.png') });
    console.log('PASS legacy article links in all languages, mobile overflow and keyboard menu behavior');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
