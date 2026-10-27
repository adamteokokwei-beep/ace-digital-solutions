// Run: node --test test/worker.test.mjs        (no packages needed)
// All WhatsApp API calls are mocked. Nothing is ever sent.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { _resetState, _setEmailMessage, normalisePhone, buildMetaPayload, buildEmail, defang, safeText, sanitize, counterId, validate, handleEnquiry, EnquiryUsage, readBody } from "../worker.js";

const ENV = {
  WHATSAPP_ACCESS_TOKEN: "test-token", WHATSAPP_PHONE_NUMBER_ID: "123456789", WHATSAPP_RECIPIENT_NUMBER: "60100000000",
  WHATSAPP_API_VERSION: "v23.0", ALLOWED_ORIGIN: "https://example.com", META_TIMEOUT_MS: "300", TURNSTILE_SECRET: "unit-secret", LIMIT_HMAC_KEY: "u".repeat(32),
};
const VALID = { name: "Mei Ling", phone: "012-345 6789", type: "New website", description: "I run a bakery in Skudai and need a simple website.", location: "Skudai", budget: "RM1,500 – RM2,500", timeline: "Within 1 month", company_website: "" };


// production-like settings: anti-spam key, limiter, counter store and HMAC key all present
// Transaction fake: concurrent callers queue; rollback on failure. Runtime integration is tested separately.
function usageNamespace({ delay = 0, fail = false } = {}) {
  const m = new Map(); let queue = Promise.resolve();
  const storage = {
    setAlarm: async () => {}, deleteAll: async () => m.clear(),
    transaction(fn) {
      const next = queue.then(async () => {
        const draft = new Map(m);
        const result = await fn({ get: async keys => { await new Promise(r => setTimeout(r, delay)); return new Map(keys.filter(k => draft.has(k)).map(k => [k, draft.get(k)])); },
          put: async obj => { if (fail) throw new Error("storage failed"); for (const [k,v] of Object.entries(obj)) draft.set(k,v); } });
        m.clear(); for (const [k,v] of draft) m.set(k,v); return result;
      });
      queue = next.catch(() => {}); return next;
    },
  };
  const object = new EnquiryUsage({ storage });
  return { m, storage, object, idFromName: name => name, get: () => ({ fetch: (url, opts) => object.fetch(new Request(url, opts)) }) };
}
const PROD = () => { const e = { ...ENV, TURNSTILE_SECRET: "s", LIMIT_HMAC_KEY: "k".repeat(32), RATE_LIMITER: { limit: async () => ({ success: true }) }, ENQ_USAGE: usageNamespace() }; delete e.CAPTCHA_OPTIONAL; return e; };
let calls, metaReply, verifyReply, verificationCalls, logs;
const realFetch = globalThis.fetch, realLog = console.log;
beforeEach(() => {
  _resetState(); calls = []; verificationCalls = []; logs = [];
  verifyReply = async () => Response.json({ success: true, hostname: "example.com" });
  const rates = new Map();
  ENV.RATE_LIMITER = { limit: async ({key}) => { const n=(rates.get(key)||0)+1; rates.set(key,n); return {success:n<=3}; } };
  ENV.ENQ_USAGE = usageNamespace();
  console.log = (...a) => logs.push(a.join(" "));
  metaReply = async () => new Response(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ input: "60100000000", wa_id: "60100000000" }], messages: [{ id: "wamid.ABC", message_status: "accepted" }] }), { status: 200 });
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("siteverify")) { verificationCalls.push({url:String(url),opts}); return verifyReply(url,opts); }
    calls.push({ url: String(url), opts }); return metaReply(url, opts);
  };
});
process.on("exit", () => { globalThis.fetch = realFetch; console.log = realLog; });

let ipN = 0;
function post(body, { env = ENV, ip, headers = {} } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body && !Array.isArray(body) ? { captcha:"tok", submissionId:crypto.randomUUID(), ...body } : body);
  return worker.fetch(new Request("https://worker.test/enquiry", { method: "POST", body: raw,
    headers: { "Content-Type": "application/json", "Origin": "https://example.com", "CF-Connecting-IP": ip || "10.0.0." + (++ipN), ...headers } }), env);
}
const noContentInLogs = () => { const all = logs.join("\n"); for (const v of [VALID.name, "345 6789", VALID.description, "Skudai"]) assert.ok(!all.includes(v), "log contains enquiry content: " + v); };

test("1. valid submission is sent and accepted by the WhatsApp API", async () => {
  const r = await post({ ...VALID, submissionId: "s1" }); const b = await r.json();
  assert.equal(r.status, 200); assert.equal(b.ok, true); assert.equal(b.stage, "accepted_by_whatsapp"); assert.equal(b.messageId, "wamid.ABC");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://graph.facebook.com/v23.0/123456789/messages");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer test-token");
  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.to, "60100000000"); assert.equal(sent.type, "text");
  assert.match(sent.text.body, /^NEW WEBSITE ENQUIRY\n\nName: Mei Ling\nWhatsApp: \+60123456789\nEnquiry type: New website/);
  assert.match(sent.text.body, /Source: Website enquiry form$/);
  assert.ok(!JSON.stringify(b).includes("Mei Ling"), "response must not echo enquiry content");
  noContentInLogs();
});

