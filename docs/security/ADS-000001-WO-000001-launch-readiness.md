# ADS-000001-WO-000001 — form-only launch readiness

**ADS-000001 · Ace Digital Solutions · 25 October 2026 (Asia/Kuala_Lumpur)**
Branch: `security/form-launch-2026-10-25`; continuation of `52c19b0`.

**Required form checks PASS. Ready for explicit owner approval of the scoped release below. No production deployment or configuration change was made.**

## Critical controls

| Control | Status | Evidence and scope |
|---|---|---|
| I-2 / I-4 evidence recovered | **PASS** | Original `Downloads/Ace Staging Red Team.md`, `malaysia@f91f577`; descriptions assessed below |
| Staging authentication/isolation | **PASS** | Site/API key gates → 401; no WhatsApp token or email binding; delivery remains dry-run |
| Origin, schema, JSON and 8 KB boundary | **PASS** | Live hostile origins, malformed/array bodies, wrong media, oversized input and internal-field overrides rejected; chunked cancellation tested locally |
| Real Turnstile acceptance | **PASS** | Dedicated staging-only real widget; encrypted secret; Chrome widget succeeded and server accepted the synthetic enquiry with strict hostname validation |
| Turnstile rejection | **PASS** | Missing/object/blank/public-dummy tokens → 403 live; bad-host and provider-failure cases pass locally |
| Fail-closed dependencies | **PASS** | No delivery on missing/failing limiter, HMAC key, counter binding/store, invalid cap or failed captcha |
| Atomic abuse caps | **PASS** | Native workerd/SQLite: 20 concurrent reservations, cap 5 → exactly 5 accepted, 15 refused; next refused. Phone-normalisation/caps pass |
| Headers and label spoofing | **PASS** | Unicode U+2028/U+2029 variant reproduced, then fixed; all 50 form/adversarial checks pass; pre-fix negative control retained |
| Enforced CSP/security headers | **PASS** | Actual enforced headers on staging EN/BM/ZH; 14 browser checks pass, including mobile |
| Form-only and truthful status | **PASS** | AI URLs disabled; 9 browser cases pass. Dry-run says “Staging check passed. Nothing was sent.” Unknown success stages do not imply delivery |
| Existing WhatsApp delivery plumbing | **PASS** | One expressly authorised existing-production-endpoint request → 200 / accepted message ID; actual marker `ADS-WO000001-143054` seen in the owner's WhatsApp at **10:31 PM** |
| Production unchanged | **PASS** | Deployment IDs unchanged; no configuration, deployment, DNS or billing changes. Only the authorised synthetic delivery request touched the production endpoint |
| WhatsApp-only release preparation | **PASS** | `wrangler.form-only.toml` builds with atomic counter + limiter, without email; mandatory secure settings listed below |

**Verification:** 50 form/adversarial checks; 21 live staging checks; 9 mocked form-browser cases; 14 enforced-CSP browser checks; 2 native counter checks. No Claude Code or AI-provider calls. This focused review is by the implementing agent, not a new independent audit certification.

## Historical findings

- **I-2 — Informational:** always-pass staging test secret accepted `captcha: {}`. Strict typing now fixes this; real-secret rejection and genuine-token acceptance pass. No remaining form-launch blocker.
- **I-4 — Informational:** per-isolate deduplication; repeats consume quota before dedup. Reproduced: same-isolate repeat does not redeliver but consumes allowance; another isolate may deliver again, bounded by atomic caps. This can cause duplicate notifications or premature throttling. **Bounded reliability residual, not a critical form-security blocker; exactly-once delivery is not promised.**

Original source/hash: `references/I-2-I-4-recovered.md`. New fixes also cover Unicode label spoofing and misleading dry-run confirmation.

## Remaining NOT TESTED items

| Item | Status | Release treatment |
|---|---|---|
| Real email delivery | **NOT TESTED** | Disabled; not a launch dependency |
| Separate live token replay/expiry experiment | **NOT TESTED** | Invalid verification results are tested; single-use/expiry supplied by Siteverify |
| Candidate using production delivery credentials | **NOT TESTED** | Security tested on dry-run staging; existing delivery plumbing independently verified. Post-release smoke check required |
| Real AI chatbot / Gemini | **NOT TESTED** | Excluded; not a form-launch dependency |
| New comprehensive scan / independent audit | **NOT TESTED** | Focused form review only; historical audit retained |

## Exact approval scope

1. Deploy **only the enquiry Worker**, using `whatsapp-enquiry/wrangler.form-only.toml`: `ENQ_USAGE` migration, limiter and daily cap 50. Preserve working WhatsApp sender/token/recipient/template settings; retain old KV for rollback.
2. Set a fresh strong production `LIMIT_HMAC_KEY`; explicitly replace inherited settings with `CAPTCHA_OPTIONAL=false`, `STAGING=false`, `WHATSAPP_DRY_RUN=false`, and `ALLOWED_ORIGIN=https://acedigitalsolutionsbiz.org,https://www.acedigitalsolutionsbiz.org`. Privately provision the matching live-widget secret. Do not assume existing encrypted development settings are safe or create duplicate plaintext bindings.
3. Publish only the reviewed form-only `site/` assets and enforced headers to the existing Netlify site. **No broad branch merge, chatbot deployment, email-routing/DNS or billing changes.**
4. Perform one post-release synthetic real-token enquiry and verify WhatsApp receipt. On failure, roll back code/assets and the original binding configuration; preserve durable migration state.

The receipt test does **not** certify the old production security configuration: it accepted the authorised null-origin request, still has an encrypted `CAPTCHA_OPTIONAL` setting and lacks the new HMAC binding. The configuration changes above are mandatory parts of the proposed release.

**Approval is not assumed.** Sanitised test logs, version comparisons and receipt observations are in the companion evidence archive; secrets, raw tokens and unrelated WhatsApp content are excluded. The first real-browser acceptance preceded the dry-run copy correction; backend verification stayed unchanged, and corrected copy passed browser regression and final authenticated asset inspection.

Guidance: [Cloudflare Turnstile validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [widget management](https://developers.cloudflare.com/turnstile/get-started/widget-management/api/), [Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/), [OWASP input validation](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html).
