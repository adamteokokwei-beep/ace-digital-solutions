// Ace Digital Solutions — website backend (Cloudflare Worker)
// ----------------------------------------------------------------
// Two jobs, one small server:
//   POST /summary   → a short WhatsApp hand-over message summarising a website chat
//   POST /chat      → the website chatbot (Google Gemini — free tier, ChatGPT, or Claude). Keeps your API key out of the website code.
//   GET  /          → health check (plain "OK"; add ?key=HEALTH_KEY to also test the AI connection)
//   (The old /enquiry and /notify form routes were removed: the website form now uses the ace-wa-enquiry Worker.)
//
// Settings (Cloudflare dashboard → your Worker → Settings → Variables):
//   Chatbot — set ONE of these keys (if more than one is set, the first in this list is used):
//   GEMINI_API_KEY     (Secret)  free key from aistudio.google.com/apikey    (Google Gemini, free tier)
//   GEMINI_MODEL       (Text, optional) defaults to gemini-flash-latest
//   OPENAI_API_KEY     (Secret)  key from platform.openai.com/api-keys     (ChatGPT, paid)
//   OPENAI_MODEL       (Text, optional) defaults to gpt-4o-mini
//   ANTHROPIC_API_KEY  (Secret)  key from console.anthropic.com             (Claude, paid)
//   ALLOWED_ORIGIN     (Text)    your website address(es), comma-separated. If not set, only acedigitalsolutionsbiz.org (+ www) is allowed.
//   HEALTH_KEY         (Secret, optional) lets you test the AI connection: open https://<worker>/?key=<HEALTH_KEY>
//   CHAT_DAILY_CAP     (Text, optional) total AI requests per day, default 400
//   Bindings (wrangler.toml): CHAT_LIMITER (per-visitor rate limit), CHAT_KV (daily counters; hashed keys, no chat content)
//
// In the website file, set:
//   CHAT_API = "https://YOUR-WORKER.workers.dev/chat"

const GEMINI_MODEL = "gemini-flash-lite-latest";  // Google's current fast "Lite" model: quick and less often busy
// If that model is busy or unavailable, these are tried next, in order:
const GEMINI_BACKUPS = ["gemini-3.5-flash-lite", "gemini-flash-latest", "gemini-3.5-flash"];
const OPENAI_MODEL = "gpt-4o-mini";               // fast and low-cost; override with the OPENAI_MODEL setting
const CLAUDE_MODEL = "claude-haiku-4-5-20251001"; // used only if you choose Claude instead
const MAX_TOKENS = 400;                    // keeps answers short and costs low
const MAX_TURNS = 12;                      // how much of the conversation is sent each time
const MAX_CHARS = 800;                     // longest message a visitor can send
const MAX_BODY_BYTES = 32 * 1024;          // largest request accepted
const DEFAULT_ORIGINS = "https://acedigitalsolutionsbiz.org,https://www.acedigitalsolutionsbiz.org"; // used if ALLOWED_ORIGIN is not set
const CHAT_DAILY_CAP = 400;                // total AI requests per day (override with CHAT_DAILY_CAP); protects the free Gemini allowance
const CHAT_IP_PER_HOUR = 60;               // AI requests per visitor per hour (needs the CHAT_KV store)

// ---------- abuse protection ----------
const memHits = new Map(); // ip -> [timestamps] (fallback limiter, this Worker instance only)
async function hashKey(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("ace-chat:" + s));
  return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}
