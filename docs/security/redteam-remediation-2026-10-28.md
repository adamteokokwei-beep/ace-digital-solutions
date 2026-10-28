# Independent red-team findings: remediation — 28 October 2026

Status: prepared and locally validated; not merged or deployed. Base main: 1ee61414ce08e17111e00ff99f4fde87b96f25fc. Schema PR #3 is separate.

## Changes

- M-A: removed visitor-supplied amount exemptions. Added a contextual base-website-price guard: the report's RM300 example also overlaps a legitimate hourly-support total and needs a contextual check. Automated transcript turns are labelled “not a quote”, content lines are prefixed `>`, and the transcript ends with the written-quote reminder. Full conversations remain included as requested.
- L-A: direct WhatsApp links have a conservative 1,800-character budget after percent-encoding. Longer transcripts are preserved fully in a local readonly text field with clipboard and UTF-8 text-file export, plus a short WhatsApp link. No chat truncation, server upload or automatic external navigation. Clipboard refusal selects the entire transcript and explains manual copy/download. Reset, new messages and language changes invalidate old exports.
- L-B: blocked the report's English/Chinese rule paraphrases and “knock … off” discount phrasing. Pattern checks remain bounded safeguards; they cannot prove all model replies correct.
- L-C: declared all ten production settings as required encrypted secrets; corrected README guidance and deployment notes. Names-only authenticated Cloudflare API inspection confirmed all ten names exist on ace-wa-enquiry; no values were read or changed. Form Worker runtime and recipient are unchanged.

## Validation

- Chat worker: 91 passing cases; reply corpus: 126 passing cases; security regressions: 9 passing tests including the reported price and wording examples.
- Form worker and focused red-team suite: 53 passing tests, upstreams mocked.
- Browser chat: six language/outage scenarios with enforced CSP. Long Chinese/emoji transcripts, >40-message history, clipboard success/refusal, byte-for-byte text download, direct short links, reset, HTML escaping and no horizontal overflow checked.
- Enforced-CSP suite: all 14 checks pass, including forms, Turnstile mocks, chatbot and demos. SEO suite passes for 15 crawlable content pages and multilingual navigation.
- Site rebuilt with zero missing BM/ZH translations; headers regenerated. Form config bundles using Wrangler 4.152.0 deploy --dry-run (no upload).
- Desktop and mobile fallback screenshots inspected. The Impeccable detector reports existing whole-page style/contrast advisories; no broad redesign was attempted.

## Limits and remaining work

No real AI, Turnstile or Meta requests or WhatsApp deliveries were made. No production code, configuration values, DNS or billing changed. A short-link budget reduces compatibility risk, not a universal WhatsApp/device guarantee; owner phone acceptance remains necessary after publication. Actual secret values were not validated. Production form preview build triggers were not inspected. Other informational audit suggestions remain optional, unimplemented here.

The older independent report exists at:
`/Users/adm/Documents/Codex/2026-10-25/referenced-chatgpt-conversation-this-is-an/outputs/ADS-000001-WO-000001-independent-red-team-2026-10-26.md`.
Its earlier NO-GO and PASS statements apply to that historical candidate, not this release.

Publication requires the owner's explicit production approval. Website and chatbot need separate deployment; the form change is a deployment requirement declaration, not a runtime fix or credential rotation.
