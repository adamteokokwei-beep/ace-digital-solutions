// Run: node --test test/worker.test.mjs        (no packages needed)
// All WhatsApp API calls are mocked. Nothing is ever sent.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { _resetState, normalisePhone, buildMetaPayload, defang, handleEnquiry } from "../worker.js";

const ENV = {
  WHATSAPP_ACCESS_TOKEN: "test-token", WHATSAPP_PHONE_NUMBER_ID: "123456789", WHATSAPP_RECIPIENT_NUMBER: "60100000000",
  WHATSAPP_API_VERSION: "v23.0", ALLOWED_ORIGIN: "https://example.com", META_TIMEOUT_MS: "300", CAPTCHA_OPTIONAL: "true",
};
const VALID = { name: "Mei Ling", phone: "012-345 6789", type: "New website", description: "I run a bakery in Skudai and need a simple website.", location: "Skudai", budget: "RM1,500 – RM2,500", timeline: "Within 1 month", company_website: "" };

let calls, metaReply, logs;
const realFetch = globalThis.fetch, realLog = console.log;
beforeEach(() => {
  _resetState(); calls = []; logs = [];
  console.log = (...a) => logs.push(a.join(" "));
  metaReply = async () => new Response(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ input: "60100000000", wa_id: "60100000000" }], messages: [{ id: "wamid.ABC", message_status: "accepted" }] }), { status: 200 });
  globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return metaReply(url, opts); };
});
process.on("exit", () => { globalThis.fetch = realFetch; console.log = realLog; });

let ipN = 0;
function post(body, { env = ENV, ip, headers = {} } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
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
    const r = await post({ ...VALID, submissionId: "rej" + code }); const b = await r.json();
    assert.equal(b.ok, false); assert.equal(b.stage, "whatsapp_rejected"); assert.equal(b.code, code);
  }
  metaReply = async () => new Response(JSON.stringify({ error: { message: "Too many", code: 130429 } }), { status: 429 });
  const b = await (await post(VALID)).json(); assert.equal(b.stage, "whatsapp_busy");
  noContentInLogs();
});

test("9. network timeout and API outage are reported as failures", async () => {
  metaReply = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  let r = await post(VALID); let b = await r.json();
  assert.equal(r.status, 504); assert.equal(b.ok, false); assert.equal(b.stage, "whatsapp_unavailable"); assert.equal(b.reason, "timeout");
  metaReply = async () => { throw new TypeError("fetch failed"); };
  b = await (await post(VALID)).json(); assert.equal(b.stage, "whatsapp_unavailable"); assert.equal(b.reason, "network");
  metaReply = async () => new Response("<html>oops</html>", { status: 503 });
  b = await (await post(VALID)).json(); assert.equal(b.ok, false); assert.equal(b.stage, "whatsapp_unavailable");
  metaReply = async () => new Response("{}", { status: 200 });            // 200 without a message id is NOT success
  b = await (await post(VALID)).json(); assert.equal(b.ok, false);
  noContentInLogs();
});

test("10. repeated submission (same submission id) is not sent twice; a failed one can be retried", async () => {
  const one = await (await post({ ...VALID, submissionId: "dup-1" })).json();
  const two = await (await post({ ...VALID, submissionId: "dup-1" })).json();
  assert.equal(one.ok, true); assert.equal(two.ok, true); assert.equal(two.duplicate, true);
  assert.equal(calls.length, 1, "WhatsApp must be called only once");
  // a failed attempt can be retried with the same id
  metaReply = async () => new Response(JSON.stringify({ error: { code: 131000 } }), { status: 500 });
  const f = await (await post({ ...VALID, submissionId: "dup-2" })).json(); assert.equal(f.ok, false);
  metaReply = async () => new Response(JSON.stringify({ messages: [{ id: "wamid.RETRY" }] }), { status: 200 });
  const ok = await (await post({ ...VALID, submissionId: "dup-2" })).json(); assert.equal(ok.ok, true); assert.equal(ok.messageId, "wamid.RETRY");
});

