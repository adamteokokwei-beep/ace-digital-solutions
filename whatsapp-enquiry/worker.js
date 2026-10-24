// =====================================================================
// WhatsApp enquiry endpoint (Cloudflare Worker, no dependencies)
//
// POST /enquiry  ->  validates the form, applies spam protection and sends the
// enquiry to the owner's WhatsApp through the official Meta WhatsApp Cloud API.
//
// Privacy by design:
//  - no database, no queue: enquiry contents only live in memory for the length
//    of one request (the optional KV store only holds spam counters keyed by a
//    one-way hash, never names, numbers or messages)
//  - enquiry contents are never written to logs (only status codes / error codes)
//  - secrets are read from server-side environment variables only
//
// Settings (environment variables / secrets) are listed in .env.example.
// =====================================================================

const MAX_BODY_BYTES = 8 * 1024;          // whole request
const LIMITS = { name: 80, phone: 25, type: 60, description: 1500, location: 100, budget: 60, timeline: 60 };
const ENQUIRY_TYPES = ["New website", "Redo my website", "Add-ons for my website", "Website chatbot", "Other",
  // options on the acedigitalsolutionsbiz.org contact form
  "A new website", "Redo my current website", "Add-ons for my existing website", "Customer enquiry assistant", "Not sure yet"];
const RATE = { max: 3, windowMs: 10 * 60 * 1000 };   // per IP, fallback limiter
const CAPS = { ipPerHour: 6, phonePerDay: 3, dailyTotal: 50 }; // used when the ENQ_KV store is connected
const DUPLICATE_MS = 10 * 60 * 1000;                // same submission id ignored for 10 min
const META_TIMEOUT_MS = 10000;

// In-memory state of this Worker instance only (best effort, never persisted, holds no enquiry content).
const memHits = new Map();       // ip -> [timestamps]
const memSeen = new Map();       // submissionId -> {at, result}

// ---------- small helpers ----------
const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

function cors(origin, allowed) {
  const list = String(allowed || "").split(",").map(s => s.trim()).filter(Boolean);
  const ok = !list.length || list.includes("*") || list.includes(origin) || (list.includes("null") && origin === "null");
  return {
    ok,
    headers: {
      "Access-Control-Allow-Origin": ok ? (origin || "*") : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
      "Vary": "Origin",
    },
  };
}

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max + 1);

// Malaysian or international number -> digits with country code (e.g. 60123456789), or "" if invalid
export function normalisePhone(raw) {
  const s = String(raw || "").trim();
  if (!/^[+\d][\d\s\-().]*$/.test(s)) return "";
  let d = s.replace(/\D/g, "");
  if (s.startsWith("+")) { /* already international */ }
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = "6" + d;          // Malaysian local format 01x...
  if (d.length < 9 || d.length > 15) return "";
  if (d.startsWith("60") && !/^60(1\d{8,9}|[3-9]\d{7,8})$/.test(d)) return "";
  return d;
}

// The main website's contact form uses its own field names (help, business, email, language, message; message optional).
// Turn them into this server's fields. Business, email and language go into the description line of the WhatsApp message.
export function fromSiteForm(input) {
  const email = clean(input.email, 120);
  const emailOk = !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const lang = /^(EN|BM|ZH)$/i.test(String(input.language || "")) ? String(input.language).toUpperCase() : "";
  const parts = [clean(input.message, 1200) || "(no message)"];
  if (clean(input.business, 100)) parts.push("Business: " + clean(input.business, 100));
  if (email && emailOk) parts.push("Email: " + email);
  if (lang) parts.push("Form language: " + lang);
  return { name: input.name, phone: input.phone, type: input.help, description: parts.join(" | "), location: "", budget: "", timeline: "", _site: true, _badEmail: !emailOk };
}

export function validate(input) {
  if (input && typeof input === "object" && "help" in input && !("type" in input)) input = fromSiteForm(input);
  const errors = {};
  if (input?._badEmail) errors.email = "invalid";
  const v = {};
  for (const k of Object.keys(LIMITS)) v[k] = clean(input?.[k], LIMITS[k]);
  if (!v.name) errors.name = "required";
  if (!v.phone) errors.phone = "required";
  if (!v.type) errors.type = "required";
  if (!v.description) errors.description = "required";
  for (const k of Object.keys(LIMITS)) if (v[k].length > LIMITS[k]) errors[k] = "too_long";
  if (v.phone && !errors.phone) { v.phoneDigits = normalisePhone(v.phone); if (!v.phoneDigits) errors.phone = "invalid"; }
  if (v.type && !ENQUIRY_TYPES.includes(v.type)) errors.type = "invalid";
  if (v.description && !errors.description && !input?._site && v.description.length < 10) errors.description = "too_short";
  return { ok: !Object.keys(errors).length, errors, value: v };
}

