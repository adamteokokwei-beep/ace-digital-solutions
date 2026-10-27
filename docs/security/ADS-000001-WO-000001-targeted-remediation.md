# ADS-000001-WO-000001 — Targeted release remediation

Project: ADS-000001 — Ace Digital Solutions. Date: 2026-10-26.
Scope: form Worker only; no chatbot dependency. No production deployment, secret replacement or production test performed in this remediation.

## Candidate and changes

Branch: `security/form-launch-2026-10-25`; base commit `80afb03fb2b74f522ca549a6424b5331513a76b0`. Candidate consists of the uncommitted remediation patch and new production entry point; base commit alone is NOT the candidate.

Production entry point forces STAGING=false and WHATSAPP_DRY_RUN=false. CAPTCHA_OPTIONAL is ignored throughout the shared Worker. Missing Turnstile secret, public test secrets in production, missing or malformed tokens, failed Siteverify, incorrect hostname/action all refuse delivery. Missing limiter, counter binding or sufficiently long HMAC secret also refuses delivery. Release configs use the production entry point, replace inherited plaintext variables (`keep_vars=false`), and declare required secrets. Existing encrypted bindings must be reviewed for name collisions before any authorized release; a build is not proof of deployed credentials.

I-4 previously had atomic caps but isolate-local deduplication after reservation: caps bounded volume but did not prevent cross-instance duplicates or repeated quota charges. The smallest implemented change adds the submission ledger to the EXISTING daily Durable Object transaction. A new stable ID reserves counters and a pending HMAC payload claim atomically. Identical in-flight requests cannot send again; completed repeats receive fixed acknowledgement metadata without another quota charge. An ID with different normalized payload returns conflict. Failed/ambiguous delivery and settlement failure stay locked rather than automatically resending. Content, tokens, provider message IDs and raw submission IDs are not persisted in the ledger.

## Focused checks

| Control | Result | Evidence / limit |
|---|---|---|
| Inherited CAPTCHA_OPTIONAL / staging flags cannot bypass production verification | PASS | R1/R2 and production entry inspection; public test secret refused even with inherited development flags |
| Missing Turnstile / HMAC / limiter / usage store fails closed | PASS | Existing and targeted mocked-provider regressions |
| Strict token type, hostname and provider failure handling | PASS | Existing focused security tests rerun |
| Atomic caps under concurrency | PASS | Native workerd + SQLite: 20 simultaneous unique claims, cap 5, exactly 5 reserved |
| Cross-instance claim state / duplicate quota protection | PASS | Durable shared ledger; native 20 same-ID claims yield 1 reservation and 19 in-progress; completed repeat and payload conflict verified |
| Failed delivery retry lock | PASS | Native uncertain state and Worker provider-failure tests |
| Ledger privacy | PASS | Targeted test checks no raw visitor text, token, raw ID or provider ID stored |
| Unit/adversarial suite | PASS | 53 tests; all mocked upstream requests, no actual delivery |
| Form-only production bundle | PASS | Wrangler 4.152.0 dry-run only, no upload |
| Independent focused Red Team retest | PASS | Separate reviewer independently reran 53 unit tests, native SQLite checks and two extra inherited-flag/settlement-outage regressions; no source blocker found |
| Exact candidate + intended live credentials + WhatsApp receipt | NOT TESTED | Required WhatsApp token exists only as unreadable encrypted production secret. No private replacement/copy available at time of report. Existing dry-run staging deliberately has no token. Earlier production receipt belongs to older code and cannot certify this candidate |
| Production deployment | NOT TESTED | Prohibited without explicit owner approval |

53 tests passed in the Node suite; native runtime checks passed separately. Source and bundle hashes are recorded in the evidence manifest. No claim that local mocks prove live token validity, Meta template approval, recipient delivery, or live-widget compatibility.

## Residual risks and launch decision

NO-GO pending exact-candidate live credential/delivery verification. Independent focused retest passed. Do not request production approval until mandatory checks pass.

- One delivery attempt per stable ID within a UTC day is the intended application protection, not exactly-once delivery. Fresh IDs, UTC day rollover and provider-side duplication remain outside this guarantee.
- A crash after reservation but before sending can suppress that enquiry for the rest of the UTC day. Ambiguous failures require manual follow-up; generating a new ID may duplicate a message already delivered. No automatic retry or stored content recovery is introduced.
- Repeats still consume Cloudflare rate-limiter/Siteverify requests and infrastructure operations, but do not consume another application daily/phone/IP reservation. Atomic delivery caps do not promise zero infrastructure quota cost.
- Same-ID content edits return conflict; browser reload creates a new ID. No global payload-based deduplication is claimed.
- Day-scoped ledger expires with the object's inactivity alarm (48 hours). Old pre-remediation deliveries have no ledger entry.
- An accepted Meta API response is not proof of arrival. A unique synthetic message must be observed in the owner's WhatsApp for the exact candidate using the approved sender, recipient, template and real Turnstile configuration in an isolated nonproduction test. Never copy delivery credentials into dry-run staging or weaken its credential rejection.

Official basis: [Cloudflare server-side Turnstile validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) requires server verification and documents single-use, five-minute tokens. [Cloudflare SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) documents atomic and isolated storage operations. Native runtime tests exercise the actual Durable Object implementation rather than treating mocked serialization as proof.