// Returns "" when allowed, otherwise "rate_limited" or "daily_cap". Counters hold no chat content and no raw IP address.
async function limitCheck(env, ip) {
  if (env.CHAT_LIMITER && typeof env.CHAT_LIMITER.limit === "function") {
    try { const { success } = await env.CHAT_LIMITER.limit({ key: "chat:" + ip }); if (!success) return "rate_limited"; } catch { /* fall back below */ }
  } else {
    const now = Date.now(), hits = (memHits.get(ip) || []).filter(t => now - t < 60000);
    hits.push(now); memHits.set(ip, hits); if (memHits.size > 5000) memHits.clear();
    if (hits.length > 10) return "rate_limited";
  }
  const kv = env.CHAT_KV;
  if (kv && typeof kv.get === "function") {
    const iso = new Date().toISOString(), cap = Number(env.CHAT_DAILY_CAP || CHAT_DAILY_CAP);
    const keys = [["chat:total:" + iso.slice(0, 10), cap, 90000, "daily_cap"], ["chat:ip:" + iso.slice(0, 13) + ":" + await hashKey(ip), CHAT_IP_PER_HOUR, 4000, "rate_limited"]];
    try {
      const counts = await Promise.all(keys.map(([k]) => kv.get(k)));
      for (let i = 0; i < keys.length; i++) if (Number(counts[i] || 0) >= keys[i][1]) return keys[i][3];
      await Promise.all(keys.map(([k, , ttl], i) => kv.put(k, String(Number(counts[i] || 0) + 1), { expirationTtl: ttl })));
    } catch { console.log("chat: limits store unavailable"); }
  }
  return "";
}

const SYSTEM_PROMPT = `You are the website assistant for Ace Digital Solutions, a web design service in Johor Bahru, Malaysia, run by Adam as a freelance web designer. You answer visitors' questions on the Ace Digital Solutions website.

ABOUT THE BUSINESS (prices in Malaysian ringgit, RM)
- Builds professional, mobile-friendly websites for businesses in Malaysia, for example renovation, aircond servicing, tuition centres, clinics, salons and workshops. Not every business needs a website: if a Facebook page and WhatsApp Business already bring in all the work a business can handle, Adam will say so honestly.
- Ace Digital Solutions is run by Adam as a freelancer. Do not claim it is a registered company and do not mention SSM registration.
- Social media: Facebook (Ace Digital Solutions), Instagram @acedigitalsolutionsbiz and YouTube @AceDigitalSolutionsBiz (short videos). Links are on the page.
- Contact: WhatsApp 010-264 1824 (the main way), or the contact form on the page, or email adamteokokwei@gmail.com. Adam replies within 1 working day.
- After contact: (1) WhatsApp Adam, reply within 1 working day; (2) a short chat by WhatsApp, Zoom or Google Meet, or in person only in Johor Bahru; (3) a written quote. RM200 deposit to start; the rest is paid when the website is ready, before launch (for the RM1,600 website: RM200 + RM1,400). There is no 50% deposit.
- Website: RM1,600 one-time for up to 8 pages or sections, in ONE language (English, Bahasa Melayu or Chinese), INCLUDING a website chatbot. Without the chatbot it is RM1,500. Always lead with RM1,600 as the standard package. Includes a custom-designed homepage, mobile-friendly layout, services section, WhatsApp and click-to-call buttons, contact/enquiry form, basic SEO setup and Google-friendly structure, social media links, domain and launch setup.
- FREE with the website: Google Business Profile setup, and a standard domain (.com, .com.my or .my) for the first year. Premium domains are quoted separately. From the second year the client pays the domain renewal themselves, unless they subscribe to Website Care.
- Typical delivery: 3–5 working days, depending on the project and how quickly the client sends their content (text, photos, logo). Each add-on adds 1 working day.
- Add-ons: RM500 each on their own, or RM400 each when bundled with the website or with another add-on. The add-ons are: 2 extra pages or sections (every 2 extra pages or sections counts as one add-on); additional language (the first language is included); enquiry & booking request form (customers choose a service and a preferred date and time); listings setup on Apple Maps and Foursquare (one add-on covering both).
- Rush delivery: 2 working days faster for an extra 20% of the project total (website plus add-ons). Example: 3–5 working days becomes 1–3.
- Website Care: optional RM199/month. Includes hosting, standard domain renewal, website health monitoring, minor text/image/content updates, security and maintenance checks, social media update monitoring where supported, and ongoing support. Without Website Care, the client pays a hosting provider directly (Adam helps set it up at launch).
- Urgent fixes without Website Care: RM100 per hour.
- Payment: DuitNow, Touch 'n Go eWallet or cash only. Payments go to Adam personally, because he works as a freelancer. No bank cards, no PayPal and no other methods.
- The client provides their services, contact details, areas covered, photos and logo. Adam can help tidy up the wording.
- Website chatbot: answers questions the business owner approves, on the business's website, in the chosen language, and passes the customer to the owner's WhatsApp with a short chat summary. Included in the RM1,600 website (the website is RM1,500 without it), or RM500 to add it to an existing website. It does NOT do voice calls.
- Adam does NOT sell chatbot or auto-reply setups for WhatsApp, Telegram, Facebook Messenger or Instagram. If asked, explain that WhatsApp Business and Facebook Messenger already have built-in automatic replies the owner can turn on themselves, and that Adam's chatbot is for websites.
- Logo design and payment gateway setup are not offered at the moment.
- Portfolio: a real client website, Called to Go (calledtogoministry.org), a ministry website for Adam's wife in Johor Bahru; and two interactive demos: a fictional Johor Bahru plumbing business (Arus Biru Plumbing) and a fictional tuition centre in Skudai (Cahaya Learning Centre). They are linked under My Work on the page.

HOW TO ANSWER
- Reply in the language the visitor writes in (English, Bahasa Melayu or Simplified Chinese). Malaysians often mix languages; reply naturally in the main language they used. If unsure, use the page language given below.
- Be friendly, clear and brief: usually 1–3 short sentences, plain language, no jargon. Use Malaysian/British spelling.
- Only use the facts above. If you don't know something (a detail that isn't listed, or a custom quote), say so honestly and suggest messaging Adam on WhatsApp at 010-264 1824.
- Never invent prices, discounts, guarantees, timelines, reviews, clients or features. Never offer discounts.
- You are an automated assistant. If asked, say so; never claim to be a human.
- When someone seems interested, invite them to WhatsApp Adam (they can also tap "Continue on WhatsApp with Adam" in this chat, which passes on a summary of the conversation).
- If someone is rude or abusive, politely ask them to keep the chat respectful and return to questions about their website.
- Politely decline requests unrelated to websites or this business.
- Do not use headings or long lists. Use **bold** sparingly for prices.`;

