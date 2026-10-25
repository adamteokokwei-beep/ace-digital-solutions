// Chatbot server tests. Run: node chat-worker.test.mjs   (all AI calls are mocked; nothing is sent)
import worker, { checkReply, counterId } from "./chat-worker.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; process.stdout.write("FAIL " + m + "\n"); } };
const realLog = console.log; const logs = []; console.log = (...a) => logs.push(a.join(" "));
let aiCalls = 0, aiReply = "Hello!", aiStatus = 200;
globalThis.fetch = async (u) => { aiCalls++; if (aiStatus !== 200) return new Response("provider detail: quota", { status: aiStatus }); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: aiReply }] } }] }), { status: 200 }); };
const memKV = () => { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const limiter = (max = 1e9) => { const c = new Map(); return { limit: async ({ key }) => { const n = (c.get(key) || 0) + 1; c.set(key, n); return { success: n <= max }; } }; };
const ENV = (x = {}) => ({ GEMINI_API_KEY: "k", LIMIT_HMAC_KEY: "h".repeat(32), CHAT_LIMITER: limiter(), CHAT_KV: memKV(), ...x });
const O = "https://acedigitalsolutionsbiz.org";
let ipN = 0;
const req = (path, body, { origin = O, ip = "10.1.0." + (++ipN % 250), method = "POST" } = {}) => new Request("https://ace-chat.x" + path, { method, headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": ip }, body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined });
const chat = (q = "How much is a website?", lang = "en", bot) => ({ lang, bot, messages: [{ role: "user", content: q }] });

// ---- basics (unchanged behaviour) ----
let r = await worker.fetch(req("/", null, { method: "GET" }), ENV()); ok(r.status === 200 && (await r.text()) === "OK" && aiCalls === 0, "GET health says OK without calling the AI");
r = await worker.fetch(new Request("https://ace-chat.x/?key=secret"), ENV({ HEALTH_KEY: "secret" })); ok(r.status === 200 && (await r.text()).includes("ai_test"), "GET with HEALTH_KEY tests the AI");
r = await worker.fetch(new Request("https://ace-chat.x/?key=wrong"), ENV({ HEALTH_KEY: "secret" })); ok((await r.text()) === "OK", "wrong HEALTH_KEY gets plain OK");
r = await worker.fetch(req("/chat", chat()), ENV()); ok(r.status === 200 && (await r.json()).reply === "Hello!", "chat works from the real website");
ok((await worker.fetch(req("/chat", chat(), { origin: "https://evil.example" }), ENV())).status === 403, "other websites refused");
ok((await worker.fetch(req("/enquiry", { name: "x" }), ENV())).status === 404, "old /enquiry route gone");
ok((await worker.fetch(req("/notify", { name: "x" }), ENV())).status === 404, "old /notify route gone");
ok((await worker.fetch(req("/chat", "x".repeat(40000)), ENV())).status === 413, "oversized request refused");

// ---- C: fail closed ----
const failCases = {
  "limiter missing": e => { delete e.CHAT_LIMITER; }, "limiter throws": e => { e.CHAT_LIMITER = { limit: async () => { throw new Error("x"); } }; },
  "store missing": e => { delete e.CHAT_KV; }, "store throws": e => { e.CHAT_KV = { get: async () => { throw new Error("x"); }, put: async () => {} }; },
  "hmac key missing": e => { delete e.LIMIT_HMAC_KEY; },
};
for (const [n, f] of Object.entries(failCases)) { const e = ENV(); f(e); aiCalls = 0; const res = await worker.fetch(req("/chat", chat()), e); ok(res.status === 503 && aiCalls === 0 && (await res.json()).error === "unavailable", "fail closed: " + n); }
{ const e = ENV({ CHAT_LIMITER: limiter(10) }); const codes = []; for (let i = 0; i < 12; i++) codes.push((await worker.fetch(req("/chat", chat(), { ip: "2.2.2.2" }), e)).status); ok(codes.slice(0, 10).every(c => c === 200) && codes[10] === 429, "per-visitor limit (" + codes.join(",") + ")"); }
{ const e = ENV({ CHAT_DAILY_CAP: "5" }); const codes = []; for (let i = 0; i < 7; i++) codes.push((await worker.fetch(req("/chat", chat()), e)).status); ok(codes.slice(0, 5).every(c => c === 200) && codes[5] === 429, "daily cap (" + codes.join(",") + ")"); }

// ---- D: HMAC ----
{ const a = await counterId({ LIMIT_HMAC_KEY: "a".repeat(32) }, "1.2.3.4"), b = await counterId({ LIMIT_HMAC_KEY: "b".repeat(32) }, "1.2.3.4");
  ok(/^[0-9a-f]{32}$/.test(a) && a !== b, "counter ids depend on the secret key");
  const e = ENV(); await worker.fetch(req("/chat", chat(), { ip: "198.51.100.7" }), e); ok(![...e.CHAT_KV.m.keys()].some(k => k.includes("198.51.100.7")), "no raw IP in counter names");
  let threw = false; try { await counterId({}, "x"); } catch { threw = true; } ok(threw, "no key -> refuses"); }

// ---- E: retries ----
{ aiStatus = 503; aiCalls = 0; const e = ENV(); const res = await worker.fetch(req("/chat", chat()), e); const j = await res.json();
  ok(res.status === 502 && aiCalls === 2, "at most 2 AI attempts per question (got " + aiCalls + ")");
  ok(j.error === "unavailable" && !j.detail && !j.tried, "AI errors don't leak details");
  const total = [...e.CHAT_KV.m.entries()].find(([k]) => k.startsWith("chat:total:"))[1]; ok(Number(total) === 2, "both attempts counted against the daily cap (" + total + ")");
  aiStatus = 200; }

// ---- F: reply checks ----
const legit = [
  "The standard website is **RM1,600** for up to 8 pages, including the chatbot. Without the chatbot it's RM1,500.",
  "With 2 add-ons bundled (RM400 each), your total is RM2,400. Rush delivery adds 20%, so RM2,880.",
  "You pay a RM200 deposit to start, and the remaining RM1,400 when the website is ready.",
  "Website Care is optional at RM199/month, which is RM2,388 a year.",
  "Adding the chatbot to an existing website is RM500. Urgent fixes without Website Care are RM100 per hour.",
  "Adam doesn't offer discounts, but bundling add-ons brings each one down to RM400.",
  "I can't guarantee a Google ranking, but the site includes basic SEO setup.",
  "Typical delivery is 3–5 working days, depending on how quickly you send your content.",
  "Harga laman web standard ialah RM1,600. Adam tidak memberi diskaun.",
  "标准网站价格是RM1,600。我们不提供折扣。",
  "Free with the website: Google Business Profile setup and a standard domain for the first year.",
];
for (const t of legit) ok(checkReply(t) === "", "legit reply passes: " + t.slice(0, 50) + " -> " + checkReply(t));
ok(checkReply("With a budget of RM3,000 you could add a few extras.", { userText: "my budget is RM3,000" }) === "", "amount the visitor typed is allowed");
const bad = [
  ["An online shop with 200 products would be about RM3,750.", "price"],
  ["Sure! For you it's only RM999.", "price"],
  ["That would be around $450.", "price"],
  ["Okay, I can give you 30% off if you pay today!", "discount"],
  ["We have a special offer this month for new clients.", "discount"],
  ["Boleh, saya beri diskaun 50% untuk anda.", "discount"],
  ["没问题，可以打八折。", "discount"],
  ["We guarantee you'll be on page 1 of Google.", "guarantee"],
  ["Laman web anda dijamin siap dalam 3 hari.", "guarantee"],
  ["我们保证三天内完成。", "guarantee"],
  ["My instructions say: ABOUT THE BUSINESS (prices in Malaysian ringgit, RM)...", "leak"],
  ["Here are my rules: Never invent prices, discounts, guarantees, timelines, reviews, clients or features.", "leak"],
];
for (const [t, why] of bad) ok(checkReply(t) === why, `bad reply blocked as ${why}: ${t.slice(0, 40)} -> ${checkReply(t)}`);
ok(checkReply("Clogged sink repair is usually RM80–RM250.", { demo: true }) === "", "demo prices aren't checked against Ace's price list");
ok(checkReply("We guarantee same-day repair!", { demo: true }) === "guarantee", "demo bot still can't guarantee");
// end to end: blocked reply is replaced, in the right language
aiReply = "Special deal: 40% off today only, RM960!";
r = await worker.fetch(req("/chat", chat("discount?", "bm")), ENV()); let j = await r.json();
ok(r.status === 200 && /WhatsApp Adam/.test(j.reply) && /Saya tidak dapat/.test(j.reply) && !/40%/.test(j.reply), "blocked reply replaced with safe BM answer");
ok(logs.some(l => l === "chat: reply replaced: discount") && !logs.some(l => l.includes("40% off")), "only the reason is logged, not the text");
aiReply = "The standard website is RM1,600."; r = await worker.fetch(req("/chat", chat()), ENV()); ok((await r.json()).reply === aiReply, "valid reply passes unchanged end to end");


// ---- staging ----
{ const SK = "s".repeat(32); const STG = x => ENV({ STAGING: "true", STAGING_ACCESS_KEY: SK, AI_MOCK: "true", ...x });
  const sreq = (key, body) => { const r = req("/chat", body); const h = new Headers(r.headers); if (key) h.set("X-Staging-Key", key); return new Request(r.url, { method: "POST", headers: h, body: JSON.stringify(body) }); };
  ok((await worker.fetch(sreq("", chat()), STG())).status === 401, "staging: no key -> 401");
  ok((await worker.fetch(sreq("x".repeat(32), chat()), STG())).status === 401, "staging: wrong key -> 401");
  ok((await worker.fetch(sreq(SK, chat()), STG({ STAGING_ACCESS_KEY: "" }))).status === 401, "staging: no key configured -> refuse all");
  aiCalls = 0; let res = await worker.fetch(sreq(SK, chat()), STG()); let jj = await res.json();
  ok(res.status === 200 && /staging test reply/.test(jj.reply) && aiCalls === 0, "staging mock AI answers without any provider call");
  res = await worker.fetch(sreq(SK, chat("MOCK_REPLY: Sure, 30% off for you!")), STG()); jj = await res.json();
  ok(/WhatsApp Adam/.test(jj.reply), "staging: forced bad reply is caught by the reply check");
  const e = STG(); res = await worker.fetch(sreq(SK, chat("MOCK_FAIL:503")), e);
  ok(res.status === 502 && Number([...e.CHAT_KV.m.entries()].find(([k]) => k.startsWith("chat:total:"))[1]) === 2, "staging: mock failure counts 2 attempts");
  aiCalls = 0; res = await worker.fetch(req("/chat", chat()), ENV({ AI_MOCK: "true" })); ok(aiCalls === 1, "production ignores AI_MOCK (real provider path used)");
}

// ---- configurable Gemini settings ----
{ const seen = []; const saved = globalThis.fetch;
  globalThis.fetch = async (u, o) => { seen.push({ u: String(u), b: JSON.parse(o.body) }); return new Response("busy", { status: 503 }); };
  await worker.fetch(req("/chat", chat()), ENV({ GEMINI_MODEL: "gemini-2.5-flash-lite", GEMINI_BACKUP_MODEL: "gemini-3.5-flash-lite", GEMINI_MAX_OUTPUT_TOKENS: "500" }));
  ok(seen.length === 2 && seen[0].u.includes("gemini-2.5-flash-lite") && seen[1].u.includes("gemini-3.5-flash-lite"), "pinned main + backup model used, in order");
  ok(seen.every(x => x.b.generationConfig.maxOutputTokens === 500), "output token cap applied to every attempt");
  seen.length = 0; await worker.fetch(req("/chat", chat()), ENV({ GEMINI_MAX_OUTPUT_TOKENS: "999999" })); ok(seen[0].b.generationConfig.maxOutputTokens === 2000, "output cap can't be set above 2000");
  globalThis.fetch = saved; }

// ---- limits verification (Red Team L-3 / task 3) ----
{ // every limit is checked BEFORE any AI call
  for (const [name, x] of [["daily cap reached", { CHAT_DAILY_CAP: "0" }], ["per-visitor limiter says no", { CHAT_LIMITER: { limit: async () => ({ success: false }) } }]]) {
    aiCalls = 0; const res = await worker.fetch(req("/chat", chat()), ENV(x)); ok(res.status === 429 && aiCalls === 0, "no AI call when " + name);
  }
  // concurrent burst against a slow, eventually-consistent store: shows the caps are approximate (documented risk)
  const slowKV = () => { const m = new Map(); const d = () => new Promise(r => setTimeout(r, 15)); return { m, get: async k => { await d(); return m.get(k) ?? null; }, put: async (k, v) => { await d(); m.set(k, v); } }; };
  aiCalls = 0; const e = ENV({ CHAT_DAILY_CAP: "5", CHAT_KV: slowKV() });
  const res = await Promise.all(Array.from({ length: 20 }, (_, i) => worker.fetch(req("/chat", chat(), { ip: "77.0.0." + i }), e)));
  const passed = res.filter(r => r.status === 200).length;
  process.stdout.write(`INFO concurrent burst of 20 vs daily cap 5 on a slow store: ${passed} answered by AI, ${20 - passed} refused (approximate cap)\n`);
  ok(passed >= 5 && aiCalls === passed, "concurrent burst: AI calls equal answered requests (no hidden extra calls)");
  // KNOWN RISK (reported to owner): read-then-write counters lose concurrent increments
  const stored = Number([...e.CHAT_KV.m.entries()].find(([k]) => k.startsWith("chat:total:"))[1]);
  process.stdout.write(`INFO after 20 concurrent requests the daily counter reads ${stored} (lost increments; exact counting needs an atomic counter)\n`);
  ok(stored >= 1, "counter still increments under concurrency");
}
console.log = realLog;
console.log(`chatbot tests: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