test("dry run validates and previews but never calls WhatsApp", async () => {
  const r = await post(VALID, { env: { ...ENV, WHATSAPP_DRY_RUN: "true" } }); const b = await r.json();
  assert.equal(b.ok, true); assert.equal(b.stage, "dry_run"); assert.match(b.preview.text.body, /NEW WEBSITE ENQUIRY/);
  assert.equal(calls.length, 0);
});

test("missing configuration reports not_configured, never success", async () => {
  const r = await post(VALID, { env: { ALLOWED_ORIGIN: "*", CAPTCHA_OPTIONAL: "true" } }); const b = await r.json();
  assert.equal(r.status, 503); assert.equal(b.ok, false); assert.equal(b.stage, "not_configured");
});

test("other websites (origins) are refused; secrets never reach the browser", async () => {
  const r = await post(VALID, { headers: { Origin: "https://evil.example" } });
  assert.equal(r.status, 403); assert.equal(calls.length, 0);
  const ok = await post({ ...VALID, submissionId: "sec" }); const text = await ok.text();
  assert.ok(!text.includes("test-token") && !text.includes("123456789"));
});

test("11. without an anti-spam key the server refuses (unless CAPTCHA_OPTIONAL=true)", async () => {
  const env = { ...ENV }; delete env.CAPTCHA_OPTIONAL;
  const r = await handleEnquiry(new Request("https://w.example/enquiry", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.com", "CF-Connecting-IP": "9.9.9.1" }, body: JSON.stringify({ ...VALID, submissionId: "nocap" }) }), env);
  assert.equal(r.status, 403); assert.equal((await r.json()).stage, "captcha_failed"); assert.equal(calls.length, 0);
});

test("12. links typed by a customer are made unclickable in the WhatsApp message", async () => {
  assert.equal(defang("see evil.com or https://bit.ly/x"), "see evil[.]com or https[:]//bit[.]ly/x");
  assert.equal(defang("RM1.50, e.g. Skudai"), "RM1.50, e.g. Skudai");
  const p = buildMetaPayload({ ...ENV, WHATSAPP_TEMPLATE_NAME: "website_enquiry" }, { name: "x", phoneDigits: "60123456789", type: "Other", location: "", budget: "", timeline: "", description: "go to evil.com" });
  assert.equal(p.template.components[0].parameters[6].text, "go to evil[.]com");
  assert.equal(p.template.components[0].parameters[1].text, "+60123456789");
});

test("13. with the KV store: same customer number max 3 a day, and a total daily cap", async () => {
  const store = new Map(); const kv = { get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } };
  const env = { ...ENV, ENQ_KV: kv, DAILY_CAP: "5", RATE_LIMITER: { limit: async () => ({ success: true }) } };
  const send = (i, phone, ip) => handleEnquiry(new Request("https://w.example/enquiry", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.com", "CF-Connecting-IP": ip }, body: JSON.stringify({ ...VALID, phone, submissionId: "kv" + i }) }), env);
  const a = []; for (let i = 0; i < 4; i++) a.push((await send(i, "012-345 6789", "5.5.5." + i)).status);
  assert.deepEqual(a, [200, 200, 200, 429]);
  assert.equal((await send(10, "012-000 0001", "6.6.6.1")).status, 200);
  assert.equal((await send(11, "012-000 0002", "6.6.6.2")).status, 200);
  const r = await send(12, "012-000 0003", "6.6.6.3"); assert.equal(r.status, 429); assert.equal((await r.json()).stage, "daily_cap");
  assert.ok(![...store.keys()].some(k => /0123456789|5\.5\.5/.test(k)), "no raw phone or IP in store keys");
});

test("14. with an anti-spam key: a missing pass is refused unless CAPTCHA_OPTIONAL=true", async () => {
  const mk = env => handleEnquiry(new Request("https://w.example/enquiry", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.com", "CF-Connecting-IP": "7.7.7.7" }, body: JSON.stringify({ ...VALID, submissionId: "ts" + Math.random() }) }), env);
  const strict = { ...ENV, TURNSTILE_SECRET: "s" }; delete strict.CAPTCHA_OPTIONAL;
  assert.equal((await mk(strict)).status, 403);
  assert.equal((await mk({ ...ENV, TURNSTILE_SECRET: "s", CAPTCHA_OPTIONAL: "true" })).status, 200);
});
