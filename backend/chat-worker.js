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
//   CHAT_DAILY_CAP     (Text, optional) total AI attempts per day, default 400
//   LIMIT_HMAC_KEY     (Secret, REQUIRED) random key for the counter names (openssl rand -hex 32). Without it the AI is switched off.
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
const MAX_AI_ATTEMPTS = 2;                 // main model + one backup, never more
const AI_TIMEOUT_MS = 6000;                // per attempt (so at most about 12 s per question)

// ---------- abuse protection (fails CLOSED) ----------
// If the rate limiter, the counter store or the HMAC key is missing or failing, the AI is not called:
// the server answers 503 and the website shows its built-in (scripted) answers instead.
const hmacKeys = new Map();
// Secret-keyed HMAC-SHA-256, so stored counter names can't be turned back into IP addresses
export async function counterId(env, s) {
  const secret = env.LIMIT_HMAC_KEY ? String(env.LIMIT_HMAC_KEY).trim() : "";
  if (!secret) throw new Error("no hmac key");
  let key = hmacKeys.get(secret);
  if (!key) { key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); hmacKeys.set(secret, key); }
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("chat:" + s));
  return [...new Uint8Array(sig)].slice(0, 16).map(b => b.toString(16).padStart(2, "0")).join("");
}
const totalKey = () => "chat:total:" + new Date().toISOString().slice(0, 10);
// Returns "" when allowed, otherwise "rate_limited", "daily_cap" or "unavailable". Counters hold no chat content and no raw IP address.
// KV is eventually consistent, so the hourly/daily caps are approximate (a burst can slightly exceed them).
async function limitCheck(env, ip) {
  if (!env.CHAT_LIMITER || typeof env.CHAT_LIMITER.limit !== "function") { console.log("chat: rate limiter not configured, AI off"); return "unavailable"; }
  try { const { success } = await env.CHAT_LIMITER.limit({ key: "chat:" + ip }); if (!success) return "rate_limited"; }
  catch { console.log("chat: rate limiter unavailable, AI off"); return "unavailable"; }
  const kv = env.CHAT_KV;
  if (!kv || typeof kv.get !== "function") { console.log("chat: counter store not configured, AI off"); return "unavailable"; }
  try {
    const cap = Number(env.CHAT_DAILY_CAP || CHAT_DAILY_CAP);
    const keys = [[totalKey(), cap, 90000, "daily_cap"], ["chat:ip:" + new Date().toISOString().slice(0, 13) + ":" + await counterId(env, ip), CHAT_IP_PER_HOUR, 4000, "rate_limited"]];
    const counts = await Promise.all(keys.map(([k]) => kv.get(k)));
    for (let i = 0; i < keys.length; i++) if (Number(counts[i] || 0) >= keys[i][1]) return keys[i][3];
    await Promise.all(keys.map(([k, , ttl], i) => kv.put(k, String(Number(counts[i] || 0) + 1), { expirationTtl: ttl })));
    return "";
  } catch { console.log("chat: counter store or key unavailable, AI off"); return "unavailable"; }
}
// Each extra model attempt also counts against the daily total (best effort, after the call)
async function countExtraAttempts(env, n) {
  if (!(n > 0) || !env.CHAT_KV) return;
  try { const k = totalKey(); const c = Number((await env.CHAT_KV.get(k)) || 0); await env.CHAT_KV.put(k, String(c + n), { expirationTtl: 90000 }); } catch { /* the next request will fail closed if the store is down */ }
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
    "Access-Control-Allow-Headers": "Content-Type, X-Staging-Key",
    "Vary": "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

// ---------- reply check (runs on every AI answer before it reaches the visitor) ----------
// Blocks: prices that aren't in the business facts (or a correct estimate built from them), discount offers,
// guarantees/promises, and replies that repeat the assistant's internal instructions.
// Valid prices and legitimate estimates pass. Amounts the visitor typed themselves (e.g. their budget) also pass.
const RM = n => Math.round(n);
function allowedAmounts() {
  const a = new Set([1600, 1500, 1400, 200, 500, 400, 199, 100]);
  const add = n => { a.add(RM(n)); a.add(RM(n * 1.2)); a.add(RM(n * 0.2)); a.add(RM(n - 200)); a.add(RM(n * 1.2 - 200)); };
  for (const base of [1500, 1600]) for (let k = 0; k <= 10; k++) add(base + 400 * k);   // website + bundled add-ons (+ rush, deposit/balance)
  for (let k = 1; k <= 10; k++) add(500 + 400 * (k - 1));                               // add-ons on an existing website
  for (let k = 1; k <= 12; k++) a.add(199 * k);                                          // Website Care months
  for (let h = 1; h <= 10; h++) a.add(100 * h);                                          // urgent fixes per hour
  return a;
}
const ALLOWED_RM = allowedAmounts();
const amountsIn = t => {
  const out = [];
  for (const m of String(t).matchAll(/(?:RM|MYR)\s?(\d[\d,]*(?:\.\d{1,2})?)\s?(k)?\b/gi)) { let n = Number(m[1].replace(/,/g, "")); if (m[2]) n *= 1000; out.push(n); }
  for (const m of String(t).matchAll(/(\d[\d,]*(?:\.\d{1,2})?)\s?(?:ringgit|令吉|马币|零吉)/gi)) out.push(Number(m[1].replace(/,/g, "")));
  return out.filter(n => Number.isFinite(n));
};
const NEG = /(no|not|never|don't|doesn't|does not|do not|can't|cannot|can not|unable|won't|isn't|aren't|without|tiada|tidak|tak|bukan|belum|tanpa|不|没有|无|沒有|无法|不能|不会)\s*\S*\s*\S*\s*$/i;
const hasUnnegated = (t, re) => { for (const m of t.matchAll(re)) { const before = t.slice(Math.max(0, m.index - 40), m.index); if (!NEG.test(before)) return true; } return false; };
const DISCOUNT = /\b\d{1,2}\s?%\s?(?:off|discount)|\bdiscount(?:s|ed)?\b|\bpromo(?:tion)?(?:al)? (?:price|code|rate)|\bspecial (?:price|offer|deal|rate)|\bdiskaun\b|\bpotongan harga\b|\bharga (?:istimewa|promosi)\b|折扣|打[一二三四五六七八九]折|[一二三四五六七八九]折|优惠价|减价|特价/gi;
const GUARANTEE = /\bguarantee[ds]?\b|\bwe promise\b|\bi promise\b|\b100% (?:sure|certain)\b|\bdijamin\b|\bjamin(?:an)?\b|保证|担保|承诺|包你/gi;
const LEAK_MARKERS = /ABOUT THE BUSINESS|HOW TO ANSWER|FACTS \(all demo|system ?prompt|systemInstruction|my (?:instructions|rules) (?:are|say)|I was (?:told|instructed) to|Only use the facts above|Never invent prices/i;
const shingles = (t, n = 7) => { const w = String(t).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean); const out = new Set(); for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" ")); return out; };
const ruleText = p => p.slice(p.indexOf("HOW TO ANSWER"));
let RULE_SHINGLES = null;
export function checkReply(reply, { userText = "", demo = false } = {}) {
  const t = String(reply || "");
  if (!RULE_SHINGLES) RULE_SHINGLES = new Set([...shingles(ruleText(SYSTEM_PROMPT)), ...shingles(ruleText(DEMO_PLUMBING_PROMPT))]);
  if (LEAK_MARKERS.test(t)) return "leak";
  for (const sh of shingles(t)) if (RULE_SHINGLES.has(sh)) return "leak";
  if (hasUnnegated(t, DISCOUNT)) return "discount";
  if (hasUnnegated(t, GUARANTEE)) return "guarantee";
  if (/(?:US\$|USD|S\$|SGD|\$\s?\d)/.test(t)) return "price";
  if (!demo) {
    const typed = new Set(amountsIn(userText).map(RM));
    for (const n of amountsIn(t)) if (!ALLOWED_RM.has(RM(n)) && !typed.has(RM(n))) return "price";
  }
  return "";
}
const SAFE_REPLY = {
  en: "I'm not able to confirm that here. For exact prices and details, please WhatsApp Adam at 010-264 1824. He confirms everything in a written quote.",
  bm: "Saya tidak dapat mengesahkan perkara itu di sini. Untuk harga dan butiran tepat, sila WhatsApp Adam di 010-264 1824. Semuanya disahkan dalam sebut harga bertulis.",
  zh: "这个我无法在这里确认。具体价格和细节，请WhatsApp联系Adam：010-264 1824。所有内容都以书面报价为准。",
};
const DEMO_SAFE_REPLY = {
  en: "I can't confirm that here. Please WhatsApp or call us and our team will confirm on site. (Demo website by Ace Digital Solutions.)",
  bm: "Saya tidak dapat mengesahkannya di sini. Sila WhatsApp atau hubungi kami dan pasukan kami akan sahkan di lokasi. (Laman demo oleh Ace Digital Solutions.)",
  zh: "这个我无法在这里确认。请WhatsApp或致电我们，师傅会在现场确认。（Ace Digital Solutions 的示范网站）",
};

