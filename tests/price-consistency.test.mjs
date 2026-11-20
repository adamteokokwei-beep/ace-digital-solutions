// Price consistency check: run `node tests/price-consistency.test.mjs` after `python3 src/build_site.py`.
// Fails if a retired price appears anywhere customers or the chatbot can see it, or if an approved
// starting price is missing from a page in any language. Update PRICES here when the owner approves a change.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = p => fs.readFileSync(path.join(root, p), "utf8");
const walk = d => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".html") ? [path.join(d, e.name)] : []);

// Approved package and add-on prices (owner price list, 20 Nov 2026).
const PACKAGE_PRICES = ["RM388", "RM888", "RM1,888", "RM5,888", "RM1,288", "RM128", "RM88", "RM188", "RM288", "RM488", "RM588", "RM688"];
// Retired ADS prices. Blog articles quote market ranges such as "RM500–RM1,500", so those pages are exempt.
const RETIRED = ["RM1,600", "RM1,500", "RM1,400", "RM3,888", "RM168", "RM468", "RM3,288", "RM5,288", "Website Care at RM128", "RM400 when bundled", "RM500 on its own", "Listings setup"];
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
  const cards = home.match(/<div class="pkg-grid">[\s\S]*?<p class="prices-note">/)?.[0] || "";
  for (const p of PACKAGE_PRICES) if (!cards.includes(p)) failures.push(`site/${lang}index.html: package cards missing ${p}`);
  const web = read(`site/${lang}websites/index.html`);
  for (const p of ["RM888", "RM88", "RM388", "RM588", "RM200", "RM49"]) if (!web.includes(p)) failures.push(`site/${lang}websites/index.html: missing ${p}`);
}
// US / global version: same figures in USD, PayPal, US delivery and payment services.
for (const f of ["site/us/index.html", "site/us/websites/index.html", "site/us/about/index.html"]) {
  const html = read(f), visible = html.replace(/<script[\s\S]*?<\/script>/g, "");
  if (/(?<![A-Z])RM\d/.test(html)) failures.push(`${f}: price still in RM`);
  for (const w of ["DuitNow", "Touch 'n Go", "Lalamove", "e-Invoice"]) if (visible.includes(w)) failures.push(`${f}: Malaysia-only wording "${w}"`);
}
const us = read("site/us/index.html");
for (const p of ["$388", "$888", "$1,888", "$5,888", "$1,288", "$128", "PayPal", "DoorDash"]) if (!us.includes(p)) failures.push(`site/us/index.html: missing ${p}`);
const worker = read("backend/chat-worker.js");
for (const old of RETIRED) if (worker.includes(old)) failures.push(`backend/chat-worker.js: retired price "${old}"`);
const src = read("src/index.src.html");
assert.match(src, /const BASE = 888,.*CARE = 88,/, "chat calculator constants must match RM888 website / RM88 upkeep");

if (failures.length) { console.error("Price inconsistencies:\n  " + failures.join("\n  ")); process.exit(1); }
console.log(`price consistency: ${pages.length} pages + chatbot checked, 0 problems`);