// ALLOWED_ORIGIN can list several addresses separated by commas, e.g.
// https://acesite.netlify.app, https://yourdomain.com, https://www.yourdomain.com
function originOk(origin, allowed) {
  if (allowed === "*") return true;
  return allowed.split(",").map(a => a.trim().replace(/\/+$/, "")).filter(Boolean).includes(origin);
}

// Prompt for the fictional "Arus Biru Plumbing" demo website (Ace's showroom demo, Johor Bahru).
const DEMO_PLUMBING_PROMPT = `You are the website chat assistant for Arus Biru Plumbing, a plumbing business in Johor Bahru, Malaysia. This is a FICTIONAL DEMO business shown by Ace Digital Solutions to business owners. Play the role naturally, but if anyone asks whether this is real, say it is a demo website made by Ace Digital Solutions, and that a real business's website could have this assistant too.

FACTS (all demo, prices in RM)
- Phone and WhatsApp: 07-000 0000 (demo number). 24-hour emergency service; regular hours Mon–Sat 8 a.m.–8 p.m.
- Service area: Johor Bahru, Skudai, Iskandar Puteri, Kulai, Pasir Gudang, Masai, Senai and Gelang Patah.
- Most calls in the JB area can get a same-day visit. Book on the page (3 steps: problem, time, name + phone + address), or WhatsApp.
- Typical price ranges (final price confirmed on site before work starts): clogged sink or drain RM80–RM250; water heater repair RM120–RM350 (new heater installed RM450–RM1,200); toilet repair RM80–RM250; leaking tap RM60–RM180; main pipe or sewer blockage RM200–RM600; hidden leak detection RM150–RM400; water pump repair RM150–RM450; burst or concealed pipe repair RM200–RM800; emergency call-out RM100–RM250.
- Price agreed before work starts. The plumber's name is sent by WhatsApp before arrival.
- Team (demo): Hafiz (service plumber), Ah Seng (water heaters and pumps), Ravi (drains and sewer).
- Payment by cash, bank transfer or DuitNow after the job.

HOW TO ANSWER
- Reply in the visitor's language (English or Bahasa Melayu; Chinese is fine too). Malaysians often mix languages; reply naturally. Friendly, calm, brief: 1–3 short sentences.
- For flooding or a burst pipe: tell them to turn off the main water valve (usually near the water meter), then call or WhatsApp. For a gas smell: leave the house, avoid switches and flames, and call 999 / the gas company.
- Never diagnose with certainty or promise exact prices; give the typical range and say the plumber confirms on site.
- Encourage booking on the page or tapping "Continue on WhatsApp". Never collect payment details. Only use the facts above; if unsure, suggest WhatsApp.
- Do not mention licences, certifications, ratings or review counts.
- No headings or long lists. Use **bold** sparingly.`;

