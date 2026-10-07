// Ace Digital Solutions — website backend (Cloudflare Worker)
// ----------------------------------------------------------------
// Two jobs, one small server:
//   POST /chat      → the website chatbot (Google Gemini — free tier, ChatGPT, or Claude). Keeps your API key out of the website code.
//   POST /enquiry   → the consultation form. Emails the enquiry to you and sends the customer
//                     a confirmation email (via Resend, resend.com, free tier).
//
// Settings (Cloudflare dashboard → your Worker → Settings → Variables):
//   Chatbot — set ONE of these keys (if more than one is set, the first in this list is used):
//   GEMINI_API_KEY     (Secret)  free key from aistudio.google.com/apikey    (Google Gemini, free tier)
//   GEMINI_MODEL       (Text, optional) defaults to gemini-flash-latest
//   OPENAI_API_KEY     (Secret)  key from platform.openai.com/api-keys     (ChatGPT, paid)
//   OPENAI_MODEL       (Text, optional) defaults to gpt-4o-mini
//   ANTHROPIC_API_KEY  (Secret)  key from console.anthropic.com             (Claude, paid)
//   RESEND_API_KEY     (Secret)  key from resend.com                        (for /enquiry)
//   OWNER_EMAIL        (Text)    where enquiries go, e.g. adamteokokwei@gmail.com
//   FROM_EMAIL         (Text)    sender on your verified domain, e.g. Ace Digital Solutions <hello@yourdomain.com>
//   ALLOWED_ORIGIN     (Text)    your website address(es), comma-separated, e.g. https://acesite.netlify.app, https://yourdomain.com, https://www.yourdomain.com
//
// In the website file, set:
//   CHAT_API = "https://YOUR-WORKER.workers.dev/chat"
//   FORM_API = "https://YOUR-WORKER.workers.dev/enquiry"

const GEMINI_MODEL = "gemini-flash-latest";       // always points to Google's current Flash model
const OPENAI_MODEL = "gpt-4o-mini";               // fast and low-cost; override with the OPENAI_MODEL setting
const CLAUDE_MODEL = "claude-haiku-4-5-20251001"; // used only if you choose Claude instead
const MAX_TOKENS = 400;                    // keeps answers short and costs low
const MAX_TURNS = 12;                      // how much of the conversation is sent each time
const MAX_CHARS = 800;                     // longest message a visitor can send

const SYSTEM_PROMPT = `You are the website assistant for Ace Digital Solutions, a small web design business run by Adam. You answer visitors' questions on the Ace Digital Solutions website.

ABOUT THE BUSINESS
- Builds professional, mobile-friendly websites for all kinds of local and small businesses. Trades and home services (plumbers, electricians, roofers, HVAC, landscapers, contractors) are where the business started, but it also serves salons, cleaning, auto, fitness, health and wellness, restaurants, professional services, churches and ministries, and any other business that serves customers.
- Every project starts with a FREE, no-obligation consultation (a 15–20 minute video or voice call by Facebook Messenger, Zoom or Google Meet; no phone calls for now) to plan the website the way the client wants. Visitors book it with the form on the website.
- Website: $250 one-time. Paid 50% to start and 50% when the website is ready. All payments are made through PayPal.
- The final 50% must be paid before Adam helps host and launch the website, or before the website files are transferred to the client.
- Typical delivery: 3–5 business days once we have the client's details, photos and logo. Every 2 add-ons add 1 business day (e.g. 2 add-ons: 4–6 business days).
- Included in the $250: up to 5 pages or sections, custom-designed homepage, mobile responsive design, services section, contact/enquiry form, click-to-call and WhatsApp (where applicable), basic SEO setup, Google-friendly structure, social media links, domain connection assistance, launch assistance, and FREE Google Business Profile setup.
- Optional add-ons: $150 each on their own, or $100 each when added to the $250 website (save $50 each): additional page or section, logo design, advanced contact/booking system, payment gateway setup (for subscription businesses), listings optimization (Yelp, Apple Maps + 2 more of the client's choice).
- Website Care: optional $49/month. Includes website hosting (no separate hosting bill), website health monitoring, minor text/image/content updates, security and maintenance checks, social media update monitoring where supported, and ongoing support.
- Hosting is NOT included in the $250 website. It is included only with the Website Care plan ($49/month); otherwise the client pays their hosting provider directly (Adam helps set it up at launch).
- Urgent fixes without Website Care: $29 per hour.
- Rush delivery: reduces the delivery time by 2 business days (e.g. 3–5 business days becomes 1–3) for an extra 20% of the one-time project total (website plus add-ons). Website Care is not affected by the rush fee.
- The client provides their services, contact details, service area, and any photos or logo. Copywriting is not offered.
- Portfolio includes a real client website, Called to Go (calledtogoministry.org), and demo websites for plumbing, roofing, electrical and landscaping businesses.

HOW TO ANSWER
- Be friendly, clear and brief: usually 1–3 short sentences, plain English, no jargon.
- Only use the facts above. If you don't know something (for example a detail that isn't listed, or a custom quote), say so honestly and suggest booking the free consultation where Adam can answer it.
- Never invent prices, discounts, guarantees, timelines, reviews or features.
- You are an automated assistant. If asked, say so; never claim to be a human.
- When someone seems interested, invite them to book the free consultation using the form on the page.
- If someone is rude or abusive, politely ask them to keep the chat respectful and return to questions about their website.
- Politely decline requests unrelated to websites or this business, and steer back to how Ace Digital Solutions can help.
- Do not use headings or long lists. Use **bold** sparingly for prices.`;