export function formatText(v) {
  return [
    "NEW WEBSITE ENQUIRY", "",
    "Name: " + defang(v.name),
    "WhatsApp: +" + v.phoneDigits,
    "Enquiry type: " + v.type,
    "Location: " + (defang(v.location) || "-"),
    "Budget: " + (v.budget || "-"),
    "Timeline: " + (v.timeline || "-"), "",
    "Description:", defang(v.description), "",
    "Source: Website enquiry form",
  ].join("\n");
}

// Template parameters may not contain new lines, tabs or more than 4 spaces in a row.
// Customer text must not turn into clickable links in the owner's WhatsApp (phishing): "evil.com" -> "evil[.]com"
export const defang = s => String(s || "").replace(/:\/\//g, "[:]//").replace(/([a-z0-9-])\.(?=[a-z][a-z0-9-]+)/gi, "$1[.]");
const tparam = s => String(s || "-").replace(/[\r\n\t]+/g, " / ").replace(/ {4,}/g, "   ").slice(0, 1000);

export function buildMetaPayload(env, v) {
  const to = String(env.WHATSAPP_RECIPIENT_NUMBER || "").replace(/\D/g, "");
  if (env.WHATSAPP_TEMPLATE_NAME) {
    return {
      messaging_product: "whatsapp", to, type: "template",
      template: {
        name: env.WHATSAPP_TEMPLATE_NAME,
        language: { code: env.WHATSAPP_TEMPLATE_LANGUAGE || "en" },
        components: [{ type: "body", parameters: [defang(v.name), "+" + v.phoneDigits, v.type, defang(v.location), v.budget, v.timeline, defang(v.description)].map(t => ({ type: "text", text: tparam(t) })) },
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
  // no anti-spam key set: refuse, unless testing is explicitly allowed with CAPTCHA_OPTIONAL=true
  if (!env.TURNSTILE_SECRET) { if (String(env.CAPTCHA_OPTIONAL) === "true") return true; console.log("enquiry: captcha not configured, refused"); return false; }
  // no pass from the browser (e.g. the local test file): only allowed while CAPTCHA_OPTIONAL=true; remove it before going live
  if (!token) return String(env.CAPTCHA_OPTIONAL) === "true";
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: String(token).slice(0, 2048) });
  if (ip) form.set("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    return !!(await r.json()).success;
  } catch { return false; }
}

async function rateLimited(env, ip) {
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === "function") {
    try { const { success } = await env.RATE_LIMITER.limit({ key: "enq:" + ip }); return !success; } catch { /* fall back */ }
  }
  const now = Date.now();
  const max = Number(env.RATE_LIMIT_MAX || RATE.max);
  const hits = (memHits.get(ip) || []).filter(t => now - t < RATE.windowMs);
  hits.push(now); memHits.set(ip, hits);
  if (memHits.size > 5000) memHits.clear();
  return hits.length > max;
}

// One-way hash so the counters never store a real IP address or phone number
async function hashKey(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ace-enq:" + s));
  return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}
// Longer-term limits (per visitor per hour, per customer number per day, total per day). Needs the ENQ_KV store; skipped without it.
async function overCaps(env, ip, phoneDigits) {
  const kv = env.ENQ_KV; if (!kv || typeof kv.get !== "function") return null;
  const day = new Date().toISOString().slice(0, 10), hour = new Date().toISOString().slice(0, 13);
  const dailyTotal = Number(env.DAILY_CAP || CAPS.dailyTotal);
  const keys = [
    ["total:" + day, dailyTotal, 90000, "daily_cap"],
    ["ip:" + hour + ":" + await hashKey(ip), CAPS.ipPerHour, 4000, "rate_limited"],
    ["ph:" + day + ":" + await hashKey(phoneDigits), CAPS.phonePerDay, 90000, "rate_limited"],
  ];
  try {
    const counts = await Promise.all(keys.map(([k]) => kv.get(k)));
    for (let i = 0; i < keys.length; i++) if (Number(counts[i] || 0) >= keys[i][1]) return keys[i][3];
    await Promise.all(keys.map(([k, , ttl], i) => kv.put(k, String(Number(counts[i] || 0) + 1), { expirationTtl: ttl })));
  } catch { console.log("enquiry: caps store unavailable"); }
  return null;
}

function seenBefore(id) {
  const now = Date.now();
  for (const [k, e] of memSeen) if (now - e.at > DUPLICATE_MS) memSeen.delete(k);
  return id ? memSeen.get(id) : undefined;
}

export function _resetState() { memHits.clear(); memSeen.clear(); }

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
  if (!/application\/json/i.test(request.headers.get("Content-Type") || "")) return json({ ok: false, stage: "bad_request" }, 415, h);

  // size limit (header check + actual length check)
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) return json({ ok: false, stage: "too_large" }, 413, h);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ ok: false, stage: "too_large" }, 413, h);
  let input;
  try { input = JSON.parse(raw); } catch { return json({ ok: false, stage: "bad_request" }, 400, h); }
  if (!input || typeof input !== "object") return json({ ok: false, stage: "bad_request" }, 400, h);

  // honeypot: bots get a normal-looking answer and nothing is sent
  if (clean(input.company_website, 200)) return json({ ok: true, stage: "accepted_by_whatsapp", messageId: "hp" }, 200, h);

  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For")?.split(",")[0].trim() || "local";
  if (await rateLimited(env, ip)) return json({ ok: false, stage: "rate_limited" }, 429, { ...h, "Retry-After": "600" });

  const check = validate(input);
  if (!check.ok) return json({ ok: false, stage: "invalid", errors: check.errors }, 422, h);

  if (!(await verifyTurnstile(env, input.captcha, ip))) return json({ ok: false, stage: "captcha_failed" }, 403, h);

  const cap = await overCaps(env, ip, check.value.phoneDigits);
  if (cap) { console.log("enquiry: limit reached:", cap); return json({ ok: false, stage: cap }, 429, { ...h, "Retry-After": "3600" }); }

  // repeated submission (double tap, refresh-resend): answer with the first result, send nothing new
  const sid = clean(input.submissionId, 64);
  const prev = seenBefore(sid);
  if (prev && prev.result) return json({ ...prev.result, duplicate: true }, prev.status, h);
  if (prev) return json({ ok: false, stage: "in_progress" }, 409, h);
  if (sid) memSeen.set(sid, { at: Date.now() });

  const finish = (result, status) => { if (sid) { if (result.ok) memSeen.set(sid, { at: Date.now(), result, status }); else memSeen.delete(sid); } return json(result, status, h); };

  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_RECIPIENT_NUMBER) {
    if (String(env.WHATSAPP_DRY_RUN) === "true") return finish({ ok: true, stage: "dry_run", preview: buildMetaPayload({ ...env, WHATSAPP_RECIPIENT_NUMBER: env.WHATSAPP_RECIPIENT_NUMBER || "60000000000" }, check.value) }, 200);
    console.log("enquiry: server not configured");
    return finish({ ok: false, stage: "not_configured" }, 503);
  }

  const payload = buildMetaPayload(env, check.value);
  if (String(env.WHATSAPP_DRY_RUN) === "true") return finish({ ok: true, stage: "dry_run", preview: payload }, 200);

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
    return finish({ ok: false, stage: "whatsapp_unavailable", reason: e?.name === "AbortError" ? "timeout" : "network" }, 504);
  }
  clearTimeout(timer);
  const result = classifyMeta(res.status, body);
  if (!result.ok) console.log("enquiry: whatsapp error", res.status, result.code ?? "", result.subcode ?? ""); // codes only, never content
  // Meta's own explanation (error text only; long digit runs such as phone numbers are masked)
  if (!result.ok) { const er = body?.error || {}; const mask = s => String(s || "").replace(/\d{6,}/g, "###").slice(0, 300); console.log("enquiry: meta says:", mask(er.type), "|", mask(er.message), "|", mask(er.error_data?.details), "| sent template:", mask(env.WHATSAPP_TEMPLATE_NAME), "lang:", mask(env.WHATSAPP_TEMPLATE_LANGUAGE || "en"), "api:", mask(env.WHATSAPP_API_VERSION || "v23.0")); }
  // self-check on a rejection: ask Meta what the configured Phone number ID points to (logged only, masked)
  if (!result.ok && result.stage === "whatsapp_rejected") {
    try {
      const chk = await fetch(`${base}/${env.WHATSAPP_API_VERSION || "v23.0"}/${env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name`, { headers: { "Authorization": `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` } });
      const cj = await chk.json().catch(() => ({}));
      const idLen = String(env.WHATSAPP_PHONE_NUMBER_ID).replace(/\D/g, "").length;
      console.log("enquiry: phone id check:", chk.status, "| id digits:", idLen, "| number:", String(cj.display_phone_number || "-").slice(0, 30), "| name:", String(cj.verified_name || "-").slice(0, 60), "| error:", String(cj.error?.message || "-").replace(/\d{6,}/g, "###").slice(0, 200), "| to digits:", String(env.WHATSAPP_RECIPIENT_NUMBER).replace(/\D/g, "").length);
    } catch (e) { console.log("enquiry: phone id check failed"); }
  }
  const status = result.ok ? 200 : result.stage === "whatsapp_auth_failed" ? 502 : result.stage === "whatsapp_busy" ? 503 : result.stage === "whatsapp_unavailable" ? 504 : 502;
  return finish(result, status);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path === "" || path === "/") return new Response("WhatsApp enquiry endpoint. POST /enquiry", { status: 200 });
    if (path.endsWith("/enquiry")) return handleEnquiry(request, env);
    return new Response("Not found", { status: 404 });
  },
};