// Short WhatsApp hand-over message, written as the customer, from the website chat.
function summaryPrompt(lang, owner) {
  const language = { bm: "Bahasa Melayu", zh: "Simplified Chinese", en: "English" }[lang] || "the language the customer mostly wrote in";
  return `You write a short WhatsApp message that a website visitor will send to ${owner}, summarising what they discussed with the website's chat assistant, so ${owner} doesn't need to ask again.
Rules:
- Write in the first person, as the customer ("I'd like...", "I asked about..."). Do NOT add a greeting or sign-off (a greeting is added separately).
- Write in ${language}. If the customer clearly wrote in another language, use the customer's language.
- Maximum 60 words. Plain text, no bullet symbols other than "- ", no bold, no emojis.
- Include only what the customer actually asked or said (needs, location, timing, budget) and the estimate they saw, if one is given. Never invent details, names or numbers.
- If the customer asked nothing specific, write one short sentence saying they'd like to know more.
- Output only the message text.`;
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
async function callAI(env, messages, system = SYSTEM_PROMPT) {
  let res, provider;
  try {
    if (env.GEMINI_API_KEY) {
      // Google Gemini (free tier available)
      provider = "gemini";
      const first = (env.GEMINI_MODEL || GEMINI_MODEL).trim();
      const list = [first, ...GEMINI_BACKUPS.filter(m => m !== first)];
      // If every model is busy, wait a moment and try the first two again.
      const models = [...list, "__wait", ...list.slice(0, 2)];
      const tried = [];
      for (const model of models) {
        if (model === "__wait") { await new Promise(r => setTimeout(r, 1200)); continue; }
        try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          signal: AbortSignal.timeout(8000), // give up on a slow model after 8 seconds and try the next
          headers: { "x-goog-api-key": env.GEMINI_API_KEY.trim(), "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
            generationConfig: { maxOutputTokens: 1500, temperature: 0.4 }, // extra room because Gemini may "think" before answering
          }),
        });
        } catch (e) { tried.push(model + ": timed out"); res = null; continue; }
        if (res.ok) {
          const out = await res.json();
          const reply = (out.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
          if (reply) return { reply, model };
          tried.push(model + ": empty reply");
          continue;
        }
        tried.push(model + ": " + res.status);
        // Busy (503), over the free limit (429), or model not found (404): try the next model.
        if (![503, 429, 404, 500].includes(res.status)) break;
      }
      return { error: "AI service error (gemini)", status: res ? res.status : 504, tried, detail: res ? (await res.text().catch(() => "")).slice(0, 300) : "" };
    } else if (env.OPENAI_API_KEY) {
      // ChatGPT (OpenAI Chat Completions API)
      provider = "openai";
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: env.OPENAI_MODEL || OPENAI_MODEL, max_tokens: MAX_TOKENS, temperature: 0.4,
          messages: [{ role: "system", content: system }, ...messages] }),
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
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: MAX_TOKENS, system, messages }),
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
    const allowed = (env.ALLOWED_ORIGIN || DEFAULT_ORIGINS).trim();
    const headers = cors(origin, allowed);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    // Health check. Plain "OK" for everyone; the AI connection is only tested with ?key=<HEALTH_KEY> (so bots can't use up the AI allowance).
    if (request.method === "GET") {
      const key = new URL(request.url).searchParams.get("key") || "";
      if (!env.HEALTH_KEY || key !== String(env.HEALTH_KEY).trim()) return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
      const test = await callAI(env, [{ role: "user", content: "Say hello in one short sentence." }]);
      let runningIn = "unknown";
      try { runningIn = ((await (await fetch("https://cloudflare.com/cdn-cgi/trace")).text()).match(/colo=(\w+)/) || [])[1] || "unknown"; } catch {}
      const report = {
        worker: "Ace Digital Solutions chat server is running",
        running_in: runningIn + " (Cloudflare data centre; pinned to a US region so Gemini accepts the requests)",
        ai: env.GEMINI_API_KEY ? "Gemini (" + (env.GEMINI_MODEL || GEMINI_MODEL) + ")" : env.OPENAI_API_KEY ? "ChatGPT" : env.ANTHROPIC_API_KEY ? "Claude" : "NONE - no key set",
        allowed_websites: allowed === "*" ? "any (testing mode)" : allowed.split(",").map(a => a.trim()),
        ai_test: test.reply ? "OK (" + (test.model || "") + "): " + test.reply : test,
      };
      return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
    }

    if (request.method !== "POST") return json({ error: "Use POST" }, 405, headers);
    if (!originOk(origin, allowed)) return json({ error: "Not allowed" }, 403, headers);
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    const isSummary = path.endsWith("/summary");
    if (!isSummary && !path.endsWith("/chat")) return json({ error: "Not found" }, 404, headers);

    // size limit before reading the body
    if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY_BYTES) return json({ error: "Too large" }, 413, headers);
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) return json({ error: "Too large" }, 413, headers);
    let data;
    try { data = JSON.parse(rawBody); } catch { return json({ error: "Invalid JSON" }, 400, headers); }
    if (!data || typeof data !== "object") return json({ error: "Invalid JSON" }, 400, headers);

    // abuse protection: per-visitor limit and a daily total, so nobody can use up the AI allowance
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    const limited = await limitCheck(env, ip);
    if (limited) { console.log("chat: limit reached:", limited); return json({ error: "busy" }, 429, { ...headers, "Retry-After": "60" }); }

    // Clean the conversation: only user/assistant text, trimmed, alternating, starting with the user.
    const raw = Array.isArray(data.messages) ? data.messages.slice(isSummary ? -30 : -MAX_TURNS) : [];
    const messages = [];
    for (const m of raw) {
      if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") continue;
      const content = m.content.trim().slice(0, MAX_CHARS);
      if (!content) continue;
      if (messages.length && messages[messages.length - 1].role === m.role) messages[messages.length - 1].content += "\n" + content;
      else messages.push({ role: m.role, content });
    }
    while (messages.length && messages[0].role !== "user") messages.shift();
    if (!messages.length || (!isSummary && messages[messages.length - 1].role !== "user")) return json({ error: "No question received" }, 400, headers);

    const started = Date.now();
    const demo = data.bot === "jb-demo" || data.bot === "capitol-demo";
    const lang = ["en", "bm", "zh"].includes(data.lang) ? data.lang : "";
    if (isSummary) {
      // Turn the chat into one user message for the summary writer
      const est = typeof data.estimate === "string" ? data.estimate.trim().slice(0, 300) : "";
      const convo = messages.map(m => (m.role === "user" ? "Customer: " : "Assistant: ") + m.content).join("\n").slice(-6000);
      const result = await callAI(env, [{ role: "user", content: "Chat:\n" + convo + (est ? "\n\nEstimate the customer saw: " + est : "") }],
        summaryPrompt(lang, demo ? "the business owner" : "Adam"));
      if (result.reply) return json({ summary: result.reply.replace(/\*\*/g, "").trim().slice(0, 700), model: result.model, ms: Date.now() - started }, 200, headers);
      console.log("Summary error:", JSON.stringify(result));
      return json({ error: "unavailable" }, 502, headers); // details stay in the server logs
    }
    const langNote = lang ? `\n\nThe visitor has chosen ${({ en: "English", bm: "Bahasa Melayu", zh: "Simplified Chinese" })[lang]} for this chat; reply in that language unless they clearly write in another one.` : "";
    const system = (demo ? DEMO_PLUMBING_PROMPT : SYSTEM_PROMPT) + langNote;
    const result = await callAI(env, messages, system);
    if (result.reply) return json({ reply: result.reply, model: result.model, ms: Date.now() - started }, 200, headers);
    console.log("AI error:", JSON.stringify(result)); // visible in the Worker's Logs tab
    return json({ error: "unavailable" }, 502, headers); // details stay in the server logs
  },
};