// ALLOWED_ORIGIN can list several addresses separated by commas, e.g.
// https://acesite.netlify.app, https://yourdomain.com, https://www.yourdomain.com
function originOk(origin, allowed) {
  if (allowed === "*") return true;
  return allowed.split(",").map(a => a.trim().replace(/\/+$/, "")).filter(Boolean).includes(origin);
}

function cors(origin, allowed) {
  const ok = originOk(origin, allowed);
  return {
    "Access-Control-Allow-Origin": ok ? (allowed === "*" ? "*" : origin) : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

// Ask whichever AI is configured. Returns { reply } or { error, status, detail }.
async function callAI(env, messages) {
  let res, provider;
  try {
    if (env.GEMINI_API_KEY) {
      // Google Gemini (free tier available)
      provider = "gemini";
      const model = (env.GEMINI_MODEL || GEMINI_MODEL).trim();
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY.trim(), "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: 1500, temperature: 0.4 }, // extra room because Gemini may "think" before answering
        }),
      });
      if (res.ok) {
        const out = await res.json();
        const reply = (out.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
        return reply ? { reply } : { error: "Empty reply", detail: JSON.stringify(out).slice(0, 400) };
      }
    } else if (env.OPENAI_API_KEY) {
      // ChatGPT (OpenAI Chat Completions API)
      provider = "openai";
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: env.OPENAI_MODEL || OPENAI_MODEL, max_tokens: MAX_TOKENS, temperature: 0.4,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages] }),
      });
      if (res.ok) {
        const out = await res.json();
        const reply = (out.choices?.[0]?.message?.content || "").trim();
        return reply ? { reply } : { error: "Empty reply" };
      }
    } else if (env.ANTHROPIC_API_KEY) {
      // Claude (Anthropic Messages API)
      provider = "claude";
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY.trim(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages }),
      });
      if (res.ok) {
        const out = await res.json();
        const reply = (out.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
        return reply ? { reply } : { error: "Empty reply" };
      }
    } else {
      return { error: "No AI key set. Add GEMINI_API_KEY in the Worker's Settings → Variables and Secrets." };
    }
    return { error: `AI service error (${provider})`, status: res.status, detail: (await res.text()).slice(0, 400) };
  } catch (e) {
    return { error: "Could not reach AI service", detail: String(e).slice(0, 200) };
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "*";
    const headers = cors(origin, allowed);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    // Health check: open the Worker address in a browser to test the AI connection.
    if (request.method === "GET") {
      const test = await callAI(env, [{ role: "user", content: "Say hello in one short sentence." }]);
      const report = {
        worker: "Ace Digital Solutions chat server is running",
        ai: env.GEMINI_API_KEY ? "Gemini (" + (env.GEMINI_MODEL || GEMINI_MODEL) + ")" : env.OPENAI_API_KEY ? "ChatGPT" : env.ANTHROPIC_API_KEY ? "Claude" : "NONE - no key set",
        allowed_websites: allowed === "*" ? "any (testing mode)" : allowed.split(",").map(a => a.trim()),
        ai_test: test.reply ? "OK: " + test.reply : test,
      };
      return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
    }

    if (request.method !== "POST") return json({ error: "Use POST" }, 405, headers);
    if (!originOk(origin, allowed)) return json({ error: "Not allowed", origin }, 403, headers);
    if (new URL(request.url).pathname.replace(/\/+$/, "").endsWith("/enquiry")) return handleEnquiry(request, env, headers);

    let data;
    try { data = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400, headers); }

    // Clean the conversation: only user/assistant text, trimmed, alternating, starting with the user.
    const raw = Array.isArray(data.messages) ? data.messages.slice(-MAX_TURNS) : [];
    const messages = [];
    for (const m of raw) {
      if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") continue;
      const content = m.content.trim().slice(0, MAX_CHARS);
      if (!content) continue;
      if (messages.length && messages[messages.length - 1].role === m.role) messages[messages.length - 1].content += "\n" + content;
      else messages.push({ role: m.role, content });
    }
    while (messages.length && messages[0].role !== "user") messages.shift();
    if (!messages.length || messages[messages.length - 1].role !== "user") return json({ error: "No question received" }, 400, headers);

    const result = await callAI(env, messages);
    if (result.reply) return json({ reply: result.reply }, 200, headers);
    console.log("AI error:", JSON.stringify(result)); // visible in the Worker's Logs tab
    return json(result, 502, headers);
  },
};

// ------------------------------------------------------------------
// Consultation form
// ------------------------------------------------------------------
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clip = (s, n = 500) => String(s ?? "").trim().slice(0, n);

