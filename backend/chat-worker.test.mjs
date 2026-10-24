import worker from "./chat-worker.js";
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
let aiCalls = 0;
globalThis.fetch = async (u) => { aiCalls++; return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello!" }] } }] }), { status: 200 }); };
const store = new Map(); const kv = { get: async k => store.get(k) ?? null, put: async (k, v) => store.set(k, v) };
const env = { GEMINI_API_KEY: "k", CHAT_KV: kv, CHAT_DAILY_CAP: "15" };
const O = "https://acedigitalsolutionsbiz.org";
const req = (path, body, { origin = O, ip = "1.1.1.1", method = "POST" } = {}) => new Request("https://ace-chat.x" + path, { method, headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": ip }, body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined });
const chat = { lang: "en", messages: [{ role: "user", content: "How much is a website?" }] };

let r = await worker.fetch(req("/", null, { method: "GET" }), env); ok(r.status === 200 && (await r.text()) === "OK" && aiCalls === 0, "GET health check says OK without calling the AI");
r = await worker.fetch(new Request("https://ace-chat.x/?key=secret"), { ...env, HEALTH_KEY: "secret" }); ok(r.status === 200 && aiCalls >= 1 && (await r.text()).includes("ai_test"), "GET with the right HEALTH_KEY tests the AI");
r = await worker.fetch(new Request("https://ace-chat.x/?key=wrong"), { ...env, HEALTH_KEY: "secret" }); ok((await r.text()) === "OK", "wrong HEALTH_KEY gets plain OK");
r = await worker.fetch(req("/chat", chat), env); const j = await r.json(); ok(r.status === 200 && j.reply === "Hello!", "chat works from the real website");
r = await worker.fetch(req("/chat", chat, { origin: "https://evil.example" }), env); ok(r.status === 403, "other websites are refused (default allow-list)");
r = await worker.fetch(req("/enquiry", { name: "x", email: "a@b.co" }), env); ok(r.status === 404, "old /enquiry route is gone");
r = await worker.fetch(req("/notify", { name: "x" }), env); ok(r.status === 404, "old /notify route is gone");
r = await worker.fetch(req("/chat", "x".repeat(40000)), env); ok(r.status === 413, "oversized request refused");
// per-visitor limit (fallback limiter: >10 per minute)
let codes = []; for (let i = 0; i < 12; i++) codes.push((await worker.fetch(req("/chat", chat, { ip: "2.2.2.2" }), env)).status);
ok(codes.slice(0, 9).every(c => c === 200) && codes.at(-1) === 429, "per-visitor limit kicks in (" + codes.join(",") + ")");
// daily cap (15 set)
codes = []; for (let i = 0; i < 6; i++) codes.push((await worker.fetch(req("/chat", chat, { ip: "3.3.3." + i }), env)).status);
ok(codes.includes(429), "daily cap kicks in (" + codes.join(",") + ")");
ok(![...store.keys()].some(k => /\d+\.\d+\.\d+\.\d+/.test(k)), "no raw IP in the counter store");
// errors are generic
globalThis.fetch = async () => new Response("quota exceeded detail", { status: 400 });
r = await worker.fetch(req("/chat", chat, { ip: "9.9.9.9" }), { GEMINI_API_KEY: "k" }); const e = await r.json();
ok(r.status === 502 && e.error === "unavailable" && !e.detail && !e.tried, "AI errors don't leak details to the browser");