test("1b. template mode sends the 7 fields as template parameters without new lines", async () => {
  const p = buildMetaPayload({ ...ENV, WHATSAPP_TEMPLATE_NAME: "website_enquiry" }, { ...VALID, phoneDigits: "60123456789", description: "line one\nline two\t    gap" });
  assert.equal(p.type, "template"); assert.equal(p.template.name, "website_enquiry");
  const params = p.template.components[0].parameters.map(x => x.text);
  assert.equal(params.length, 7); assert.ok(params.every(t => !/[\n\t]/.test(t) && !/ {4,}/.test(t)));
});

test("2. missing required fields are rejected and nothing is sent", async () => {
  const r = await post({ name: "", phone: "", type: "", description: "" }); const b = await r.json();
  assert.equal(r.status, 422); assert.equal(b.stage, "invalid");
  assert.deepEqual(Object.keys(b.errors).sort(), ["description", "name", "phone", "type"]);
  assert.equal(calls.length, 0);
});

test("3. invalid phone numbers are rejected", async () => {
  for (const bad of ["12345", "abc", "0123", "+60 1", "999999999999999999"]) {
    const r = await post({ ...VALID, phone: bad }); const b = await r.json();
    assert.equal(r.status, 422, bad); assert.equal(b.errors.phone, "invalid", bad);
  }
  assert.equal(normalisePhone("012-345 6789"), "60123456789");
  assert.equal(normalisePhone("+65 9123 4567"), "6591234567");
  assert.equal(normalisePhone("07-123 4567"), "6071234567");
  assert.equal(calls.length, 0);
});

test("4. excessively long content is rejected (field limits and request size limit)", async () => {
  let r = await post({ ...VALID, description: "x".repeat(1600) });
  assert.equal(r.status, 422); assert.equal((await r.json()).errors.description, "too_long");
  r = await post({ ...VALID, name: "n".repeat(200) });
  assert.equal((await r.json()).errors.name, "too_long");
  r = await post({ ...VALID, junk: "y".repeat(20000) });
  assert.equal(r.status, 413); assert.equal((await r.json()).stage, "too_large");
  assert.equal(calls.length, 0);
});

test("5. honeypot: bots get a normal-looking answer but nothing is sent", async () => {
  const r = await post({ ...VALID, company_website: "http://spam.example" }); const b = await r.json();
  assert.equal(r.status, 200); assert.equal(b.ok, true); assert.equal(calls.length, 0);
});

test("6. rate limiting: the 4th submission from one IP within 10 minutes is refused", async () => {
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await post({ ...VALID, submissionId: "rl" + i }, { ip: "1.2.3.4" })).status);
  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
  assert.equal(statuses[3], 429); assert.equal(statuses[4], 429);
  assert.equal(calls.length, 3);
});

test("6b. Cloudflare rate limiter binding is used when present", async () => {
  const env = { ...ENV, RATE_LIMITER: { limit: async () => ({ success: false }) } };
  const r = await post(VALID, { env }); assert.equal(r.status, 429); assert.equal(calls.length, 0);
});

test("7. WhatsApp API authentication failure is reported as a failure", async () => {
  metaReply = async () => new Response(JSON.stringify({ error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } }), { status: 401 });
  const r = await post({ ...VALID, submissionId: "a1" }); const b = await r.json();
  assert.equal(b.ok, false); assert.equal(b.stage, "whatsapp_auth_failed"); assert.equal(r.status, 502);
  noContentInLogs();
});

test("8. WhatsApp API rejection (e.g. recipient not allowed, template missing) is reported as a failure", async () => {
  for (const code of [131030, 132001, 131047, 100]) {
    metaReply = async () => new Response(JSON.stringify({ error: { message: "rejected", code } }), { status: 400 });
    const r = await post({ ...VALID, submissionId: "rej" + code },{env:{...ENV,ENQ_USAGE:usageNamespace()}}); const b = await r.json();
    assert.equal(b.ok, false); assert.equal(b.stage, "whatsapp_rejected"); assert.equal(b.code, code);
  }
  metaReply = async () => new Response(JSON.stringify({ error: { message: "Too many", code: 130429 } }), { status: 429 });
  const b = await (await post(VALID)).json(); assert.equal(b.stage, "whatsapp_busy");
  noContentInLogs();
});