async function sendEmail(env, msg) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(msg),
  });
  if (!res.ok) throw new Error("Email failed: " + res.status + " " + (await res.text()).slice(0, 200));
}

async function handleEnquiry(request, env, headers) {
  if (!env.RESEND_API_KEY || !env.OWNER_EMAIL || !env.FROM_EMAIL) return json({ error: "Server is missing email settings" }, 500, headers);
  let d;
  try { d = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400, headers); }

  // Spam trap: real visitors never fill this hidden field
  if (d.company_website) return json({ ok: true }, 200, headers);

  const v = {
    name: clip(d.name, 100), business: clip(d.business, 120), email: clip(d.email, 160), phone: clip(d.phone, 40),
    type: clip(d.type, 60), website: clip(d.website, 200), how: clip(d.how, 60), othertime: clip(d.othertime, 200),
    message: clip(d.message, 2000), total: clip(d.total, 20), base: !!d.base, rush: !!d.rush, care: !!d.care,
    addons: (Array.isArray(d.addons) ? d.addons : []).map(a => clip(a, 80)).slice(0, 12),
    slots: (Array.isArray(d.slots) ? d.slots : []).map(s => clip(s, 160)).slice(0, 3),
  };
  if (!v.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return json({ error: "Please fill in your name and a valid email." }, 400, headers);

  const rows = [
    ["Name", v.name], ["Business", v.business || "—"], ["Email", v.email], ["Phone", v.phone || "—"],
    ["Type of business", v.type], ["Current website", v.website || "—"],
    ["Preferred times", v.slots.length ? v.slots.join("<br>") : "—"], ["Other time suggested", v.othertime || "—"], ["Talk by", v.how],
    ["Base plan website ($250)", v.base ? "Yes" : "No"], ["Add-ons", v.addons.length ? v.addons.join(", ") : "None"],
    ["Rush delivery (+20%)", v.rush ? "Yes" : "No"], ["Website Care ($49/month)", v.care ? "Yes" : "No"],
    ["Estimated total", v.total || "—"], ["Message", (v.message || "—").replace(/\n/g, "<br>")],
  ];
  const table = rows.map(([k, val]) => `<tr><td style="padding:6px 12px 6px 0;color:#64748B;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;color:#0F172A">${k === "Preferred times" || k === "Message" ? val.split("<br>").map(esc).join("<br>") : esc(val)}</td></tr>`).join("");

  const ownerHtml = `<div style="font-family:Arial,sans-serif;font-size:14px"><h2 style="margin:0 0 12px;color:#0B1220">New consultation request</h2><table style="border-collapse:collapse">${table}</table><p style="color:#64748B">Reply to this email to answer ${esc(v.name)} directly.</p></div>`;

  const first = esc(v.name.split(" ")[0]);
  const custHtml = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#0F172A;max-width:560px">
    <div style="background:#0B1220;color:#fff;padding:18px 22px;border-radius:10px 10px 0 0"><b style="font-size:18px">ACE</b> <span style="font-size:11px;letter-spacing:2px">DIGITAL SOLUTIONS</span></div>
    <div style="border:1px solid #E3E8F1;border-top:0;padding:22px;border-radius:0 0 10px 10px">
      <p>Hi ${first},</p>
      <p>Thanks for booking a <b>free consultation</b> with Ace Digital Solutions. We've received your request${v.business ? ` for <b>${esc(v.business)}</b>` : ""}.</p>
      <p><b>What happens next</b><br>We'll email you shortly to confirm one of the times you picked${v.slots.length ? ":" : "."}</p>
      ${v.slots.length ? `<ul style="margin:0 0 12px;padding-left:20px">${v.slots.map(s => `<li>${esc(s.split("  =  ")[0].split("   (typed")[0])}</li>`).join("")}</ul>` : ""}
      <p>The consultation is a 15–20 minute call by ${esc(v.how || "video call")}, where we plan your website the way you'd like it.</p>
      ${v.total ? `<p>Your estimate: <b>${esc(v.total)}</b> (final pricing is confirmed at the consultation).</p>` : ""}
      <p style="background:#ECFDF3;border:1px solid #A7F3C4;border-radius:8px;padding:12px 14px"><b>No payment is needed now.</b> The 50% deposit is only paid after your consultation, if you decide to go ahead. All payments are made securely through PayPal.</p>
      <p>If you have any questions, just reply to this email.</p>
      <p>Thanks,<br>Adam<br>Ace Digital Solutions</p>
    </div></div>`;

  try {
    await sendEmail(env, { from: env.FROM_EMAIL, to: [env.OWNER_EMAIL], reply_to: v.email, subject: `Consultation request: ${v.business || v.name}`, html: ownerHtml });
    await sendEmail(env, { from: env.FROM_EMAIL, to: [v.email], reply_to: env.OWNER_EMAIL, subject: "Your free consultation request – Ace Digital Solutions", html: custHtml });
    return json({ ok: true }, 200, headers);
  } catch (e) {
    return json({ error: "Could not send email right now" }, 502, headers);
  }
}
