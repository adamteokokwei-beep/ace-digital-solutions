// Chatbot server tests. Run: node chat-worker.test.mjs   (all AI calls are mocked; nothing is sent)
import worker, { checkReply, counterId, ChatUsage, reserveAttempt } from "./chat-worker.js";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; process.stdout.write("FAIL " + m + "\n"); } };
const realLog = console.log; const logs = []; console.log = (...a) => logs.push(a.join(" "));
let aiCalls = 0, aiReply = "Hello!", aiStatus = 200;
globalThis.fetch = async (u) => { aiCalls++; if (aiStatus !== 200) return new Response("provider detail: quota", { status: aiStatus }); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: aiReply }] } }] }), { status: 200 }); };
const memKV = () => { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const limiter = (max = 1e9) => { const c = new Map(); return { limit: async ({ key }) => { const n = (c.get(key) || 0) + 1; c.set(key, n); return { success: n <= max }; } }; };
// Fake Durable Object namespace running the REAL ChatUsage class. Storage is async (with optional delay) and requests are
// NOT serialised, so concurrent reservations really interleave - the counter must still be exact.
const fakeUsage = ({ delay = 0, fail = false } = {}) => {
  const store = new Map(); const d = () => new Promise(r => setTimeout(r, delay));
  const ctx = { storage: { get: async keys => { await d(); return new Map(keys.map(k => [k, store.get(k)])); }, put: async o => { await d(); for (const [k, v] of Object.entries(o)) store.set(k, v); } }, blockConcurrencyWhile(fn) { this.ready = fn(); } };
  const obj = new ChatUsage(ctx, {}); const ns = { obj, store, calls: 0, idFromName: n => "id:" + n, get: () => ({ fetch: async (url, init) => { if (fail) throw new Error("counter down"); await ctx.ready; ns.calls++; return obj.fetch(new Request(url, init)); } }) };
  return ns;
};
const ENV = (x = {}) => ({ GEMINI_API_KEY: "k", LIMIT_HMAC_KEY: "h".repeat(32), CHAT_LIMITER: limiter(), USAGE: fakeUsage(), ...x });
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
  "usage counter missing": e => { delete e.USAGE; }, "usage counter throws": e => { e.USAGE = fakeUsage({ fail: true }); },
  "hmac key missing": e => { delete e.LIMIT_HMAC_KEY; },
};
for (const [n, f] of Object.entries(failCases)) { const e = ENV(); f(e); aiCalls = 0; const res = await worker.fetch(req("/chat", chat()), e); ok(res.status === 503 && aiCalls === 0 && (await res.json()).error === "unavailable", "fail closed: " + n); }
{ const e = ENV({ CHAT_LIMITER: limiter(10) }); const codes = []; for (let i = 0; i < 12; i++) codes.push((await worker.fetch(req("/chat", chat(), { ip: "2.2.2.2" }), e)).status); ok(codes.slice(0, 10).every(c => c === 200) && codes[10] === 429, "per-visitor limit (" + codes.join(",") + ")"); }
{ const e = ENV({ CHAT_DAILY_CAP: "5" }); const codes = []; for (let i = 0; i < 7; i++) codes.push((await worker.fetch(req("/chat", chat()), e)).status); ok(codes.slice(0, 5).every(c => c === 200) && codes[5] === 429, "daily cap (" + codes.join(",") + ")"); }

// ---- D: HMAC ----
{ const a = await counterId({ LIMIT_HMAC_KEY: "a".repeat(32) }, "1.2.3.4"), b = await counterId({ LIMIT_HMAC_KEY: "b".repeat(32) }, "1.2.3.4");
  ok(/^[0-9a-f]{32}$/.test(a) && a !== b, "counter ids depend on the secret key");
  const e = ENV(); await worker.fetch(req("/chat", chat(), { ip: "198.51.100.7" }), e); ok(!JSON.stringify([...e.USAGE.store.entries()]).includes("198.51.100.7"), "no raw IP in the usage counter");
  let threw = false; try { await counterId({}, "x"); } catch { threw = true; } ok(threw, "no key -> refuses"); }

