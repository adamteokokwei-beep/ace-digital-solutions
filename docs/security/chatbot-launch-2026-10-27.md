# Chatbot launch — 27 October 2026

Status: ENABLED on the live EN, BM and Simplified Chinese website. This is a scoped release with bounded security tests, not a comprehensive security certification or a guarantee that AI never makes mistakes.

## Published behavior
- Chat: gemini-3.1-flash-lite first; one gemini-3.5-flash-lite backup on busy/quota/server failures, missing model, timeout or empty reply. Both models are listed with free-tier text pricing. No billing upgrade, new provider account or provider-key replacement.
- At most two attempts per chat, each reserved against the shared durable counters. Ten-second timeout per attempt, 600 output-token cap, 100 attempts per UTC day, 20 per visitor per UTC hour, approximate 10 requests per minute. These are request/token limits, not a monetary spending cap.
- If providers or limits refuse the request, the website uses its existing scripted answers.
- WhatsApp handovers quote the visitor's own words rather than AI-rewriting them. This removes the observed Skudai-to-Singapore summary failure and avoids summary-provider calls. Assistant messages are excluded; source links are omitted from the excerpt. The visitor previews/edits the WhatsApp message before choosing to send it.
- Chat notice identifies Google Gemini, possible errors and free-tier data use, in EN/BM/ZH. Privacy notice was corrected to match disabled form-email delivery and form-counter retention.
- All temporary private routes and credentials removed. API keys remain encrypted; no credentials appear in this report or source archive.

## Validation
- 91 existing backend checks, 8 security regressions, 126 reply-check corpus cases passed. Native SQLite counter concurrency and restart persistence were previously verified; this release did not change that counter implementation.
- 14 enforced-CSP browser checks, 9 form outcomes, and 6 new chat browser scenarios passed. New scenarios cover all three languages, mobile outage fallback, HTML escaping, CSP, disclosure and WhatsApp preview.
- Final private checks: exact-wording handovers in EN/BM/ZH preserved locations and nonpayment status; live provider replies refused fake payment URLs, invented guarantees/payment confirmation and instruction/key disclosure. Chinese price reply gave RM1,600/RM1,500 correctly. In that request the primary timed out and the real backup returned the correct answer in about 10.7 seconds, verifying actual failover.
- Earlier Chinese test requests had a UTF-8 escaping problem in the test harness. It was corrected and the final Chinese handover, price and injection tests used intact UTF-8 text. Prior malformed-transport checks are not the final acceptance evidence.
- Published EN/BM/ZH and www pages have the enabled chat URL, unchanged production form endpoint and enforced CSP. Real browser Chinese AI reply observed after publication.
- Production enquiry Worker remains version 5d3473b2-e8d1-4bac-b83f-2682c2b0e308. Its previously confirmed phone-delivery test remains valid; no WhatsApp secret was changed during chatbot work.

## Versions and source
- Chat active after temporary-secret cleanup: a92af570-1be9-419b-971f-ee2c89174ddf.
- Website: f3f8c0df-7924-45bb-802e-29b917bb6aec.
- Rollback metadata and final configuration: work/chatbot-release/.
- Source synchronized into the existing security checkout (backend, src, site and tests). No broad merge or push was performed. The independent SEO candidate is still unpublished. Future main-branch builds must incorporate this reviewed source before overwriting this direct Cloudflare release.

Official free-tier model pricing: https://ai.google.dev/gemini-api/docs/pricing
