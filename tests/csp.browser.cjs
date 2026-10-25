// CSP test (Red Team L-1): serves site/ with the generated policy ENFORCED and checks that every page,
// the enquiry form (+Turnstile), the chatbot and the demo chat work with zero CSP violations.
// All network calls are mocked. Run: NODE_PATH=$(npm root -g) node tests/csp.browser.cjs [site-dir] [--report-only]
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, '..', 'site'));
const raw = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8').match(/Content-Security-Policy(?:-Report-Only)?: (.+)/)[1];
const ENFORCE = !process.argv.includes('--report-only');
const HDR = ENFORCE ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';
const csp = raw.replace("upgrade-insecure-requests", "").replace(/;\s*$/, "");   // local test server is http
const srv = http.createServer((q, s) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, p);
  if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  const ct = { '.html': 'text/html', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.css': 'text/css', '.js': 'text/javascript' }[path.extname(f)] || 'application/octet-stream';
  s.writeHead(200, { 'Content-Type': ct, ...(ct === 'text/html' ? { [HDR]: csp } : {}) }); fs.createReadStream(f).pipe(s); }).listen(8896);
const TURNSTILE = 'window.turnstile={render:(el,o)=>{window.__ts=o;return 1},getResponse:()=>"TOKEN",reset:()=>{}};setTimeout(()=>{window.onAceCaptcha&&window.onAceCaptcha();window.onTurnstileLoad&&window.onTurnstileLoad()},10);';
(async () => {
  const b = await chromium.launch(); let fails = 0;
  const check = async (name, url, act, vw = { width: 1200, height: 900 }) => {
    const p = await b.newPage({ viewport: vw }); const viol = [], errs = [];
    await p.addInitScript(() => { window.__viol = []; document.addEventListener('securitypolicyviolation', e => window.__viol.push(e.violatedDirective + ' ' + (e.blockedURI || 'inline'))); });
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) viol.push(m.text().slice(0, 140)); });
    await p.route(/^https?:\/\/(?!localhost)/, r => r.abort());
    await p.route('**/challenges.cloudflare.com/**', r => r.fulfill({ contentType: 'text/javascript', body: TURNSTILE }));
    await p.route('**/ace-wa-enquiry*.workers.dev/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"stage":"accepted_by_whatsapp"}' }));
    await p.route('**/ace-chat*.workers.dev/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(r.request().url().includes('summary') ? { summary: 'Test summary' } : { reply: 'The standard website is **RM1,600**.' }) }));
    await p.goto('http://localhost:8896' + url, { waitUntil: 'load' }); await p.waitForTimeout(400);
    let detail = ''; try { detail = (await act(p)) || ''; } catch (e) { detail = 'ACTION FAILED: ' + e.message.slice(0, 120); }
    await p.waitForTimeout(300);
    const v = [...new Set([...(await p.evaluate(() => window.__viol)), ...viol])];
    const ok = v.length === 0 && errs.length === 0 && !detail.startsWith('ACTION FAILED') && !detail.startsWith('FAIL');
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}${v.length ? ' | CSP: ' + v.join(' ; ') : ''}${errs.length ? ' | JS: ' + errs.join(' ; ') : ''}`);
    await p.close();
  };
  const form = async p => { await p.locator('#enqForm').scrollIntoViewIfNeeded(); await p.focus('#f-name'); await p.waitForTimeout(300);
    await p.fill('#f-name', 'Test Visitor'); await p.fill('#f-phone', '012-555 1234'); await p.selectOption('#f-help', 'Not sure yet');
    await p.click('#f-submit'); await p.waitForTimeout(800); return (await p.locator('#okModal').isVisible()) ? 'form sent, thank-you shown' : 'FAIL form'; };
  const chat = async p => { await p.click('.chat-fab'); await p.waitForTimeout(600); await p.fill('#chatInput', 'Do you build websites for clinics?'); await p.press('#chatInput', 'Enter');
    try { await p.waitForFunction(() => /RM1,600/.test(document.querySelector('#chatLog').innerText), null, { timeout: 8000 }); return 'chat AI reply shown'; } catch { return 'FAIL chat'; } };
  for (const [n, u] of [['home EN', '/'], ['home BM', '/bm/'], ['home ZH', '/zh/']]) {
    await check(n + ' load', u, async () => '');
    await check(n + ' form + Turnstile', u, form);
    await check(n + ' chatbot', u, chat);
  }
  await check('home EN mobile form', '/', form, { width: 390, height: 844 });
  await check('home EN mobile chatbot', '/', chat, { width: 390, height: 844 });
  await check('privacy', '/privacy/', async () => '');
  await check('demo plumbing (+booking buttons)', '/demos/jb-plumbing/', async p => { const btn = p.locator('#bSendDemo'); if (await btn.count()) { await btn.evaluate(b => b.click()); return 'booking button: ' + (await btn.innerText()); } return ''; });
  await check('demo tuition', '/demos/skudai-tuition/', async () => '');
  console.log(`\nCSP ${ENFORCE ? 'ENFORCED' : 'report-only'} test: ${fails ? fails + ' failed' : 'all passed'}`);
  await b.close(); srv.close(); process.exitCode = fails ? 1 : 0;
})();