test("9. network timeout and API outage are reported as failures", async () => {
  metaReply = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  let r = await post(VALID,{env:{...ENV,ENQ_USAGE:usageNamespace()}}); let b = await r.json();
  assert.equal(r.status, 504); assert.equal(b.ok, false); assert.equal(b.stage, "whatsapp_unavailable"); assert.equal(b.reason, "timeout");
  metaReply = async () => { throw new TypeError("fetch failed"); };
  b = await (await post(VALID,{env:{...ENV,ENQ_USAGE:usageNamespace()}})).json(); assert.equal(b.stage, "whatsapp_unavailable"); assert.equal(b.reason, "network");
  metaReply = async () => new Response("<html>oops</html>", { status: 503 });
  b = await (await post(VALID,{env:{...ENV,ENQ_USAGE:usageNamespace()}})).json(); assert.equal(b.ok, false); assert.equal(b.stage, "whatsapp_unavailable");
  metaReply = async () => new Response("{}", { status: 200 });            // 200 without a message id is NOT success
  b = await (await post(VALID,{env:{...ENV,ENQ_USAGE:usageNamespace()}})).json(); assert.equal(b.ok, false);
  noContentInLogs();
});

test("10. repeated submission is not sent twice; uncertain failures do not auto-resend", async () => {
  const one = await (await post({ ...VALID, submissionId: "dup-1" })).json();
  const two = await (await post({ ...VALID, submissionId: "dup-1" })).json();
  assert.equal(one.ok, true); assert.equal(two.ok, true); assert.equal(two.duplicate, true);
  assert.equal(calls.length, 1, "WhatsApp must be called only once");
  // a failed attempt can be retried with the same id
  metaReply = async () => new Response(JSON.stringify({ error: { code: 131000 } }), { status: 500 });
  const f = await (await post({ ...VALID, submissionId: "dup-2" })).json(); assert.equal(f.ok, false);
  metaReply = async () => new Response(JSON.stringify({ messages: [{ id: "wamid.RETRY" }] }), { status: 200 });
  const ok = await (await post({ ...VALID, submissionId: "dup-2" })).json(); assert.equal(ok.ok, false); assert.equal(ok.stage, "delivery_uncertain");
  assert.equal(calls.length,2,"one accepted attempt and one ambiguous attempt only");
});

test("dry run validates and previews but never calls WhatsApp", async () => {
  const r = await post(VALID, { env: { ...ENV, WHATSAPP_DRY_RUN: "true" } }); const b = await r.json();
  assert.equal(b.ok, true); assert.equal(b.stage, "dry_run"); assert.match(b.preview.text.body, /NEW WEBSITE ENQUIRY/);
  assert.equal(calls.length, 0);
});

test("missing configuration reports not_configured, never success", async () => {
  const r = await post(VALID, { env: { ...PROD(), WHATSAPP_ACCESS_TOKEN:"", WHATSAPP_PHONE_NUMBER_ID:"", WHATSAPP_RECIPIENT_NUMBER:"" } }); const b = await r.json();
  assert.equal(r.status, 503); assert.equal(b.ok, false); assert.equal(b.stage, "not_configured");
});

test("other websites (origins) are refused; secrets never reach the browser", async () => {
  const r = await post(VALID, { headers: { Origin: "https://evil.example" } });
  assert.equal(r.status, 403); assert.equal(calls.length, 0);
  const ok = await post({ ...VALID, submissionId: "sec" }); const text = await ok.text();
  assert.ok(!text.includes("test-token") && !text.includes("123456789"));
});

