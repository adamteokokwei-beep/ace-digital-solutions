// STAGING ONLY - serves the staging copy of the website behind a password (HTTP Basic Auth, user "redteam"),
// adds noindex, and gives the page the staging access key so its form and chat can reach the staging servers.
// Secrets: STAGING_SITE_PASSWORD, STAGING_ACCESS_KEY. If either is missing, everything is refused.
const same = (a, b) => { a = String(a); b = String(b); if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
export default {
  async fetch(request, env) {
    const pw = String(env.STAGING_SITE_PASSWORD || ""), key = String(env.STAGING_ACCESS_KEY || "");
    if (pw.length < 12 || key.length < 16) return new Response("Staging is not configured.", { status: 503 });
    const auth = request.headers.get("Authorization") || "";
    let ok = false;
    if (auth.startsWith("Basic ")) { try { const [u, p] = atob(auth.slice(6)).split(":"); ok = same(u, "redteam") & same(p, pw); } catch {} }
    if (!ok) return new Response("Staging: login required.", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="ace-staging", charset="UTF-8"', "Cache-Control": "no-store" } });
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers); h.set("X-Robots-Tag", "noindex, nofollow"); h.set("Cache-Control", "no-store");
    if (!(h.get("Content-Type") || "").includes("text/html")) return new Response(res.body, { status: res.status, headers: h });
    return new HTMLRewriter()
      .on("head", { element(e) { e.prepend(`<script>window.__STG_KEY__=${JSON.stringify(key)};</script><meta name="robots" content="noindex,nofollow">`, { html: true }); } })
      .on("body", { element(e) { e.append(`<div style="position:fixed;left:8px;bottom:8px;z-index:99999;background:#B45309;color:#fff;font:600 12px/1 system-ui;padding:6px 9px;border-radius:6px;pointer-events:none">STAGING · test only</div>`, { html: true }); } })
      .transform(new Response(res.body, { status: res.status, headers: h }));
  },
};
