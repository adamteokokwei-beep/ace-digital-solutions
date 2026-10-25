// STAGING ONLY - serves the staging copy of the website behind a password (HTTP Basic Auth, user "redteam"),
// adds noindex and security headers, and gives the page the staging access key so its form and chat can reach
// the staging servers. Secrets: STAGING_SITE_PASSWORD, STAGING_ACCESS_KEY. If either is missing, everything is refused.
import { CSP } from "./csp-policy.js";
const same = (a, b) => { a = String(a); b = String(b); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=15552000",
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store",
};
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // CSP violation reports (report-only phase). Browsers don't send the login with reports, so this route is open,
    // but it only logs the violated directive and the blocked host - never page content - and accepts at most 8 KB.
    if (url.pathname === "/__csp-report") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = (await request.text()).slice(0, 8192);
      try { const j = JSON.parse(body); const r = j["csp-report"] || j[0]?.body || j.body || {};
        const host = (() => { try { return new URL(r["blocked-uri"] || r.blockedURL || "").host || String(r["blocked-uri"] || r.blockedURL || "inline").slice(0, 20); } catch { return String(r["blocked-uri"] || r.blockedURL || "inline").slice(0, 20); } })();
        console.log("csp-report:", String(r["violated-directive"] || r.effectiveDirective || "?").slice(0, 40), host); } catch { console.log("csp-report: unreadable"); }
      return new Response(null, { status: 204 });
    }
    const pw = String(env.STAGING_SITE_PASSWORD || ""), key = String(env.STAGING_ACCESS_KEY || "");
    if (pw.length < 12 || key.length < 16) return new Response("Staging is not configured.", { status: 503 });
    const auth = request.headers.get("Authorization") || "";
    let ok = false;
    if (auth.startsWith("Basic ")) { try { const [u, p] = atob(auth.slice(6)).split(":"); ok = same(u, "redteam") && same(p, pw); } catch {} }
    if (!ok) return new Response("Staging: login required.", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="ace-staging", charset="UTF-8"', "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers); for (const [k, v] of Object.entries(SECURITY)) h.set(k, v);
    if (!(h.get("Content-Type") || "").includes("text/html")) return new Response(res.body, { status: res.status, headers: h });
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    h.delete("Content-Security-Policy");
    h.set("Content-Security-Policy-Report-Only", CSP.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`) + "; report-uri /__csp-report");
    return new HTMLRewriter()
      .on("head", { element(e) { e.prepend(`<script nonce="${nonce}">window.__STG_KEY__=${JSON.stringify(key)};</script><meta name="robots" content="noindex,nofollow">`, { html: true }); } })
      .on("body", { element(e) { e.append(`<div style="position:fixed;left:8px;bottom:8px;z-index:99999;background:#B45309;color:#fff;font:600 12px/1 system-ui;padding:6px 9px;border-radius:6px;pointer-events:none">STAGING · test only</div>`, { html: true }); } })
      .transform(new Response(res.body, { status: res.status, headers: h }));
  },
};
