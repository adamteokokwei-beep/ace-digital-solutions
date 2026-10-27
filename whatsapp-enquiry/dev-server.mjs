// Local test server: runs the same worker.js code on your computer.
// Usage:  node dev-server.mjs          then open http://localhost:8787
// Reads settings from a file called .env next to this file (copy .env.example to .env).
// No packages to install: needs Node.js 18 or newer.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./worker.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
const envFile = path.join(dir, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (!env.ALLOWED_ORIGIN) env.ALLOWED_ORIGIN = "http://localhost:8787,null";
const PORT = Number(process.env.PORT || 8787);

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // the test page
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(dir, "public", "index.html")));
  }
  // everything else goes to the worker
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 64 * 1024) break; chunks.push(c); }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  headers.set("CF-Connecting-IP", req.socket.remoteAddress || "local");
  const request = new Request(url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
  const out = await worker.fetch(request, env);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(PORT, () => {
  const mode = env.WHATSAPP_DRY_RUN === "true" ? "DRY RUN (nothing is sent to WhatsApp)" : env.WHATSAPP_ACCESS_TOKEN ? "LIVE (messages are sent through the WhatsApp Cloud API)" : "NOT CONFIGURED (fill in .env)";
  console.log(`WhatsApp enquiry test server: http://localhost:${PORT}   mode: ${mode}`);
});
