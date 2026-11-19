// Price consistency check: run `node tests/price-consistency.test.mjs` after `python3 src/build_site.py`.
// Fails if a retired price appears anywhere customers or the chatbot can see it, or if an approved
// starting price is missing from a page in any language. Update PRICES here when the owner approves a change.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = p => fs.readFileSync(path.join(root, p), "utf8");
const walk = d => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".html") ? [path.join(d, e.name)] : []);

// Approved starting prices (owner decisions, 20 Nov 2026).
const PRICES = ["RM388", "RM888", "RM1,288", "RM1,888", "RM2,888", "RM288", "RM88"];
// Retired ADS prices. Blog articles quote market ranges such as "RM500–RM1,500", so those pages are exempt.
const RETIRED = ["RM1,600", "RM1,500", "RM1,400", "RM3,888", "RM168", "RM468", "RM3,288", "RM5,288", "RM5,888", "Website Care at RM128"];
const isArticle = f => f.includes(`${path.sep}articles${path.sep}`);

const pages = walk("site");
const failures = [];
for (const f of pages) {
  const html = read(f).replace(/<script type="text\/plain" class="blog-post"[\s\S]*?<\/script>/g, "");
  if (isArticle(f)) continue;
  for (const old of RETIRED) if (html.includes(old)) failures.push(`${f}: retired price "${old}"`);
}
for (const lang of ["", "bm/", "zh/"]) {
  const home = read(`site/${lang}index.html`);
  const table = home.match(/<table class="price-table">[\s\S]*?<\/table>/)?.[0] || "";
  for (const p of PRICES.filter(p => p !== "RM88")) if (!table.includes(p)) failures.push(`site/${lang}index.html: starting-price table missing ${p}`);
  const web = read(`site/${lang}websites/index.html`);
  for (const p of ["RM888", "RM400", "RM88", "RM200", "RM49"]) if (!web.includes(p)) failures.push(`site/${lang}websites/index.html: missing ${p}`);
}
const worker = read("backend/chat-worker.js").replace(/  restaurant_one_time: \{.*\n/, "");  // ponytail: one-time POS prices await an owner decision
for (const old of RETIRED) if (worker.includes(old)) failures.push(`backend/chat-worker.js: retired price "${old}"`);
const src = read("src/index.src.html");
assert.match(src, /const BASE = 888,.*CARE = 88,/, "chat calculator constants must match RM888 website / RM88 upkeep");

if (failures.length) { console.error("Price inconsistencies:\n  " + failures.join("\n  ")); process.exit(1); }
console.log(`price consistency: ${pages.length} pages + chatbot checked, 0 problems`);
