// =====================================================================
// Website enquiry endpoint (Cloudflare Worker, no dependencies)
//
// POST /enquiry  ->  validates the form, applies spam protection, then delivers the
// enquiry to the owner by BOTH channels:
//   1. WhatsApp, through the official Meta WhatsApp Cloud API
//   2. email, through Cloudflare Email Routing (send_email binding, owner's verified address only)
// Every submission passes the same checks (validation, Turnstile, rate limits) before either channel.
//
// Privacy by design:
//  - no database, no queue: enquiry contents only live in memory for the length of one request
//  - the Durable Object only holds spam counters under secret-keyed HMAC identifiers (never names,
//    numbers, IP addresses or messages)
//  - enquiry contents are never written to logs (only status codes / error codes)
//  - secrets are read from server-side environment variables only
//
// Security-critical services fail CLOSED: if the rate limiter, the counter store or the HMAC key
// is missing or failing, enquiries are refused (the website then offers its WhatsApp/copy fallback).
// Legacy development flags never weaken the deployable Worker security checks.
//
// Settings (environment variables / secrets / bindings) are listed in .env.example and wrangler.toml.
// =====================================================================

const MAX_BODY_BYTES = 8 * 1024;          // whole request
const LIMITS = { name: 80, phone: 25, type: 60, description: 1500, location: 100, budget: 60, timeline: 60 };
const ENQUIRY_TYPES = ["New website", "Redo my website", "Add-ons for my website", "Website chatbot", "Other",
  // options on the acedigitalsolutionsbiz.org contact form
  "A new website", "Redo my current website", "Add-ons for my existing website", "Customer enquiry assistant", "Not sure yet"];
// Budget and timeline are fixed choices (test page); anything else is refused
const BUDGETS = ["", "Below RM1,500", "RM1,500 – RM2,500", "RM2,500 – RM4,000", "Above RM4,000"];
const TIMELINES = ["", "As soon as possible", "Within 2 weeks", "Within 1 month", "In 1–3 months"];
const CAPS = { ipPerHour: 6, phonePerDay: 3, dailyTotal: 50 };
const META_TIMEOUT_MS = 10000;
let EmailMessageCtor = null;     // set in tests; otherwise loaded from "cloudflare:email"

// ---------- small helpers ----------
const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const TEST_SECRETS = new Set(["1x0000000000000000000000000000000AA", "2x0000000000000000000000000000000AA", "3x0000000000000000000000000000000AA"]);

function cors(origin, allowed) {
  const list = String(allowed || "").split(",").map(s => s.trim()).filter(Boolean);
  const ok = !!origin && origin !== "null" && list.includes(origin);
  return {
    ok,
    headers: {
      "Access-Control-Allow-Origin": ok ? (origin || "*") : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Staging-Key",
      "Access-Control-Max-Age": "600",
      "Vary": "Origin",
    },
  };
}

// ---------- input sanitising (applied to EVERY customer-controlled field) ----------
// 1. Unicode NFKC (turns full-width letters/dots into normal ones)  2. odd dots -> "."
// 3. remove control, zero-width and bidi-override characters  4. trim and limit length
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￹-￻]/g;
export function sanitize(v, max, { multiline = false } = {}) {
  let s = String(v ?? "");
  try { s = s.normalize("NFKC"); } catch { /* keep as is */ }
  s = s.replace(/[。｡﹒․‧·・]/g, m => (m === "·" || m === "・") ? m : ".")
       .replace(INVISIBLE, "");
  s = multiline ? s.replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(/\n{3,}/g, "\n\n") : s.replace(/[\r\n\t\u2028\u2029]+/g, " ");
  return s.trim().slice(0, max + 1);
}
const clean = (v, max) => sanitize(v, max);

// Output safety for text shown to the owner (WhatsApp and email):
//  - links can't become clickable: "evil.com" -> "evil[.]com", "https://" -> "https[:]//", IPs too
//  - WhatsApp formatting characters are neutralised so customers can't bold/strike/monospace text
export const defang = s => String(s || "")
  .replace(/:\/\//g, "[:]//")
  .replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, "$1[.]$2[.]$3[.]$4")
  .replace(/([\p{L}\p{N}-])\.(?=[\p{L}][\p{L}\p{N}-]+)/gu, "$1[.]");
