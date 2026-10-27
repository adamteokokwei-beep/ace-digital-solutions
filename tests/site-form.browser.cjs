// Browser test for the website enquiry form (all network calls mocked). Run: NODE_PATH=$(npm root -g) node tests/site-form.browser.cjs
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = require('path').join(__dirname, '..', 'site');
const srv = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; const f = path.join(ROOT, p);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, {'Content-Type': {'.html':'text/html','.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp'}[path.extname(f)]||'application/octet-stream'}); fs.createReadStream(f).pipe(res); }).listen(8897);
(async () => {
  const b = await chromium.launch(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}); let fails = 0;
  const S = [
    ['WhatsApp + email ok', 200, {ok:true,stage:'accepted_by_whatsapp',channels:{whatsapp:'sent',email:'sent'}}, 'modal'],
    ['staging dry run', 200, {ok:true,stage:'dry_run'}, 'modal'],
    ['unrecognised success stage', 200, {ok:true,stage:'unexpected'}, 'fallback'],
    ['email only ok', 200, {ok:true,stage:'delivered_by_email',channels:{whatsapp:'failed',email:'sent'}}, 'modal'],
    ['both fail', 502, {ok:false,stage:'whatsapp_rejected'}, 'fallback'],
    ['rate limited', 429, {ok:false,stage:'rate_limited'}, 'fallback'],
    ['service unavailable (fail-closed)', 503, {ok:false,stage:'service_unavailable'}, 'fallback'],
    ['server unreachable', 0, null, 'fallback'],
    ['captcha fails', 403, {ok:false,stage:'captcha_failed'}, 'captcha'],
  ];
  for (const [name, st, body, expect] of S) {
    const p = await b.newPage({ viewport:{width:1200,height:900} }); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
    const other = [];
    await p.route(/^https?:\/\/(?!localhost)/, r => { other.push(r.request().url()); r.abort(); });
    await p.route('**/challenges.cloudflare.com/**', r => r.fulfill({contentType:'text/javascript', body:'window.turnstile={render:()=>1,getResponse:()=>"TOKEN",reset:()=>{}};setTimeout(()=>window.onAceCaptcha&&window.onAceCaptcha(),10);'}));
    let sentTo = 0;
    await p.route('**/ace-wa-enquiry.adamteokokwei.workers.dev/**', r => { sentTo++; st ? r.fulfill({status:st, contentType:'application/json', body:JSON.stringify(body)}) : r.abort(); });
    await p.goto('http://localhost:8897/', {waitUntil:'domcontentloaded'}); await p.locator('#enqForm').scrollIntoViewIfNeeded(); await p.focus('#f-name'); await p.waitForTimeout(300);
    await p.fill('#f-name','Ah Kow Tan'); await p.fill('#f-phone','012-345 6789'); await p.fill('#f-email','kow@mail.com'); await p.selectOption('#f-help','Not sure yet');
    await p.click('#f-submit'); await p.waitForTimeout(900);
    const got = (await p.locator('#okModal').isVisible()) ? 'modal' : (await p.locator('#capErr').isVisible()) ? 'captcha' : (await p.locator('#f-status').isVisible()) ? 'fallback' : 'nothing';
    const formsubmit = other.some(u => /formsubmit/i.test(u));
    const truthful = name !== 'staging dry run' || /Nothing was sent/.test(await p.locator('.ok-lede').innerText());
    const pass = truthful && got === expect && sentTo === 1 && !formsubmit && errs.length === 0; if (!pass) fails++;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: shows=${got} serverCalls=${sentTo} formsubmitCalls=${formsubmit?1:0} jsErrors=${errs.length}`);
    if (name === 'both fail') await p.locator('#enqForm').screenshot({path:require('os').tmpdir()+'/site_fail2.png'});
    await p.close();
  }
  await b.close(); srv.close(); process.exitCode = fails ? 1 : 0;
})();
