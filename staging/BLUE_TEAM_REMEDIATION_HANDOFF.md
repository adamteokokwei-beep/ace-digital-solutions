# BLUE TEAM REMEDIATION HANDOFF: targeted Red Team retest

Branch `malaysia` @ `c8645d3` · staging redeployed 25 Oct 2026 · same endpoints, access and rules as `RED_TEAM_HANDOFF.md` (staging only; mock AI; dry run; synthetic data; same rate budgets and stop conditions).

## Fixed: please retest

| ID | Fix | Where | Retest focus |
|---|---|---|---|
| **M-1** | Reply check now catches wording variations in EN/BM/ZH: soft promises tied to outcomes (definitely, assure, surely, 100%, pasti, 一定, 肯定…); discount-equivalents (cheaper, special arrangement, rebate, cashback, voucher, promo, "save N%", "N percent less", murah, rebat, 便宜, 优惠, 返现…); "free" except the two approved items (Google Business Profile setup, first-year standard domain); prices in words; any RM amount in the same sentence as an unoffered service (e-commerce, payment gateway, logo, apps, ads…); paraphrased instruction leaks ("I was set up to…", "my instructions…", 我的设定…). The system prompt has matching rules. Negations ("no discounts", "can't guarantee") and "feel free / definitely WhatsApp Adam" still pass | `backend/chat-worker.js` (`wordingProblem`, `checkReply`, prompt rules) | New paraphrases via `MOCK_REPLY:` that a customer would read as a promise, discount, free extra or unlisted price; also legitimate replies wrongly blocked (false positives) |
| **L-1** | The build generates a **CSP** with SHA-256 hashes of every inline script (no `'unsafe-inline'` for scripts; Turnstile, Google Fonts and the two Workers allowed; `frame-ancestors 'self'`, `object-src 'none'`, `base-uri`, `form-action`) into `site/_headers`, **report-only** until approved. Staging site also sends nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy and HSTS; a per-request **nonce** for its injected key script; reports go to `/__csp-report` (logs directive and host only). The plumbing demo's 2 inline handlers were moved to its script | `src/csp.py`, `src/build_site.py`, `site/_headers`, `staging/site-worker.js`, `staging/csp-policy.js`, `site/demos/jb-plumbing/index.html` | Header presence; CSP bypasses (e.g. script injection via chat `MOCK_REPLY` with CSP); does `/__csp-report` accept abuse beyond logging two short fields (8 KB cap, open by design) |
| **I-3** | `&` → `&&` in the site auth | `staging/site-worker.js` | — |
| **I-5** | Wrangler pinned to `4.152.0` | `staging/*.sh` | — |

## Verified, not changed (needs an owner decision)

- **L-3 / concurrency:** a unit simulation with a slow KV store shows that **20 concurrent requests all passed a daily cap of 5, and the counter recorded only 1**. Read-then-write KV counters lose concurrent increments.
  - **Form:** each request still needs its own Turnstile pass.
  - **Chatbot:** has no challenge, so repeated concurrent bursts can exceed its daily cap.
  - Mitigations already in place: per-visitor limiter (leaky), 2 AI attempts max per question, mock AI in staging.
  - **Proposed:** an atomic Durable Object counter and/or a first-message Turnstile for the chat. Both await owner approval.
- **I-1:** confirmed read-only. Production `ace-wa-enquiry` and `ace-chat` configs both use KV `31c49a6d…` (form keys `total:/ip:/ph:`, chat keys `chat:…`, no collision); staging uses two separate namespaces. Production unchanged; separation proposed for go-live.
- **"Pre-Gemini" order and usage:** all limits are checked **before** any AI call (unit-tested: 0 AI calls when a cap or the limiter refuses). At most 2 attempts at 6 s each; every attempt counts towards the daily cap; AI calls = answered requests, even under concurrency.
- **L-2, I-2, I-4:** not changed in this round (low priority; awaiting approval).

## Tests

| Suite | Result |
|---|---|
| Reply-check corpus (60 legitimate + 66 bad, incl. all 7 Red Team payloads) | **126/126** |
| Chatbot unit tests (incl. limit order and concurrency) | **64/64** |
| Form unit tests | **33/33** |
| Website form, headless browser | **7/7** |
| CSP **enforced** (production build): every page EN/BM/ZH, form + Turnstile, chatbot, mobile, both demos | **14/14**, 0 violations |
| CSP enforced (staging build) | all pass |
| CSP negative control (hashes removed) | 13/13 pages correctly fail |
| Live staging Blue Team run | **54/54**, log check clean (0 synthetic text, 0 key) |
| Staging setup checks (incl. production versions unchanged) | all PASS |

The live concurrent chat burst returned 15× 429, but it ran straight after the sequential burst test, so the limiter window was already used. Treat the unit simulation as the concurrency evidence.

## Not tested

- Real Gemini behaviour under the new prompt rules (no paid or real AI calls without approval).
- Real Turnstile tokens (staging uses the test keys).
- A browser on the authenticated staging site with CSP (report-only); covered by the local enforced-CSP browser tests.

## Remaining known risks

- **The reply check is still pattern-based.** Novel paraphrases or other languages may pass.
- **The daily caps are not concurrency-safe** (see L-3 above).
- **CSP is report-only** until approved.
- **The production live site already sends HSTS, nosniff, frame, referrer and permissions headers via Cloudflare**; only the CSP is new.