// Ask whichever AI is configured. Returns { reply } or { error, status, detail }.
async function callAI(env, messages, system = SYSTEM_PROMPT) {
  if (isStaging(env) && String(env.AI_MOCK) === "true") return mockAI(messages);
  let res, provider;
  try {
    if (env.GEMINI_API_KEY) {
      // Google Gemini (free tier available)
      provider = "gemini";
      const first = (env.GEMINI_MODEL || GEMINI_MODEL).trim();
      const list = [first, ...GEMINI_BACKUPS.filter(m => m !== first)];
      // At most 2 attempts per question (main model, then one backup), each counted against the daily cap.
      const models = list.slice(0, MAX_AI_ATTEMPTS);
      const tried = [];
      for (const model of models) {
        try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          signal: AbortSignal.timeout(AI_TIMEOUT_MS), // give up on a slow model and try the backup
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
          if (reply) return { reply, model, attempts: tried.length + 1 };
          tried.push(model + ": empty reply");
          continue;
        }
        tried.push(model + ": " + res.status);
        // Busy (503), over the free limit (429), or model not found (404): try the next model.
        if (![503, 429, 404, 500].includes(res.status)) break;
      }
      return { error: "AI service error (gemini)", status: res ? res.status : 504, tried, attempts: tried.length, detail: res ? (await res.text().catch(() => "")).slice(0, 300) : "" };
    } else if (env.OPENAI_API_KEY) {
      // ChatGPT (OpenAI Chat Completions API)
      provider = "openai";
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", signal: AbortSignal.timeout(AI_TIMEOUT_MS * 2),
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
        method: "POST", signal: AbortSignal.timeout(AI_TIMEOUT_MS * 2),
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

// ---------- staging only ----------
// STAGING=true (set only in the staging environment) requires the X-Staging-Key header on every request,
// and allows AI_MOCK=true: canned replies instead of calling any AI provider (no cost, no provider data).
const isStaging = env => String(env.STAGING) === "true";
export function stagingKeyOk(request, env) {
  const want = String(env.STAGING_ACCESS_KEY || ""), got = String(request.headers.get("X-Staging-Key") || "");
  if (want.length < 16 || got.length !== want.length) return false;
  let diff = 0; for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
function mockAI(messages) {
  const last = String(messages[messages.length - 1]?.content || "");
  const fail = last.match(/^MOCK_FAIL:(\d{3})/); if (fail) return { error: "mock provider error", status: Number(fail[1]), attempts: MAX_AI_ATTEMPTS };
  const forced = last.match(/^MOCK_REPLY:([\s\S]*)$/); if (forced) return { reply: forced[1].trim(), model: "mock", attempts: 1 };
  return { reply: "This is a staging test reply. The standard website is RM1,600.", model: "mock", attempts: 1 };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || DEFAULT_ORIGINS).trim();
    const headers = cors(origin, allowed);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (isStaging(env) && !stagingKeyOk(request, env)) return json({ error: "staging: access key required" }, 401, headers);

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
    if (limited === "unavailable") return json({ error: "unavailable" }, 503, { ...headers, "Retry-After": "60" });
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
      await countExtraAttempts(env, (result.attempts || 1) - 1);
      if (result.reply) {
        const why = checkReply(result.reply, { userText: convo + " " + est, demo });
        if (why) { console.log("chat: summary withheld:", why); return json({ error: "unavailable" }, 502, headers); }
        return json({ summary: result.reply.replace(/\*\*/g, "").trim().slice(0, 700), model: result.model, ms: Date.now() - started }, 200, headers);
      }
      console.log("Summary error:", JSON.stringify(result));
      return json({ error: "unavailable" }, 502, headers); // details stay in the server logs
    }
    const langNote = lang ? `\n\nThe visitor has chosen ${({ en: "English", bm: "Bahasa Melayu", zh: "Simplified Chinese" })[lang]} for this chat; reply in that language unless they clearly write in another one.` : "";
    const system = (demo ? DEMO_PLUMBING_PROMPT : SYSTEM_PROMPT) + langNote;
    const result = await callAI(env, messages, system);
    await countExtraAttempts(env, (result.attempts || 1) - 1);
    if (result.reply) {
      const userText = messages.filter(m => m.role === "user").map(m => m.content).join(" ");
      const why = checkReply(result.reply, { userText, demo });
      if (why) {
        console.log("chat: reply replaced:", why); // reason only, never the chat text
        return json({ reply: (demo ? DEMO_SAFE_REPLY : SAFE_REPLY)[lang || "en"], model: result.model, ms: Date.now() - started }, 200, headers);
      }
      return json({ reply: result.reply, model: result.model, ms: Date.now() - started }, 200, headers);
    }
    console.log("AI error:", JSON.stringify(result)); // visible in the Worker's Logs tab
    return json({ error: "unavailable" }, 502, headers); // details stay in the server logs
  },
};
