# ADS-000001-WO-000001 — recovered historical findings

Original: `/Users/adm/Downloads/Ace Staging Red Team.md`
Title: **Independent Red Team Assessment / Ace Digital Solutions — Staging Security Review**
Audited branch: `malaysia` @ `f91f577`; dated 25 October 2026.
SHA-256: `efd837712501d28aaf0903dc6a4357ad1343a0bcf30f60a5e84e74956074ca9a`.

## I-2 — Informational

**Turnstile type-confusion passes in staging (test secret).** Original evidence: `captcha: {}` returned `200 dry_run` with Cloudflare's always-pass test secret. A missing/empty token was refused. The original assessment said this was not a production bypass and recommended optional real-secret verification.

Current assessment: strict token typing already fixes the object/array case, including under the dummy secret. A dedicated real staging widget now rejects object, blank and dummy-token submissions live. A real browser-generated token succeeded. No form-launch blocker remains from I-2.

## I-4 — Informational

**Duplicate detection is per-instance; duplicates still consume quota.** Original evidence: identical submission IDs sent 21 seconds apart both returned dry-run without `duplicate:true`; counters increment before the per-isolate deduplication check.

Current assessment: reproduced deterministically in the real handler. Same-isolate duplicate → one delivery but two reserved units. Resetting the isolate cache permits another delivery; the atomic per-phone cap stops the next attempt. This can cause duplicate notifications or use up a legitimate visitor's allowance. It does not bypass the new atomic caps, expose enquiry contents, or depend on the chatbot. It remains a bounded reliability limitation, not a critical security blocker. Exactly-once delivery is not promised. Durable idempotency is a separate follow-up if that guarantee is needed.

No original finding description was guessed. The earlier report's “missing evidence” entries are superseded by this recovered source.