test("11. without an anti-spam key the server always refuses", async () => {
  const env = PROD(); delete env.TURNSTILE_SECRET;
  const r = await handleEnquiry(new Request("https://w.example/enquiry", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.com", "CF-Connecting-IP": "9.9.9.1" }, body: JSON.stringify({ ...VALID, submissionId: "nocap" }) }), env);
  assert.equal(r.status, 403); assert.equal((await r.json()).stage, "captcha_failed"); assert.equal(calls.length, 0);
});

test("12. links typed by a customer are made unclickable in the WhatsApp message", async () => {
  assert.equal(defang("see evil.com or https://bit.ly/x"), "see evil[.]com or https[:]//bit[.]ly/x");
  assert.equal(defang("RM1.50, e.g. Skudai"), "RM1.50, e.g. Skudai");
  const p = buildMetaPayload({ ...ENV, WHATSAPP_TEMPLATE_NAME: "website_enquiry" }, { name: "x", phoneDigits: "60123456789", type: "Other", location: "", budget: "", timeline: "", description: "go to evil.com" });
  assert.equal(p.template.components[0].parameters[6].text, "> go to evil[.]com");
  assert.equal(p.template.components[0].parameters[1].text, "+60123456789");
});

test("13. with the atomic store: same customer number max 3 a day, and a total daily cap", async () => {
  const usage = usageNamespace(); const store = usage.m;
  const env = { ...ENV, ENQ_USAGE: usage, DAILY_CAP: "5", RATE_LIMITER: { limit: async () => ({ success: true }) } };
  const send = (i, phone, ip) => handleEnquiry(new Request("https://w.example/enquiry", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.com", "CF-Connecting-IP": ip }, body: JSON.stringify({ ...VALID, captcha:"tok", phone, submissionId: "kv" + i }) }), env);
  const a = []; for (let i = 0; i < 4; i++) a.push((await send(i, "012-345 6789", "5.5.5." + i)).status);
  assert.deepEqual(a, [200, 200, 200, 429]);
  assert.equal((await send(10, "012-000 0001", "6.6.6.1")).status, 200);
  assert.equal((await send(11, "012-000 0002", "6.6.6.2")).status, 200);
  const r = await send(12, "012-000 0003", "6.6.6.3"); assert.equal(r.status, 429); assert.equal((await r.json()).stage, "daily_cap");
  assert.ok(![...store.keys()].some(k => /0123456789|5\.5\.5/.test(k)), "no raw phone or IP in store keys");
});

test("14. missing passes are refused even with inherited CAPTCHA_OPTIONAL=true", async () => {
  const mk = env => handleEnquiry(new Request("https://w.example/enquiry", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.com", "CF-Connecting-IP": "7.7.7.7" }, body: JSON.stringify({ ...VALID, submissionId: "ts" + Math.random() }) }), env);
  const strict = PROD();
  assert.equal((await mk(strict)).status, 403);
  assert.equal((await mk({ ...ENV, TURNSTILE_SECRET: "s", CAPTCHA_OPTIONAL: "true" })).status, 403);
});

test("15. the main website's form fields are accepted (message optional) and mapped", async () => {
  const site = { name: "Ah Kow", phone: "012-345 6789", business: "Kow Aircond", help: "Not sure yet", email: "kow@mail.com", language: "BM", message: "", company_website: "", submissionId: "site1" };
  const r = await post(site); assert.equal(r.status, 200);
  const body = JSON.stringify(JSON.parse(calls[0].opts.body));
  assert.match(body, /Not sure yet/); assert.match(body, /Kow Aircond/); assert.match(body, /kow@mail\[\.\]com/); assert.match(body, /Form language: BM/);
  const bad = await post({ ...site, email: "not-an-email", submissionId: "site2" }); assert.equal(bad.status, 422);
  const badType = await post({ ...site, help: "Hack", submissionId: "site3" }); assert.equal(badType.status, 422);
});

// ===================== security fixes A–D (October 2026) =====================
const WA_OK = () => new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), { status: 200 });
const routeFetch = ({ turnstile = true, wa = WA_OK } = {}) => { verifyReply = async () => Response.json({success:turnstile,hostname:"example.com"}); metaReply = async () => wa(); };
class FakeEmailMessage { constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; } }
const mailbox = (fail = false) => { const sent = []; return { sent, send: async m => { if (fail) throw new Error("send failed for owner@example.com"); sent.push(m); } }; };
const EMAILENV = mb => ({ EMAIL: mb, EMAIL_FROM: "Ace Website <enquiry@acedigitalsolutionsbiz.org>", EMAIL_TO: "owner@example.com" });
const SITE = { name: "Ah Kow", phone: "012-345 6789", business: "Kow Aircond", help: "Not sure yet", email: "kow@mail.com", language: "BM", message: "Need a site", company_website: "" };
const decodeBody = raw => Buffer.from(raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8");
const send = (env, body, ip = "8.8.8." + (++ipN % 250)) => handleEnquiry(new Request("https://w/enquiry", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.com", "CF-Connecting-IP": ip }, body: JSON.stringify({ captcha: "tok", submissionId: "x" + Math.random(), ...body }) }), env);

test("A1. email: delivered by BOTH WhatsApp and email after all checks", async () => {
  _setEmailMessage(FakeEmailMessage); routeFetch(); const mb = mailbox();
  const r = await send({ ...PROD(), ...EMAILENV(mb) }, SITE); const b = await r.json();
  assert.equal(r.status, 200); assert.equal(b.stage, "accepted_by_whatsapp"); assert.deepEqual(b.channels, { whatsapp: "sent", email: "sent" });
  assert.equal(mb.sent.length, 1); assert.equal(mb.sent[0].to, "owner@example.com"); assert.equal(mb.sent[0].from, "enquiry@acedigitalsolutionsbiz.org");
  const body = decodeBody(mb.sent[0].raw);
  assert.match(body, /Name: Ah Kow/); assert.match(body, /Business: Kow Aircond/); assert.match(body, /Email: kow@mail\[\.\]com/); assert.match(body, /Message:\r?\n> Need a site/);
  assert.match(mb.sent[0].raw, /^Reply-To: kow@mail\.com$/m); assert.match(mb.sent[0].raw, /^Subject: =\?UTF-8\?B\?/m); assert.match(mb.sent[0].raw, /^Message-ID: <[0-9a-f-]+@acedigitalsolutionsbiz\.org>$/m);
});

test("A2. email: WhatsApp fails but email works -> success (delivered_by_email); both fail -> failure", async () => {
  _setEmailMessage(FakeEmailMessage);
  routeFetch({ wa: () => new Response(JSON.stringify({ error: { code: 131030 } }), { status: 400 }) });
  let r = await send({ ...PROD(), ...EMAILENV(mailbox()) }, SITE); let b = await r.json();
  assert.equal(r.status, 200); assert.equal(b.stage, "delivered_by_email"); assert.deepEqual(b.channels, { whatsapp: "failed", email: "sent" });
  r = await send({ ...PROD(), ...EMAILENV(mailbox(true)) }, SITE); b = await r.json();
  assert.equal(r.status, 502); assert.equal(b.ok, false); assert.deepEqual(b.channels, { whatsapp: "failed", email: "failed" });
  assert.ok(!logs.join("\n").includes("owner@example.com"), "email address not logged");
});

test("A3. email: no email is sent when Turnstile fails, the honeypot is filled, limits are hit, or in dry run", async () => {
  _setEmailMessage(FakeEmailMessage); const mb = mailbox();
  routeFetch({ turnstile: false }); assert.equal((await send({ ...PROD(), ...EMAILENV(mb) }, SITE)).status, 403);
  routeFetch(); assert.equal((await send({ ...PROD(), ...EMAILENV(mb) }, { ...SITE, company_website: "x" })).status, 200);
  const capped = { ...PROD(), ...EMAILENV(mb), DAILY_CAP: "0" }; assert.equal((await send(capped, SITE)).status, 429);
  assert.equal((await send({ ...PROD(), ...EMAILENV(mb), WHATSAPP_DRY_RUN: "true" }, SITE)).status, 200);
  assert.equal(mb.sent.length, 0);
});

test("A4. email: header injection through name/email is impossible", async () => {
  _setEmailMessage(FakeEmailMessage); routeFetch(); const mb = mailbox();
  const bad = await send({ ...PROD(), ...EMAILENV(mb) }, { ...SITE, email: "a@b.com\r\nBcc: victim@x.com" }); assert.equal(bad.status, 422);
  const r = await send({ ...PROD(), ...EMAILENV(mb) }, { ...SITE, name: "Ali\r\nBcc: victim@x.com", email: "" }); assert.equal(r.status, 200);
  const head = mb.sent[0].raw.split("\r\n\r\n")[0];
  assert.ok(!/^Bcc:/mi.test(head), "no injected header"); assert.ok(!/^Reply-To:/m.test(head), "no Reply-To without a valid email");
  assert.equal(head.split("\r\n").filter(l => /^To:/.test(l)).length, 1);
});

test("A5. email only (WhatsApp not configured) still delivers", async () => {
  _setEmailMessage(FakeEmailMessage); routeFetch(); const mb = mailbox();
  const env = { ...PROD(), ...EMAILENV(mb) }; delete env.WHATSAPP_ACCESS_TOKEN;
  const r = await send(env, SITE); const b = await r.json();
  assert.equal(r.status, 200); assert.equal(b.stage, "delivered_by_email"); assert.equal(b.channels.whatsapp, "off");
});

test("B1. sanitiser: invisible, bidi and odd-dot tricks are removed before defanging", () => {
  assert.equal(safeText(sanitize("evil​.com", 50)), "evil[.]com");
  assert.equal(safeText(sanitize("evil。com", 50)), "evil[.]com");
  assert.equal(safeText(sanitize("evil．com", 50)), "evil[.]com");
  assert.equal(safeText(sanitize("ｅｖｉｌ.com", 50)), "evil[.]com");      // full-width letters
  assert.equal(sanitize("abc‮moc.live", 50), "abcmoc.live");                         // bidi override removed
  assert.equal(safeText("go to 1.2.3.4/login"), "go to 1[.]2[.]3[.]4/login");
  assert.equal(safeText("http://x.yz"), "http[:]//x[.]yz");
  assert.equal(safeText("*bold* _it_ ~st~ `code`"), "∗bold∗ ˍitˍ ∼st∼ ʹcodeʹ");
  assert.equal(safeText("RM1.50, e.g. Skudai"), "RM1.50, e.g. Skudai");                  // normal text untouched
});

test("B2. every customer field reaching WhatsApp is safe; budget/timeline must be fixed choices", async () => {
  routeFetch();
  let r = await send(PROD(), { ...VALID, budget: "visit evil.com" }); assert.equal(r.status, 422); assert.equal((await r.json()).errors.budget, "invalid");
  r = await send(PROD(), { ...VALID, timeline: "https://evil.com" }); assert.equal(r.status, 422);
  calls = [];
  r = await send(PROD(), { ...VALID, name: "Ali evil​.com", location: "x．com", description: "see *1.2.3.4/x* and bit。ly/abc please" }); assert.equal(r.status, 200);
  const sentBody = JSON.parse(calls.find(c => c.url.includes("/messages")).opts.body);
  const text = JSON.stringify(sentBody);
  for (const bad of ["evil.com", "x.com", "1.2.3.4", "bit.ly", "*1"]) assert.ok(!text.includes(bad), "unsafe text reached WhatsApp: " + bad);
});

test("C1. fail closed: limiter, counter store or HMAC key missing/failing -> 503, nothing sent", async () => {
  routeFetch();
  const cases = {
    "limiter throws": e => { e.RATE_LIMITER = { limit: async () => { throw new Error("down"); } }; },
    "limiter missing": e => { delete e.RATE_LIMITER; },
    "store throws": e => { e.ENQ_USAGE = usageNamespace({ fail: true }); },
    "store missing": e => { delete e.ENQ_USAGE; },
    "hmac key missing": e => { delete e.LIMIT_HMAC_KEY; },
  };
  for (const [name, change] of Object.entries(cases)) {
    calls = []; const env = PROD(); change(env);
    const r = await send(env, VALID); const b = await r.json();
    assert.equal(r.status, 503, name); assert.equal(b.stage, "service_unavailable", name);
    assert.equal(calls.filter(c => c.url.includes("/messages")).length, 0, name + ": nothing sent");
  }
});

test("C2. inherited local flags never replace required bindings", async () => {
  routeFetch(); const env={...ENV,CAPTCHA_OPTIONAL:"true"}; delete env.ENQ_USAGE;
  const r=await send(env,VALID);assert.equal(r.status,503);assert.equal(calls.length,0);
});

test("D1. counter names use a secret-keyed HMAC (not reversible without the key)", async () => {
  const env1 = { LIMIT_HMAC_KEY: "a".repeat(32) }, env2 = { LIMIT_HMAC_KEY: "b".repeat(32) };
  const a = await counterId(env1, "60123456789"), b = await counterId(env2, "60123456789");
  assert.match(a, /^[0-9a-f]{32}$/); assert.notEqual(a, b);
  const plain = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("enq:60123456789"))).toString("hex").slice(0, 32);
  assert.notEqual(a, plain);
  routeFetch(); const env = PROD(); await send(env, VALID, "203.0.113.9");
  const keys = [...env.ENQ_USAGE.m.keys()].join(" ");
  assert.ok(!keys.includes("203.0.113.9") && !keys.includes("60123456789"), "no raw IP or phone in counter names");
  await assert.rejects(() => counterId({}, "x"), /no hmac key/);
});

// ===================== staging environment =====================
const STG = (x = {}) => ({ ALLOWED_ORIGIN: "https://example.com", STAGING: "true", STAGING_ACCESS_KEY: "s".repeat(32), WHATSAPP_DRY_RUN: "true", WHATSAPP_TEMPLATE_NAME: "website_enquiry",
  TURNSTILE_SECRET: "1x0000000000000000000000000000000AA", LIMIT_HMAC_KEY: "t".repeat(32), RATE_LIMITER: { limit: async () => ({ success: true }) }, ENQ_USAGE: usageNamespace(),
  EMAIL_FROM: "Staging <staging@example.invalid>", EMAIL_TO: "nobody@example.invalid", ...x });
const stgReq = (key, body = { ...VALID, captcha: "tok", submissionId: "st" + Math.random() }) => new Request("https://w/enquiry", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.com", "CF-Connecting-IP": "9.9.9." + (++ipN % 250), ...(key ? { "X-Staging-Key": key } : {}) }, body: JSON.stringify(body) });

test("S1. staging: requests without the right access key are refused", async () => {
  routeFetch();
  assert.equal((await worker.fetch(stgReq(""), STG())).status, 401);
  assert.equal((await worker.fetch(stgReq("x".repeat(32)), STG())).status, 401);
  assert.equal((await worker.fetch(stgReq("s".repeat(32)), STG({ STAGING_ACCESS_KEY: "" }))).status, 401, "no key configured -> refuse all");
  const r = await worker.fetch(stgReq("s".repeat(32)), STG()); const b = await r.json();
  assert.equal(r.status, 200); assert.equal(b.stage, "dry_run");
  assert.match(b.emailPreview.headers, /^To: nobody@example\.invalid$/m); assert.match(b.emailPreview.body, /Name: Mei Ling/);
  assert.equal(calls.filter(c => c.url.includes("/messages")).length, 0, "nothing sent to WhatsApp");
});

test("S2. staging refuses to run if any real delivery credential is present", async () => {
  routeFetch();
  for (const [name, x] of [["WhatsApp token", { WHATSAPP_ACCESS_TOKEN: "real" }], ["email binding", { EMAIL: mailbox() }], ["dry run off", { WHATSAPP_DRY_RUN: "false" }]]) {
    const r = await worker.fetch(stgReq("s".repeat(32)), STG(x)); assert.equal(r.status, 503, name); assert.equal((await r.json()).stage, "staging_not_isolated", name);
  }
});

test("S3. production ignores staging headers and never adds an email preview", async () => {
  routeFetch(); const r = await worker.fetch(stgReq("anything"), { ...PROD(), WHATSAPP_DRY_RUN: "true", EMAIL_FROM: "a <a@b.co>", EMAIL_TO: "c@d.co" }); const b = await r.json();
  assert.equal(r.status, 200); assert.equal(b.stage, "dry_run"); assert.equal(b.emailPreview, undefined);
});


test("F1. 20 concurrent enquiries with cap 5 permit exactly 5 deliveries", async () => {
  routeFetch(); const env = { ...PROD(), DAILY_CAP: "5", ENQ_USAGE: usageNamespace({ delay: 2 }) };
  const results = await Promise.all(Array.from({length:20}, (_,i) => send(env, { ...VALID, phone: "012-555 " + String(i).padStart(4,"0") }, "203.0.113." + i)));
  assert.equal(results.filter(r => r.status === 200).length, 5);
  assert.equal(results.filter(r => r.status === 429).length, 15);
  assert.equal(env.ENQ_USAGE.m.get("total"), 5);
  assert.equal(calls.filter(c => c.url.includes("/messages")).length, 5);
});

test("F2. concurrent equivalent phone formats share the three-per-day cap", async () => {
  routeFetch(); const env = PROD();
  const phones = ["012-555 0000", "+60125550000", "0060125550000", "０１２５５５００００"];
  const results = await Promise.all(phones.map((phone,i) => send(env, {...VALID, phone}, "203.0.113."+i)));
  assert.equal(results.filter(r => r.status === 200).length, 3);
  assert.equal(results.filter(r => r.status === 429).length, 1);
});

test("F3. malformed cap and storage corruption fail closed", async () => {
  routeFetch();
  for (const DAILY_CAP of ["NaN", "Infinity", "-1", "1.2"]) assert.equal((await send({...PROD(), DAILY_CAP},VALID)).status,503);
  const env = PROD(); env.ENQ_USAGE.m.set("total", "broken");
  assert.equal((await send(env,VALID)).status,503);
  assert.equal(calls.filter(c => c.url.includes("/messages")).length, 0);
});

test("F4. Turnstile type confusion, oversized tokens, wrong host and HTTP failure never deliver", async () => {
  for (const captcha of [{}, [], true, 123, "x".repeat(2049), " "]) {
    calls = []; routeFetch(); assert.equal((await send(PROD(), {...VALID,captcha})).status,403);
    assert.equal(calls.length,0);
  }
  for (const [status,body] of [[200,{success:true,hostname:"evil.example"}],[200,{success:"true",hostname:"example.com"}],[503,{success:true,hostname:"example.com"}]]) {
    calls=[]; verificationCalls=[]; verifyReply=async()=>new Response(JSON.stringify(body),{status});
    assert.equal((await send(PROD(),VALID)).status,403);
    assert.equal(calls.length,0);assert.equal(verificationCalls.length,1);
  }
});

test("F5. missing/wildcard origins and missing trusted client IP fail closed", async () => {
  routeFetch();
  for (const ALLOWED_ORIGIN of ["", "*", "null"]) assert.equal((await send({...PROD(),ALLOWED_ORIGIN},VALID)).status,403);
  assert.equal((await post(VALID,{env:PROD(),headers:{Origin:"null"}})).status,403);
  const req=new Request("https://w/enquiry",{method:"POST",headers:{Origin:"https://example.com","Content-Type":"application/json","X-Forwarded-For":"203.0.113.7"},body:JSON.stringify(VALID)});
  assert.equal((await worker.fetch(req,PROD())).status,503); assert.equal(calls.length,0);
});

test("F6. exact path and JSON media type only", async () => {
  routeFetch();
  assert.equal((await worker.fetch(new Request("https://w/other/enquiry",{method:"POST"}),PROD())).status,404);
  assert.equal((await post(VALID,{headers:{"Content-Type":"text/application/json"}})).status,415);
});

test("F7. provider exceptions and rejection diagnostics never log returned content", async () => {
  routeFetch({wa:()=>new Response(JSON.stringify({error:{code:131030,message:"PRIVATE-VISITOR",error_data:{details:"PRIVATE-DETAIL"}}}),{status:400})});
  await send(PROD(),VALID);
  assert.ok(!logs.join(" ").includes("PRIVATE-"));
  assert.ok(!calls.some(c=>c.url.includes("fields=display_phone_number")));
});

test("F8. counter persists across object restart and alarm erases counters", async () => {
  routeFetch(); const env=PROD(); await send(env,VALID);
  const restarted=new EnquiryUsage({storage:env.ENQ_USAGE.storage});
  env.ENQ_USAGE.get=()=>({fetch:(url,opts)=>restarted.fetch(new Request(url,opts))});
  await send(env,VALID); await send(env,VALID);
  assert.equal((await send(env,VALID)).status,429);
  await restarted.alarm(); assert.equal(env.ENQ_USAGE.m.size,0);
});


test("L2. forged email labels remain quoted visitor text; trusted headers use the validated email", async () => {
  _setEmailMessage(FakeEmailMessage); routeFetch(); const mb=mailbox();
  const message="hello\nEmail: attacker@example.invalid\nWhatsApp: +60125559999\nReply-To: forged@example.invalid";
  assert.equal((await send({...PROD(),...EMAILENV(mb)},{...SITE,message})).status,200);
  const body=decodeBody(mb.sent[0].raw);
  assert.match(body,/\n> Email: attacker@example\[\.\]invalid/);
  assert.ok(!/^Email: attacker/m.test(body));
  assert.match(mb.sent[0].raw,/^Reply-To: kow@mail\.com$/m);
});

test("F9. client-supplied internal fields and non-string inputs cannot bypass validation", async () => {
  routeFetch();
  assert.equal((await send(PROD(),{...VALID,description:"x",_site:true,_email:"attacker@example.invalid"})).status,422);
  for (const value of [{},[],true,5]) assert.equal((await send(PROD(),{...VALID,name:value})).status,422);
  const v=validate({...VALID,_email:"attacker@example.invalid",_business:"forged",_site:true}).value;
  assert.equal(v.email,"");assert.equal(v.site,false);assert.equal(v.business,"");
});


test("F10. chunked oversized body is cancelled at the byte limit", async () => {
  let cancelled=false;
  const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array(4096));},cancel(){cancelled=true;}});
  await assert.rejects(readBody(new Request("https://w/enquiry",{method:"POST",body,duplex:"half"})),RangeError);
  assert.equal(cancelled,true);
  assert.equal(await readBody(new Request("https://w/enquiry",{method:"POST",body:"中文"})),"中文");
});


test("I2-real. real staging keys require the same returned hostname check as production", async () => {
  verifyReply=async()=>new Response(JSON.stringify({success:true,hostname:"evil.example"}));
  const env=STG({TURNSTILE_SECRET:"real-staging-secret"});
  assert.equal((await worker.fetch(stgReq("s".repeat(32)),env)).status,403);
  routeFetch();
  assert.equal((await worker.fetch(stgReq("s".repeat(32)),STG({TURNSTILE_SECRET:"real-staging-secret"}))).status,200);
});

test("I4. durable same-ID retries do not redeliver or consume quota", async () => {
  routeFetch();const env=PROD();const payload={...VALID,submissionId:"I4-repeat"};
  assert.equal((await send(env,payload)).status,200);
  assert.equal((await (await send(env,payload)).json()).duplicate,true);
  assert.equal(env.ENQ_USAGE.m.get("total"),1);assert.equal(calls.length,1);
  _resetState();
  assert.equal((await (await send(env,payload)).json()).duplicate,true);
  assert.equal(env.ENQ_USAGE.m.get("total"),1);assert.equal(calls.length,1);
});


test("R1 production entry refuses inherited development bypass and missing secrets", async () => {
  const production = (await import("../production-worker.js")).default;
  for (const secret of [undefined, "", "1x0000000000000000000000000000000AA"]) {
    const env = {...PROD(), CAPTCHA_OPTIONAL:"true", STAGING:"true", WHATSAPP_DRY_RUN:"true", TURNSTILE_SECRET:secret};
    const req = new Request("https://worker.test/enquiry", {method:"POST", headers:{"Content-Type":"application/json",Origin:"https://example.com","CF-Connecting-IP":"1.2.3.4"}, body:JSON.stringify({...VALID,submissionId:"r1",captcha:"tok"})});
    assert.equal((await production.fetch(req,env)).status,403);
  }
  assert.equal(calls.length,0); assert.equal(verificationCalls.length,0);
  for (const key of [undefined,"short"]) {
    assert.equal((await post(VALID,{env:{...PROD(),CAPTCHA_OPTIONAL:"true",LIMIT_HMAC_KEY:key}})).status,503);
  }
  assert.equal(calls.length,0);
});

test("R2 inherited optional flag still calls real Siteverify and rejects failure", async () => {
  verifyReply = async () => Response.json({success:false});
  assert.equal((await post(VALID,{env:{...PROD(),CAPTCHA_OPTIONAL:"true"}})).status,403);
  assert.equal(verificationCalls.length,1); assert.equal(calls.length,0);
});

test("R3 concurrent identical IDs reserve once, persist acknowledgement and bind payload", async () => {
  const env=PROD(); const body={...VALID,submissionId:"concurrent-stable"};
  const responses=await Promise.all(Array.from({length:12},()=>post(body,{env})));
  assert.equal(calls.length,1);
  assert.ok(responses.every(r=>[200,409].includes(r.status)));
  assert.equal(env.ENQ_USAGE.m.get("total"),1);
  const repeat=await post(body,{env}); assert.equal(repeat.status,200); assert.equal((await repeat.json()).duplicate,true);
  const changed=await post({...body,description:"Changed payload"},{env});
  assert.equal(changed.status,409); assert.equal((await changed.json()).stage,"submission_conflict");
  assert.equal(calls.length,1); assert.equal(env.ENQ_USAGE.m.get("total"),1);
  const stored=JSON.stringify([...env.ENQ_USAGE.m]);
  for(const value of [VALID.name,VALID.description,"test-token","wamid.ABC","concurrent-stable"]) assert.ok(!stored.includes(value));
});
