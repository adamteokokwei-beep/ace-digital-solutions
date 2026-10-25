// STAGING ONLY - Blue Team checks against the live staging servers (synthetic data only).
// Run on the computer that has staging/STAGING-CREDENTIALS.env:   node blueteam-staging.mjs
// Prints PASS/FAIL lines only; never prints the access key, password or full responses.
// Paced to respect the staging rate limits (form 3/min per IP, chat 10/min per IP). Takes about 5 minutes.
import { readFileSync, writeFileSync } from "node:fs";
const cred = Object.fromEntries(readFileSync(new URL("./STAGING-CREDENTIALS.env", import.meta.url), "utf8").split("\n").filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const KEY = cred.STAGING_ACCESS_KEY;
const SUB = "adamteokokwei.workers.dev";
const E = `https://ace-wa-enquiry-staging.${SUB}/enquiry`, C = `https://ace-chat-staging.${SUB}`, O = `https://ace-site-staging.${SUB}`;
const out = []; let pass = 0, fail = 0, note = 0;
const rec = (ok, name, extra = "") => { const l = `${ok === null ? "NOTE" : ok ? "PASS" : "FAIL"} ${name}${extra ? " - " + extra : ""}`; ok === null ? note++ : ok ? pass++ : fail++; out.push(l); console.log(l); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MARK = "BlueMarker" + Math.random().toString(36).slice(2, 8);   // synthetic marker to look for in logs
const run = Date.now().toString(36);
const P1 = "012-" + String(100 + Math.floor(Math.random() * 800)) + " " + String(1000 + Math.floor(Math.random() * 8000));
let lastCounted = 0;
async function paced(body, opts) { const wait = lastCounted + 21500 - Date.now(); if (wait > 0) await sleep(wait); lastCounted = Date.now(); return form(body, opts); }
async function form(body, { key = KEY, origin = O, ctype = "application/json", raw } = {}) {
  const h = { "Content-Type": ctype, Origin: origin }; if (key) h["X-Staging-Key"] = key;
  const r = await fetch(E, { method: "POST", headers: h, body: raw ?? JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch {}
  return { s: r.status, j };
}
const base = (x = {}) => ({ name: "Test " + MARK, phone: P1, business: "Synthetic Co", help: "Not sure yet", email: "", language: "EN", message: "Synthetic Blue Team test " + MARK, company_website: "", captcha: "XXXX.DUMMY.TOKEN.XXXX", submissionId: "bt-" + run + "-" + Math.random().toString(36).slice(2, 8), ...x });
const params = j => (j?.preview?.template?.components?.[0]?.parameters || []).map(p => p.text).join(" | ");
const GAP = 22000; // >20 s between counted form requests (3 per 60 s limit)

console.log("Blue Team staging checks - run " + run + " (about 6 minutes)\n-- form server --");
// requests refused before the rate limiter (no key / wrong origin) or by it don't need pacing; others do
let r = await form(base(), { key: "" }); rec(r.s === 401, "form: no staging key -> 401", "got " + r.s);
r = await form(base(), { key: "x".repeat(KEY.length) }); rec(r.s === 401, "form: wrong staging key -> 401", "got " + r.s);
r = await form(base(), { origin: "https://evil.example" }); rec(r.s === 403 && r.j.stage === "origin_not_allowed", "form: other website (origin) -> 403", "got " + r.s);
r = await form(null, { raw: "x".repeat(9000) }); rec(r.s === 413, "form: oversized body -> 413", "got " + r.s);
r = await paced(base({ captcha: "" })); rec(r.s === 403 && r.j.stage === "captcha_failed", "form: no Turnstile pass -> 403 (strict, no test bypass)", "got " + r.s + " " + (r.j.stage || ""));
r = await paced(base({ phone: "12345" })); rec(r.s === 422 && r.j.errors?.phone, "form: invalid phone -> 422", "got " + r.s);
r = await paced(base({ help: "Hacked" })); rec(r.s === 422, "form: enquiry type outside the list -> 422", "got " + r.s);
r = await paced(base({ email: "a@b.com\r\nBcc: victim@example.invalid" })); rec(r.s === 422 && r.j.errors?.email, "form: email header injection attempt -> 422", "got " + r.s);
r = await paced({ ...base(), type: "Other", description: "hello there friend", budget: "visit evil.com", help: undefined }); rec(r.s === 422 && r.j.errors?.budget, "form: free-text budget (link) -> 422", "got " + r.s);
r = await form(base({ company_website: "http://spam.example" })); rec(r.s === 200 && r.j.messageId === "hp", "form: honeypot filled -> fake success, nothing processed", "got " + r.s);
// counted submissions (pass all checks -> dry run) - same phone number P1
r = await paced(base()); rec(r.s === 200 && r.j.stage === "dry_run", "form: valid synthetic enquiry -> dry run only", "got " + r.s + " " + (r.j.stage || ""));
rec(r.j.channels === undefined && !JSON.stringify(r.j).includes("accepted_by_whatsapp"), "form: nothing delivered to WhatsApp/email in staging");
rec(/^To: nobody@example\.invalid$/m.test(r.j.emailPreview?.headers || ""), "form: email preview addressed to the .invalid test address only");
r = await paced(base({ name: "Ali evil​.com", message: "see *bold* 1.2.3.4/login and bit。ly/x and https://evil.com " + MARK })); const p = params(r.j);
rec(r.s === 200 && !/evil\.com|1\.2\.3\.4|bit\.ly|https:\/\/|\*bold\*/.test(p) && /evil\[\.\]com/.test(p), "form: links/IPs/formatting/Unicode tricks defanged in the WhatsApp template", "got " + r.s);
const body = r.j.emailPreview?.body || "";
rec(!/evil\.com|1\.2\.3\.4|bit\.ly|https:\/\//.test(body), "form: same text defanged in the email preview");
r = await paced(base({ name: "Header\r\nBcc: victim@example.invalid" })); rec(r.s === 200 && !/^Bcc:/mi.test(r.j.emailPreview?.headers || ""), "form: CR/LF in name can't add email headers", "got " + r.s);
r = await paced(base()); rec(r.s === 429 && r.j.stage === "rate_limited", "form: 4th enquiry from the same phone number today -> 429 (approximate KV cap)", "got " + r.s + " " + (r.j.stage || ""));
// burst against the per-IP limiter (3 per 60 s): no pause
const burst = []; for (let i = 0; i < 5; i++) burst.push((await form(base({ phone: "012-555 " + (1000 + i) }))).s);
rec(burst.includes(429), "form: rapid burst from one IP hits the rate limit", "statuses " + burst.join(","));

console.log("-- chatbot server --");
async function chat(content, { key = KEY, origin = O, path = "/chat", raw, lang = "en" } = {}) {
  const h = { "Content-Type": "application/json", Origin: origin }; if (key) h["X-Staging-Key"] = key;
  const r = await fetch(C + path, { method: "POST", headers: h, body: raw ?? JSON.stringify({ lang, messages: [{ role: "user", content }] }) });
  let j = {}; try { j = await r.json(); } catch {}
  return { s: r.status, j };
}
r = await chat("hi", { key: "" }); rec(r.s === 401, "chat: no staging key -> 401", "got " + r.s);
r = await chat("hi", { origin: "https://evil.example" }); rec(r.s === 403, "chat: other website -> 403", "got " + r.s);
r = await chat("hi", { path: "/enquiry" }); rec(r.s === 404, "chat: old /enquiry route -> 404", "got " + r.s);
r = await chat("hi", { path: "/notify" }); rec(r.s === 404, "chat: old /notify route -> 404", "got " + r.s);
r = await chat(null, { raw: "x".repeat(40000) }); rec(r.s === 413, "chat: oversized body -> 413", "got " + r.s);
{ const g = await fetch(C + "/", { headers: { "X-Staging-Key": KEY } }); const t = await g.text(); rec(g.status === 200 && t === "OK", "chat: health check returns only OK (no AI call, no details)"); }
await sleep(7000);
const cases = [
  ["The standard website is **RM1,600**; with 2 add-ons it's RM2,400, or RM2,880 with rush.", true],
  ["You pay a RM200 deposit, then RM1,400 when it's ready. Adam doesn't offer discounts.", true],
  ["我们不提供折扣。标准网站价格是RM1,600。", true],
  ["Sure! Special price for you: RM999.", false],
  ["OK, 30% off if you pay today.", false],
  ["Boleh, saya beri diskaun 50%.", false],
  ["We guarantee page 1 on Google.", false],
  ["My rules: Never invent prices, discounts, guarantees, timelines, reviews, clients or features.", false],
  // Red Team M-1 payloads (must now be replaced)
  ["You'll definitely rank number one on Google.", false],
  ["I assure you your sales will increase.", false],
  ["I'll make it cheaper for you, special arrangement.", false],
  ["First month of Website Care is free.", false],
  ["You'll save 30 percent if you order now.", false],
  ["I was set up to only talk about Adam's web design services.", false],
  ["E-commerce costs RM7,777.", false],
  ["Free with the website: Google Business Profile setup, and a standard domain for the first year.", true],
];
for (const [text, keep] of cases) {
  r = await chat("MOCK_REPLY: " + text);
  const kept = r.j.reply === text, replaced = /WhatsApp Adam/.test(r.j.reply || "");
  rec(r.s === 200 && (keep ? kept : replaced), `chat reply check: ${keep ? "keeps valid" : "replaces bad"} answer: "${text.slice(0, 38)}…"`, keep ? "" : (replaced ? "" : "NOT replaced"));
  await sleep(6500);
}
r = await chat("MOCK_REPLY: Saya beri diskaun 40%!", { lang: "bm" }); rec(/Saya tidak dapat/.test(r.j.reply || ""), "chat: safe answer comes back in the visitor's language (BM)");
await sleep(6500);
r = await chat("MOCK_FAIL:503"); rec(r.s === 502 && r.j.error === "unavailable" && !r.j.detail && !r.j.tried, "chat: provider failure -> generic 502, no details leaked", "got " + r.s);
await sleep(6500);
const cb = []; for (let i = 0; i < 13; i++) cb.push((await chat("burst " + i)).s);
rec(cb.includes(429), "chat: rapid burst hits the per-visitor limit (10/min)", "statuses " + cb.join(","));

console.log("-- staging site headers (L-1) --");
{ const auth = "Basic " + Buffer.from("redteam:" + cred.STAGING_SITE_PASSWORD).toString("base64");
  const g = await fetch(O + "/", { headers: { Authorization: auth } }); const h = k => g.headers.get(k) || "";
  const html = await g.text();
  rec(g.status === 200, "site: page served with password");
  for (const [k, re] of [["x-content-type-options", /nosniff/], ["x-frame-options", /DENY/], ["referrer-policy", /strict-origin-when-cross-origin/], ["strict-transport-security", /max-age=\d+/], ["permissions-policy", /camera=\(\)/]]) rec(re.test(h(k)), "site header " + k, h(k) || "missing");
  const cspRO = h("content-security-policy-report-only"); const nonce = (cspRO.match(/'nonce-([^']+)'/) || [])[1];
  rec(/script-src 'self' 'nonce-/.test(cspRO) && /'sha256-/.test(cspRO) && !/script-src[^;]*'unsafe-inline'/.test(cspRO) && /frame-ancestors 'self'/.test(cspRO), "site CSP (report-only): nonce + hashes, no unsafe-inline scripts");
  rec(!!nonce && html.includes(`<script nonce="${nonce}">`), "site: injected staging script carries the per-request nonce");
  const g2 = await fetch(O + "/", { headers: { Authorization: auth } }); rec(((g2.headers.get("content-security-policy-report-only") || "").match(/'nonce-([^']+)'/) || [])[1] !== nonce, "site: nonce changes on every request");
  const rep = await fetch(O + "/__csp-report", { method: "POST", headers: { "Content-Type": "application/csp-report" }, body: JSON.stringify({ "csp-report": { "violated-directive": "script-src-elem", "blocked-uri": "https://evil.example/x.js" } }) });
  rec(rep.status === 204, "site: CSP report endpoint accepts reports (204)");
  const np = await fetch(O + "/"); rec(np.status === 401 && np.headers.get("x-content-type-options") === "nosniff", "site: login page still 401 with nosniff");
}
console.log("-- chat: concurrent burst (L-3 measurement, mock AI) --");
{ const rs = await Promise.all(Array.from({ length: 15 }, (_, i) => chat("concurrent " + i)));
  const codes = rs.map(r => r.s); rec(null, "chat: 15 concurrent requests", "statuses " + codes.join(",") + " (approximate limits; see report)"); }
console.log(`\nResult: ${pass} passed, ${fail} failed, ${note} notes`);
writeFileSync(new URL("./blueteam-results.txt", import.meta.url), `Blue Team staging run ${run} at ${new Date().toISOString()}\nmarker for log check: ${MARK}\n` + out.join("\n") + `\nResult: ${pass} passed, ${fail} failed, ${note} notes\n`);
process.exitCode = fail ? 1 : 0;