const neutralise = s => String(s || "").replace(/\*/g, "∗").replace(/_/g, "ˍ").replace(/~/g, "∼").replace(/`/g, "ʹ");
export const safeText = s => neutralise(defang(s));

// Malaysian or international number -> digits with country code (e.g. 60123456789), or "" if invalid
export function normalisePhone(raw) {
  const s = sanitize(raw, 40);
  if (!/^[+\d][\d\s\-().]*$/.test(s)) return "";
  let d = s.replace(/\D/g, "");
  if (s.startsWith("+")) { /* already international */ }
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = "6" + d;          // Malaysian local format 01x...
  if (d.length < 9 || d.length > 15) return "";
  if (d.startsWith("60") && !/^60(1\d{8,9}|[3-9]\d{7,8})$/.test(d)) return "";
  return d;
}

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// The main website's contact form uses its own field names (help, business, email, language, message; message optional).
// Turn them into this server's fields. Business, email and language go into the description line of the WhatsApp message.
export function fromSiteForm(input) {
  const email = sanitize(input.email, 120);
  const emailOk = !email || (email.length <= 120 && EMAIL_RE.test(email));
  const lang = /^(EN|BM|ZH)$/i.test(String(input.language || "")) ? String(input.language).toUpperCase() : "";
  const business = sanitize(input.business, 100), message = sanitize(input.message, 1200, { multiline: true });
  const parts = [message || "(no message)"];
  if (business) parts.push("Business: " + business);
  if (email && emailOk) parts.push("Email: " + email);
  if (lang) parts.push("Form language: " + lang);
  return { name: input.name, phone: input.phone, type: input.help, description: parts.join(" | "), location: "", budget: "", timeline: "",
           _site: true, _badEmail: !emailOk, _email: emailOk ? email : "", _business: business, _lang: lang, _message: message };
}

export function validate(input) {
  const fields = ["name", "phone", "type", "description", "location", "budget", "timeline", "help", "business", "email", "language", "message"];
  for (const field of fields) if (input?.[field] != null && typeof input[field] !== "string") return { ok: false, errors: { [field]: "invalid" }, value: {} };
  if (input && typeof input === "object" && "help" in input && !("type" in input)) input = fromSiteForm(input);
  else input = Object.fromEntries(Object.keys(LIMITS).map(k => [k, input?.[k]]));
  const errors = {};
  if (input?._badEmail) errors.email = "invalid";
  const v = {};
  for (const k of Object.keys(LIMITS)) v[k] = sanitize(input?.[k], LIMITS[k], { multiline: k === "description" });
  if (!v.name) errors.name = "required";
  if (!v.phone) errors.phone = "required";
  if (!v.type) errors.type = "required";
  if (!v.description) errors.description = "required";
  for (const k of Object.keys(LIMITS)) if (v[k].length > LIMITS[k]) errors[k] = "too_long";
  if (v.phone && !errors.phone) { v.phoneDigits = normalisePhone(v.phone); if (!v.phoneDigits) errors.phone = "invalid"; }
  if (v.type && !ENQUIRY_TYPES.includes(v.type)) errors.type = "invalid";
  if (!BUDGETS.includes(v.budget)) errors.budget = "invalid";
  if (!TIMELINES.includes(v.timeline)) errors.timeline = "invalid";
  if (v.description && !errors.description && !input?._site && v.description.length < 10) errors.description = "too_short";
  v.email = input?._email || ""; v.business = input?._business || ""; v.lang = input?._lang || ""; v.message = input?._message ?? null; v.site = !!input?._site;
  return { ok: !Object.keys(errors).length, errors, value: v };
}

// Delimit every line of visitor prose, so forged "Email:" / "WhatsApp:" labels
// cannot appear as trusted owner-facing fields (Red Team L-2).
export const quoteText = s => safeText(s).split(/\r\n?|[\n\u0085\u2028\u2029]/).map(line => "> " + line).join("\n");

export function formatText(v) {
  return [
    "NEW WEBSITE ENQUIRY", "",
    "Name: " + safeText(v.name),
    "WhatsApp: +" + v.phoneDigits,
    "Enquiry type: " + v.type,
    "Location: " + (safeText(v.location) || "-"),
    "Budget: " + (v.budget || "-"),
    "Timeline: " + (v.timeline || "-"), "",
    "Description (visitor text):", quoteText(v.description), "",
    "Source: Website enquiry form",
  ].join("\n");
}

// Template parameters may not contain new lines, tabs or more than 4 spaces in a row.
const tparam = s => String(s || "-").replace(/[\r\n\t]+/g, " / ").replace(/ {4,}/g, "   ").slice(0, 1000);

export function buildMetaPayload(env, v) {
  const to = String(env.WHATSAPP_RECIPIENT_NUMBER || "").replace(/\D/g, "");
  if (env.WHATSAPP_TEMPLATE_NAME) {
    return {
      messaging_product: "whatsapp", to, type: "template",
      template: {
        name: env.WHATSAPP_TEMPLATE_NAME,
        language: { code: env.WHATSAPP_TEMPLATE_LANGUAGE || "en" },
        // every free-text value goes through safeText; type/budget/timeline are fixed choices; phone is digits only
        components: [{ type: "body", parameters: [safeText(v.name), "+" + v.phoneDigits, v.type, safeText(v.location), v.budget, v.timeline, quoteText(v.description)].map(t => ({ type: "text", text: tparam(t) })) },
          // optional "Reply on WhatsApp" button (template button URL https://wa.me/{{1}}); only when the template has that button
          ...(String(env.WHATSAPP_REPLY_BUTTON) === "true" ? [{ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: v.phoneDigits }] }] : [])],
      },
    };
  }
  return { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: formatText(v) } };
}

// Map Meta's answer to a stage the website can show. Never includes enquiry content.
export function classifyMeta(status, body) {
  const msg = body?.messages?.[0];
  if (status >= 200 && status < 300 && msg?.id) return { ok: true, stage: "accepted_by_whatsapp", messageId: msg.id, messageStatus: msg.message_status || "accepted" };
  const code = body?.error?.code;
  const sub = body?.error?.error_subcode;
  if (status === 401 || code === 190 || code === 0 || (code >= 200 && code < 300)) return { ok: false, stage: "whatsapp_auth_failed", code };
  if (status === 429 || code === 130429 || code === 131056 || code === 80007 || code === 4) return { ok: false, stage: "whatsapp_busy", code };
  if (status >= 500) return { ok: false, stage: "whatsapp_unavailable", code };
  return { ok: false, stage: "whatsapp_rejected", code, subcode: sub };
}

async function verifyTurnstile(env, token, ip) {
  if (typeof env.TURNSTILE_SECRET !== "string" || !env.TURNSTILE_SECRET.trim()) return false;
  const testSecret = TEST_SECRETS.has(env.TURNSTILE_SECRET);
  if (testSecret && !(String(env.STAGING) === "true" && stagingIsolated(env))) return false;
  if (typeof token !== "string" || !token.trim() || token.length > 2048) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  if (ip) form.set("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body: form, signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return false;
    const result = await r.json();
    if (result.success !== true) return false;
    // Cloudflare test keys return a dummy hostname. Only isolated staging may skip this check.
    if (String(env.STAGING) === "true" && stagingIsolated(env) &&
        env.TURNSTILE_SECRET === "1x0000000000000000000000000000000AA") return true;
    const hosts = String(env.ALLOWED_ORIGIN || "").split(",").map(s => {
      try { return new URL(s.trim()).hostname; } catch { return ""; }
    }).filter(Boolean);
    return hosts.includes(result.hostname) && (!env.TURNSTILE_ACTION || result.action === env.TURNSTILE_ACTION);
  } catch { return false; }
}

// ---------- rate limits (fail closed) ----------
// Returns "" when allowed, "rate_limited", or "unavailable" (limiter missing/failing -> refuse).
async function rateLimited(env, ip) {
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === "function") {
    try { const { success } = await env.RATE_LIMITER.limit({ key: "enq:" + ip }); return success === true ? "" : "rate_limited"; }
    catch { console.log("enquiry: rate limiter unavailable, refused"); return "unavailable"; }
  }
  console.log("enquiry: rate limiter not configured, refused"); return "unavailable";
}

// Secret-keyed HMAC-SHA-256, so stored counter names can't be turned back into IP addresses or phone numbers
const hmacKeys = new Map();
export async function counterId(env, s) {
  const secret = env.LIMIT_HMAC_KEY;
  if (typeof secret !== "string" || secret.trim().length < 32) throw new Error("no hmac key");
  let key = hmacKeys.get(secret);
  if (!key) { key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); hmacKeys.set(secret, key); }
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("enq:" + s));
  return [...new Uint8Array(sig)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}

// One object per UTC day; all three caps are reserved in one storage transaction.
// Persist only HMAC identifiers and counts. No raw visitor data or delivery content.
export class EnquiryUsage {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    let q; try { q = await request.json(); } catch { return new Response(null, { status: 400 }); }
    const digest = v => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
    if (!digest(q?.sid) || !digest(q?.fingerprint)) return new Response(null, { status: 400 });
    const settle = new URL(request.url).pathname === "/settle";
    if (!settle && (!digest(q.ip) || !digest(q.phone) || !/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(q.hour) ||
        !Number.isSafeInteger(q.dailyCap) || q.dailyCap < 0)) return new Response(null, { status: 400 });
    await this.ctx.storage.setAlarm(Date.now() + 48 * 60 * 60 * 1000);
    const answer = await this.ctx.storage.transaction(async tx => {
      const ledgerKey = "sid:" + q.sid;
      const ledger = (await tx.get([ledgerKey])).get(ledgerKey);
      if (ledger && (typeof ledger.fingerprint !== "string" || !["pending", "complete", "uncertain"].includes(ledger.state))) throw new Error("invalid ledger");
      if (ledger && ledger.fingerprint !== q.fingerprint) return { result: "submission_conflict" };
      if (settle) {
        if (!ledger || ledger.state !== "pending") return { result: "unavailable" };
        const success = q.outcome?.ok === true && ["accepted_by_whatsapp", "delivered_by_email", "dry_run"].includes(q.outcome.stage);
        // Only fixed acknowledgement metadata is persisted, never enquiry text, token or provider IDs.
        const outcome = success ? { ok: true, stage: q.outcome.stage } : null;
        if (success && q.outcome.channels) {
          const ch = q.outcome.channels;
          if (![ch.whatsapp, ch.email].every(v => ["sent", "failed", "off"].includes(v))) throw new Error("invalid outcome");
          outcome.channels = { whatsapp: ch.whatsapp, email: ch.email };
        }
        await tx.put({ [ledgerKey]: { fingerprint: q.fingerprint, state: success ? "complete" : "uncertain", ...(outcome ? { outcome } : {}) } });
        return { result: "settled" };
      }
      if (ledger) {
        if (ledger.state === "complete") {
          if (ledger.outcome?.ok !== true || !["accepted_by_whatsapp", "delivered_by_email", "dry_run"].includes(ledger.outcome.stage)) throw new Error("invalid acknowledgement");
          return { result: "duplicate", outcome: ledger.outcome };
        }
        return { result: ledger.state === "pending" ? "in_progress" : "delivery_uncertain" };
      }
      const keys = ["total", "ip:" + q.hour + ":" + q.ip, "ph:" + q.phone];
      const caps = [q.dailyCap, CAPS.ipPerHour, CAPS.phonePerDay];
      const stored = await tx.get(keys);
      const counts = keys.map(k => stored.get(k) ?? 0);
      if (counts.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error("invalid counter");
      for (let i = 0; i < keys.length; i++) if (counts[i] >= caps[i]) return { result: i ? "rate_limited" : "daily_cap" };
      await tx.put({ ...Object.fromEntries(keys.map((k, i) => [k, counts[i] + 1])), [ledgerKey]: { fingerprint: q.fingerprint, state: "pending" } });
      return { result: "" };
    });
    return new Response(JSON.stringify(answer), { headers: { "Content-Type": "application/json" } });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

async function usageRequest(stub, path, body) {
  let timer;
  const r = await Promise.race([
    stub.fetch("https://usage/" + path, { method: "POST", body: JSON.stringify(body) }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 3000); }),
  ]).finally(() => clearTimeout(timer));
  if (!r.ok) throw new Error("counter error");
  return r.json();
}

async function overCaps(env, ip, value, submissionId) {
  if (!env.ENQ_USAGE) return { result: "unavailable" };
  try {
    const now = new Date().toISOString();
    const stub = env.ENQ_USAGE.get(env.ENQ_USAGE.idFromName("enquiry:" + now.slice(0, 10)));
    const sid = await counterId(env, "submission:" + submissionId);
    const fingerprint = await counterId(env, "payload:" + JSON.stringify({ ...value, phone: value.phoneDigits }));
    const q = { sid, fingerprint, hour: now.slice(0, 13), dailyCap: Number(env.DAILY_CAP ?? CAPS.dailyTotal),
      ip: await counterId(env, ip), phone: await counterId(env, value.phoneDigits) };
    const answer = await usageRequest(stub, "reserve", q);
    if (!["", "daily_cap", "rate_limited", "duplicate", "in_progress", "delivery_uncertain", "submission_conflict"].includes(answer.result)) return { result: "unavailable" };
    if (answer.result === "duplicate" && (answer.outcome?.ok !== true || !["accepted_by_whatsapp", "delivered_by_email", "dry_run"].includes(answer.outcome.stage))) return { result: "unavailable" };
    return { ...answer, stub, sid, fingerprint };
  } catch { console.log("enquiry: usage counter unavailable"); return { result: "unavailable" }; }
}

export function _resetState() {} // Compatibility for isolated test harnesses; no isolate-local security state remains.
export function _setEmailMessage(ctor) { EmailMessageCtor = ctor; }

// ---------- email (Cloudflare Email Routing, owner's verified address only) ----------
const b64 = s => { const bytes = new TextEncoder().encode(s); let bin = ""; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); };
const wrap76 = s => s.replace(/.{1,76}/g, "$&\r\n").trimEnd();
const encWord = s => "=?UTF-8?B?" + b64(s) + "?=";
const headerSafe = s => String(s || "").replace(/[\r\n]+/g, " ").trim();
const addrOf = s => (String(s).match(/<([^>]+)>/) || [, String(s)])[1].trim();

export function buildEmail(env, v, { messageIdDomain } = {}) {
  const from = headerSafe(env.EMAIL_FROM), to = headerSafe(env.EMAIL_TO);
  const lines = [
    "New website enquiry", "",
    "Name: " + safeText(v.name),
    "WhatsApp: +" + v.phoneDigits,
    "Enquiry type: " + v.type,
  ];
  if (v.site) {
    lines.push("Business: " + (safeText(v.business) || "-"), "Email: " + (v.email ? safeText(v.email) : "-"), "Form language: " + (v.lang || "-"), "", "Message:", quoteText(v.message || "(no message)"));
  } else {
    lines.push("Location: " + (safeText(v.location) || "-"), "Budget: " + (v.budget || "-"), "Timeline: " + (v.timeline || "-"), "", "Description (visitor text):", quoteText(v.description));
  }
  lines.push("", "Reply on WhatsApp: open WhatsApp and message +" + v.phoneDigits, "Source: website enquiry form (checked by Turnstile and rate limits)");
  const domain = messageIdDomain || (addrOf(from).split("@")[1] || "localhost");
  const headers = [
    "From: " + from,
    "To: " + to,
    ...(v.email && EMAIL_RE.test(v.email) ? ["Reply-To: " + v.email] : []),
    "Subject: " + encWord("Website enquiry: " + sanitize(v.name, 60)),
    "Date: " + new Date().toUTCString(),
    "Message-ID: <" + crypto.randomUUID() + "@" + domain + ">",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  return { from: addrOf(from), to: addrOf(to), raw: headers.join("\r\n") + "\r\n\r\n" + wrap76(b64(lines.join("\r\n"))) + "\r\n" };
}

async function sendEmail(env, v) {
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") return "off";
  if (!env.EMAIL_FROM || !env.EMAIL_TO) { console.log("enquiry: email binding set but EMAIL_FROM/EMAIL_TO missing"); return "failed"; }
  try {
    const m = buildEmail(env, v);
    const Ctor = EmailMessageCtor || (await import("cloudflare:email")).EmailMessage;
    await env.EMAIL.send(new Ctor(m.from, m.to, m.raw));
    return "sent";
  } catch (e) { console.log("enquiry: email failed"); return "failed"; }
}

// ---------- WhatsApp ----------
async function sendWhatsApp(env, payload) {
  const base = (env.WHATSAPP_API_BASE || "https://graph.facebook.com").replace(/\/+$/, "");
  const url = `${base}/${env.WHATSAPP_API_VERSION || "v23.0"}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(env.META_TIMEOUT_MS || META_TIMEOUT_MS));
  let res, body;
  try {
    res = await fetch(url, { method: "POST", signal: ctrl.signal, headers: { "Authorization": `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    body = await res.json().catch(() => ({}));
  } catch (e) {
    clearTimeout(timer);
    console.log("enquiry: whatsapp request failed:", e?.name === "AbortError" ? "timeout" : "network");
    return { ok: false, stage: "whatsapp_unavailable", reason: e?.name === "AbortError" ? "timeout" : "network" };
  }
  clearTimeout(timer);
  const result = classifyMeta(res.status, body);
  if (!result.ok) {
    console.log("enquiry: whatsapp error", res.status, result.code ?? "", result.subcode ?? ""); // codes only, never content
  }
  return result;
}

// Stop reading once the byte budget is exceeded, even without Content-Length.
export async function readBody(request) {
  if (!request.body) return "";
  const reader = request.body.getReader(); let size = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new RangeError("too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

// ---------- request handler ----------
export async function handleEnquiry(request, env) {
  // ignore stray spaces/newlines picked up when pasting settings into "wrangler secret put"
  env = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]));
  const origin = request.headers.get("Origin") || "";
  const c = cors(origin, env.ALLOWED_ORIGIN);
  const h = c.headers;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (request.method !== "POST") return json({ ok: false, stage: "method_not_allowed" }, 405, h);
  if (!c.ok) return json({ ok: false, stage: "origin_not_allowed" }, 403, h);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "")) return json({ ok: false, stage: "bad_request" }, 415, h);

  // size limit (header check + actual length check)
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) return json({ ok: false, stage: "too_large" }, 413, h);
  let raw;
  try { raw = await readBody(request); }
  catch (e) { return json({ ok: false, stage: e instanceof RangeError ? "too_large" : "bad_request" }, e instanceof RangeError ? 413 : 400, h); }
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ ok: false, stage: "too_large" }, 413, h);
  let input;
  try { input = JSON.parse(raw); } catch { return json({ ok: false, stage: "bad_request" }, 400, h); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return json({ ok: false, stage: "bad_request" }, 400, h);

  // honeypot: bots get a normal-looking answer and nothing is sent
  if (clean(input.company_website, 200)) return json({ ok: true, stage: "accepted_by_whatsapp", messageId: "hp" }, 200, h);

  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!ip) return json({ ok: false, stage: "service_unavailable" }, 503, h);
  const rl = await rateLimited(env, ip);
  if (rl === "unavailable") return json({ ok: false, stage: "service_unavailable" }, 503, { ...h, "Retry-After": "300" });
  if (rl) return json({ ok: false, stage: "rate_limited" }, 429, { ...h, "Retry-After": "600" });

  const check = validate(input);
  if (!check.ok) return json({ ok: false, stage: "invalid", errors: check.errors }, 422, h);

  const sid = input.submissionId;
  if (typeof sid !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(sid)) return json({ ok: false, stage: "invalid", errors: { submissionId: "invalid" } }, 422, h);
  if (!(await verifyTurnstile(env, input.captcha, ip))) return json({ ok: false, stage: "captcha_failed" }, 403, h);

  const claim = await overCaps(env, ip, check.value, sid);
  const cap = claim.result;
  if (cap === "unavailable") return json({ ok: false, stage: "service_unavailable" }, 503, { ...h, "Retry-After": "300" });
  if (cap === "duplicate") return json({ ...claim.outcome, duplicate: true }, 200, h);
  if (["in_progress", "delivery_uncertain", "submission_conflict"].includes(cap)) return json({ ok: false, stage: cap }, 409, h);
  if (cap) return json({ ok: false, stage: cap }, 429, { ...h, "Retry-After": "3600" });

  const finish = async (result, status) => {
    try {
      const settled = await usageRequest(claim.stub, "settle", { sid: claim.sid, fingerprint: claim.fingerprint, outcome: { ok: result.ok, stage: result.stage, ...(result.channels ? { channels: result.channels } : {}) } });
      if (settled.result !== "settled") throw new Error("settlement failed");
    } catch {
      // Delivery may already have occurred. Leave the claim locked; never auto-resend this ID.
      console.log("enquiry: acknowledgement unavailable");
      return json({ ok: false, stage: "delivery_uncertain" }, 503, h);
    }
    return json(result, status, h);
  };

  const waReady = !!(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_RECIPIENT_NUMBER);
  const emailReady = !!(env.EMAIL && typeof env.EMAIL.send === "function");

  if (String(env.WHATSAPP_DRY_RUN) === "true") {
    const preview = buildMetaPayload({ ...env, WHATSAPP_RECIPIENT_NUMBER: env.WHATSAPP_RECIPIENT_NUMBER || "60000000000" }, check.value);
    // staging only: also show the email that would be sent (headers + decoded body), to test it without sending
    const emailPreview = String(env.STAGING) === "true" && env.EMAIL_FROM && env.EMAIL_TO ? (m => ({ headers: m.raw.split("\r\n\r\n")[0], body: new TextDecoder().decode(Uint8Array.from(atob(m.raw.split("\r\n\r\n")[1].replace(/\r\n/g, "")), c => c.charCodeAt(0))) }))(buildEmail(env, check.value)) : undefined;
    return finish({ ok: true, stage: "dry_run", preview, ...(emailPreview ? { emailPreview } : {}) }, 200);
  }
  if (!waReady && !emailReady) { console.log("enquiry: server not configured"); return finish({ ok: false, stage: "not_configured" }, 503); }

  // deliver by both channels at the same time; success if either one gets through
  const [wa, email] = await Promise.all([
    waReady ? sendWhatsApp(env, buildMetaPayload(env, check.value)) : Promise.resolve({ ok: false, stage: "whatsapp_off" }),
    sendEmail(env, check.value),
  ]);
  const channels = { whatsapp: wa.ok ? "sent" : waReady ? "failed" : "off", email };
  if (wa.ok) return finish({ ...wa, channels }, 200);
  if (email === "sent") return finish({ ok: true, stage: "delivered_by_email", channels }, 200);
  const status = wa.stage === "whatsapp_auth_failed" ? 502 : wa.stage === "whatsapp_busy" ? 503 : wa.stage === "whatsapp_unavailable" ? 504 : 502;
  return finish({ ...wa, channels }, waReady ? status : 502);
}

// ---------- staging only ----------
// STAGING=true (set only in the staging environment) requires the X-Staging-Key header on every request.
// Staging also refuses to run if any real delivery credential is present, so it can never message the owner.
export function stagingKeyOk(request, env) {
  const want = String(env.STAGING_ACCESS_KEY || ""), got = String(request.headers.get("X-Staging-Key") || "");
  if (want.length < 16 || got.length !== want.length) return false;
  let diff = 0; for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
export function stagingIsolated(env) {
  return !env.WHATSAPP_ACCESS_TOKEN && !env.EMAIL && String(env.WHATSAPP_DRY_RUN) === "true";
}

export default {
  async fetch(request, env) {
    if (String(env.STAGING) === "true") {
      if (request.method !== "OPTIONS" && !stagingKeyOk(request, env)) return new Response(JSON.stringify({ ok: false, stage: "staging_key_required" }), { status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-Staging-Key" } });
      if (!stagingIsolated(env)) { console.log("staging: refused, a real delivery credential is configured"); return new Response(JSON.stringify({ ok: false, stage: "staging_not_isolated" }), { status: 503, headers: { "Content-Type": "application/json" } }); }
    }
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path === "" || path === "/") return new Response("Enquiry endpoint. POST /enquiry", { status: 200 });
    if (path === "/enquiry") return handleEnquiry(request, env);
    return new Response("Not found", { status: 404 });
  },
};