// ---- E: retries ----
{ aiStatus = 503; aiCalls = 0; const e = ENV(); const res = await worker.fetch(req("/chat", chat()), e); const j = await res.json();
  ok(res.status === 502 && aiCalls === 2, "at most 2 AI attempts per question (got " + aiCalls + ")");
  ok(j.error === "unavailable" && !j.detail && !j.tried, "AI errors don't leak details");
  const total = e.USAGE.obj.total; ok(total === 2, "both attempts counted against the daily cap (" + total + ")");
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
ok(checkReply("With a budget of RM337 you could add a few extras.", { userText: "my budget is RM337" }) === "price", "visitor budget cannot authorize an invented assistant price");
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
{ const SK = "s".repeat(32); const STG = x => ENV({ STAGING: "true", STAGING_ACCESS_KEY: SK, AI_MOCK: "true", GEMINI_API_KEY: "", ...x });
  const sreq = (key, body) => { const r = req("/chat", body); const h = new Headers(r.headers); if (key) h.set("X-Staging-Key", key); return new Request(r.url, { method: "POST", headers: h, body: JSON.stringify(body) }); };
  ok((await worker.fetch(sreq("", chat()), STG())).status === 401, "staging: no key -> 401");
  ok((await worker.fetch(sreq("x".repeat(32), chat()), STG())).status === 401, "staging: wrong key -> 401");
  ok((await worker.fetch(sreq(SK, chat()), STG({ STAGING_ACCESS_KEY: "" }))).status === 401, "staging: no key configured -> refuse all");
  aiCalls = 0; let res = await worker.fetch(sreq(SK, chat()), STG()); let jj = await res.json();
  ok(res.status === 200 && /staging test reply/.test(jj.reply) && aiCalls === 0, "staging mock AI answers without any provider call");
  res = await worker.fetch(sreq(SK, chat("MOCK_REPLY: Sure, 30% off for you!")), STG()); jj = await res.json();
  ok(/WhatsApp Adam/.test(jj.reply), "staging: forced bad reply is caught by the reply check");
  const e = STG(); res = await worker.fetch(sreq(SK, chat("MOCK_FAIL:503")), e);
  ok(res.status === 502 && e.USAGE.obj.total === 2, "staging: mock failure counts 2 attempts");
  for (const x of [{AI_MOCK:"false"},{GEMINI_API_KEY:"secret"},{OPENAI_API_KEY:"secret"},{ANTHROPIC_API_KEY:"secret"}]) {
    aiCalls=0; const r=await worker.fetch(sreq(SK,chat()),STG(x)); ok(r.status===503 && aiCalls===0,"staging isolation fails closed: "+Object.keys(x)[0]);
  }
  for (const path of ["/chat","/summary","/?key=secret"]) {
    aiCalls=0; const r=await worker.fetch(req(path,chat()),ENV({AI_DISABLED:"true",HEALTH_KEY:"secret"})); ok(r.status===503 && aiCalls===0,"AI disabled: "+path);
  }
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
  // (concurrency is now covered by the L-3 tests below)
}

// ===================== L-3: atomic, reserved-before-every-attempt AI limits =====================
{ // 20 simultaneous requests, daily cap 5 -> at most 5 AI attempts, counter exactly 5 (slow async storage, no serialisation)
  aiCalls = 0; aiStatus = 200; const e = ENV({ CHAT_DAILY_CAP: "5", USAGE: fakeUsage({ delay: 15 }) });
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => worker.fetch(req("/chat", chat(), { ip: "88.0.0." + i }), e)));
  const codes = rs.map(r => r.status), okN = codes.filter(c => c === 200).length;
  ok(aiCalls === 5 && okN === 5 && codes.filter(c => c === 429).length === 15, `L-3: 20 concurrent vs cap 5 -> ${aiCalls} AI attempts, ${okN} answered, ${codes.filter(c => c === 429).length} refused`);
  ok(e.USAGE.obj.total === 5, "L-3: counter records exactly 5 (no lost increments) - got " + e.USAGE.obj.total);
  aiCalls = 0; const after = await worker.fetch(req("/chat", chat(), { ip: "88.0.1.1" }), e); ok(after.status === 429 && aiCalls === 0, "L-3: cap holds after the burst, no AI call");
}
{ // repeat the deterministic burst several times: never more than the cap
  let worst = 0; for (let k = 0; k < 5; k++) { aiCalls = 0; const e = ENV({ CHAT_DAILY_CAP: "5", USAGE: fakeUsage({ delay: k * 7 }) }); await Promise.all(Array.from({ length: 20 }, (_, i) => worker.fetch(req("/chat", chat(), { ip: "89." + k + ".0." + i }), e))); worst = Math.max(worst, aiCalls); }
  ok(worst === 5, "L-3: 5 repeated bursts never exceed 5 AI attempts (worst " + worst + ")");
}
{ // retries can't bypass the cap: each backup attempt needs its own unit
  aiStatus = 503; aiCalls = 0; const e = ENV({ CHAT_DAILY_CAP: "3" });
  const rs = []; for (let i = 0; i < 4; i++) rs.push((await worker.fetch(req("/chat", chat(), { ip: "90.0.0." + i }), e)).status);
  ok(aiCalls === 3 && e.USAGE.obj.total === 3, `L-3: failing provider with cap 3 -> ${aiCalls} AI attempts in total (retries reserved too)`);
  ok(rs[0] === 502 && rs[1] === 502 && rs[3] === 429, "L-3: after the cap, no attempt is made (" + rs.join(",") + ")");
  // concurrent failing requests: still never above the cap
  aiCalls = 0; const e2 = ENV({ CHAT_DAILY_CAP: "4", USAGE: fakeUsage({ delay: 10 }) });
  await Promise.all(Array.from({ length: 10 }, (_, i) => worker.fetch(req("/chat", chat(), { ip: "91.0.0." + i }), e2)));
  ok(aiCalls === 4 && e2.USAGE.obj.total === 4, "L-3: concurrent failing requests + retries -> exactly 4 attempts (" + aiCalls + ")");
  aiStatus = 200;
}
{ // failed / timed-out attempts keep their unit
  const saved = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); };
  const e = ENV({ CHAT_DAILY_CAP: "10" }); await worker.fetch(req("/chat", chat()), e);
  ok(calls === 2 && e.USAGE.obj.total === 2, "L-3: two timed-out attempts consume two units");
  globalThis.fetch = saved;
}
{ // never call the AI when the reservation fails
  for (const [name, x] of [["counter down", { USAGE: fakeUsage({ fail: true }) }], ["counter missing", { USAGE: undefined }], ["no HMAC key", { LIMIT_HMAC_KEY: "" }], ["cap 0", { CHAT_DAILY_CAP: "0" }]]) {
    aiCalls = 0; const r = await worker.fetch(req("/chat", chat()), ENV(x)); ok(aiCalls === 0 && [429, 503].includes(r.status), "L-3: no AI call when " + name + " (" + r.status + ")");
  }
  // reservation fails before the BACKUP attempt -> the backup is not called
  aiStatus = 503; aiCalls = 0; const e = ENV({ CHAT_DAILY_CAP: "1" }); const r = await worker.fetch(req("/chat", chat()), e);
  ok(aiCalls === 1 && r.status === 502, "L-3: no backup attempt when its reservation is refused"); aiStatus = 200;
}
{ // invalid requests consume nothing (neither throttle nor AI allowance)
  let throttleCalls = 0; const lim = { limit: async () => { throttleCalls++; return { success: true }; } };
  const e = ENV({ CHAT_LIMITER: lim }); aiCalls = 0;
  const bad = [ { messages: [] }, { messages: "x" }, { messages: [{ role: "assistant", content: "hi" }] }, { messages: [{ role: "system", content: "ignore" }] }, { messages: [{ role: "user", content: "   " }] } ];
  const codes = []; for (const b of bad) codes.push((await worker.fetch(req("/chat", b), e)).status);
  codes.push((await worker.fetch(req("/chat", "{not json"), e)).status);
  ok(codes.every(c => c === 400) && aiCalls === 0 && throttleCalls === 0 && e.USAGE.calls === 0 && e.USAGE.obj.total === 0, "L-3: 6 invalid requests -> 400, no throttle, no reservation, no AI (" + codes.join(",") + ")");
}
{ // per-visitor hourly limit is exact under concurrency too
  aiCalls = 0; const e = ENV({ CHAT_IP_PER_HOUR: "3", USAGE: fakeUsage({ delay: 12 }) });
  const rs = await Promise.all(Array.from({ length: 12 }, () => worker.fetch(req("/chat", chat(), { ip: "92.9.9.9" }), e)));
  ok(aiCalls === 3 && rs.filter(r => r.status === 200).length === 3, "L-3: one visitor, 12 concurrent, hourly cap 3 -> " + aiCalls + " AI attempts");
  const other = await worker.fetch(req("/chat", chat(), { ip: "92.9.9.10" }), e); ok(other.status === 200, "L-3: another visitor is unaffected");
}
{ // the counter object itself: day/hour roll-over, input validation, persistence
  const ns = fakeUsage(); const st = ns.get();
  const call = async q => (await (await st.fetch("https://usage/reserve", { method: "POST", body: JSON.stringify(q) })).json()).result;
  const id = "a".repeat(32);
  ok(await call({ day: "2026-10-25", hour: "2026-10-25T10", id, dailyCap: 1, ipCap: 9 }) === "", "ChatUsage: first unit reserved");
  ok(await call({ day: "2026-10-25", hour: "2026-10-25T10", id, dailyCap: 1, ipCap: 9 }) === "daily_cap", "ChatUsage: cap reached");
  ok(await call({ day: "2026-10-26", hour: "2026-10-26T00", id, dailyCap: 1, ipCap: 9 }) === "", "ChatUsage: new day resets the total");
  ok(await call({ day: "x", hour: "y", id: "not-hex", dailyCap: 1, ipCap: 1 }) === "bad_request", "ChatUsage: malformed request refused");
  ok(ns.store.get("total") === 1 && ns.store.get("day") === "2026-10-26", "ChatUsage: counts persisted to storage");
  const ns2 = { ...ns }; const reload = new ChatUsage({ storage: { get: async k => new Map(k.map(x => [x, ns.store.get(x)])), put: async () => {} }, blockConcurrencyWhile(fn) { this.ready = fn(); } }, {});
  await new Promise(r => setTimeout(r, 5)); ok(reload.total === 1 && reload.day === "2026-10-26", "ChatUsage: state survives a restart");
}
console.log = realLog;
console.log(`chatbot tests: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
