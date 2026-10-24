# RED TEAM HANDOFF: Ace Digital Solutions (enquiry form + website chatbot)

Prepared by the Blue Team on 25 October 2026. The independent Red Team runs in a **separate session** and verifies everything here independently. **Test staging only.** Production is out of scope without the owner's written approval.

## 1. Staging architecture and authorised endpoints

| Component | URL | Access |
|---|---|---|
| Staging website (copy of the real site, pointing only at the staging servers) | `https://ace-site-staging.adamteokokwei.workers.dev/` | HTTP Basic Auth, user `redteam`, password from the owner |
| Staging form server | `POST https://ace-wa-enquiry-staging.adamteokokwei.workers.dev/enquiry` | Header `X-Staging-Key: <key from owner>` |
| Staging chatbot server | `POST https://ace-chat-staging.adamteokokwei.workers.dev/chat` and `/summary`; `GET /` | Header `X-Staging-Key: <key from owner>` |

```
browser (staging site, Basic Auth)
   ├─► ace-wa-enquiry-staging  →  WhatsApp DRY RUN (no token configured) + email PREVIEW only (no email binding)
   └─► ace-chat-staging        →  AI_MOCK (no AI provider, no key); reply check runs on mock output
```

**Isolation, verified by the Blue Team on 25 Oct 2026** (`staging/setup-staging.sh`, all checks PASS):
- Separate Workers (`*-staging`).
- Separate KV namespaces (`ace-wa-enquiry-staging-kv`, `ace-chat-staging-kv`), checked to differ from production.
- Separate rate-limit namespaces (1101, 1102).
- Separate HMAC secrets and access key.
- No WhatsApp token, no email binding, no Gemini key.
- The form server **refuses to run** if any real delivery credential is ever added (`staging_not_isolated`).
- The production Worker versions were recorded before and after deployment and didn't change.

**Credentials** (staging access key, site password) are in the owner's private file `Staging/staging/STAGING-CREDENTIALS.env`. The owner shares them out of band. Never paste them into tickets, chats or reports.

## 2. Repository and branch

- Repo: `https://github.com/adamteokokwei-beep/ace-digital-solutions` (**public**), branch **`malaysia`**. `main` = production; don't push to it.
- Code under test:
  - `whatsapp-enquiry/worker.js` (form);
  - `backend/chat-worker.js` (chatbot);
  - `src/index.src.html` → `site/` (website);
  - `staging/` (staging config, site wrapper, setup and test scripts).
- Existing tests:
  - `whatsapp-enquiry/test/worker.test.mjs` (33);
  - `backend/chat-worker.test.mjs` (60);
  - `tests/site-form.browser.cjs` (7, mocked);
  - `staging/blueteam-staging.mjs` (35, live staging);
  - `backend/redteam-chat.mjs` (live AI prompts; **don't** run it against production).

## 3. Security controls to verify

**Form, in order:**
1. staging key (staging only);
2. origin allow-list;
3. JSON only, 8 KB cap;
4. honeypot `company_website`;
5. per-IP limiter (3/60 s, fail-closed);
6. validation and sanitisation (NFKC; zero-width/bidi/control stripping; odd dots; fixed lists for type/budget/timeline; phone normalisation; strict email);
7. **Turnstile, required** (server-side verify; staging uses Cloudflare's always-pass **test** secret, and a missing token is still refused);
8. KV caps with HMAC-keyed identifiers: 6/hour per IP, 3/day per phone, daily total (staging 30), fail-closed;
9. duplicate `submissionId`;
10. output defanging of links, IPs and WhatsApp formatting in both the template and the email;
11. delivery success if either channel succeeds.

**Chatbot:**
1. staging key;
2. origin allow-list (default: live domains only);
3. 32 KB cap;
4. only `/chat` and `/summary`;
5. per-IP limiter 10/60 s;
6. KV caps 60/hour per IP and a daily attempt total (staging 100), HMAC-keyed, fail-closed;
7. at most 2 AI attempts per question, each counted, 6 s each;
8. **reply check**: unsupported RM amounts (valid prices and derived estimates allowed), other currencies, un-negated discount or guarantee wording (EN/BM/ZH), instruction-leak markers and 7-word overlap with the rule section; replaced by a safe answer in the visitor's language;
9. generic errors only;
10. the browser escapes AI output.

**Staging test hooks** (only when `STAGING=true`):
- a chat message starting `MOCK_REPLY: <text>` makes the mock AI return `<text>`, so you can test the reply check directly;
- `MOCK_FAIL:503` simulates a provider failure;
- the form's dry run returns `preview` (the WhatsApp template) and `emailPreview` (the email headers and body).

## 4. Scope

**In scope (staging only):**
- the three endpoints above;
- the staging website UI on desktop and mobile;
- source-code review of the `malaysia` branch.

**Out of scope:**
- production endpoints (`ace-wa-enquiry`, `ace-chat`, `acedigitalsolutionsbiz.org`) beyond passive reading of public pages;
- Cloudflare, Meta, Google and GitHub infrastructure or accounts;
- social engineering of the owner;
- volumetric DoS (only confirm that the limits engage);
- real personal data;
- any attempt to reach the owner's WhatsApp or Gmail.

## 5. Known risks (already accepted; report only if exploitable beyond this description)

- **Approximate counters:** KV is eventually consistent, and the rate-limit binding is per location and approximate. A burst can slightly exceed the caps; the Blue Team saw 11 chat requests pass before a 429 at a 10/min limit.
- **Reply check limits:** it's keyword and number based. It can't tell when a valid-looking amount is attached to a service Ace doesn't offer (e.g. "e-commerce for RM3,500" = RM1,500 + 5 add-ons). It may miss prices written in words or languages other than EN/BM/ZH.
- **No Turnstile on chat:** many IPs can use up the daily cap; visitors then get scripted answers.
- **Origin checks** can be faked outside browsers.
- **Duplicate detection** is per instance.
- **WhatsApp sender** is Meta's test number (production).
- **Public repo:** thresholds and prompts are visible by design.

## 6. Safe test data

- Names like `Test Visitor`, businesses like `Synthetic Co`.
- Phones `012-555 0000` to `012-555 9999`.
- Emails `@example.invalid`.
- Messages tagged `REDTEAM-<date>`.
- No real names, numbers, IC numbers, card numbers or addresses.

## 7. Recommended tooling

- **OWASP ZAP:** Baseline scan of the staging site (Basic Auth via an Authentication header, or a Replacer rule adding `Authorization: Basic …`). An API/active scan of the two POST endpoints, adding `X-Staging-Key` with a Replacer rule. Set the thread count to 1 and the delay to ≥ 7 s (chat) / ≥ 21 s (form) so you measure controls, not limits.
- **Semgrep:** `semgrep --config p/javascript --config p/owasp-top-ten --config p/secrets --config p/xss .`
- **CodeQL:** JavaScript query suites `security-extended` and `security-and-quality` on `malaysia`.
- **Dependencies:** the Workers have **no runtime dependencies**. Run `npm audit` in `whatsapp-enquiry/`; review the build tool (wrangler) version.
- **Secret scanning:** `gitleaks detect --log-opts="--all"` and/or `trufflehog git file://. --since-commit <root>`. The Blue Team's history scan found image data only; please verify independently.

## 8. Attack scenarios (suggested)

**Form**
1. Deliver an enquiry without a valid Turnstile token: missing, malformed or replayed tokens; type confusion (`captcha: {}` / array).
2. Bypass the limits:
   - spoof `CF-Connecting-IP` / `X-Forwarded-For`;
   - IPv6 rotation;
   - concurrency races against the KV caps;
   - vary the phone format to dodge the per-number cap (`+60…` vs `0…` vs spaces/dashes/fullwidth digits).
3. Force a fail-open state: malformed bodies, huge headers, non-JSON with a JSON type, prototype pollution (`__proto__`, `constructor`).
4. Inject into the owner's channels:
   - make a clickable URL, phone or `wa.me` link, or a fake field line appear in `preview` or `emailPreview`;
   - homoglyphs, other dot characters, punycode, RTL/bidi, combining marks, emoji ZWJ sequences, very long words, template-breaking characters;
   - email header injection through every field.
5. Information leaks: error bodies, `in_progress` / `duplicate` behaviour, timing differences, the health route.

**Chatbot**
1. Use `MOCK_REPLY:` to find text that gets past the reply check:
   - prices in words ("one thousand ringgit");
   - split numbers, Manglish, Tamil;
   - percentages without "off";
   - "free", "rebate", "cheaper for you";
   - other currency symbols;
   - guarantees phrased as promises ("you'll definitely rank");
   - instruction paraphrases.
2. Real prompt-injection payloads, run with the mock disabled. This requires a separate, owner-approved Gemini test key and budget. **Not available by default.**
3. Use up the cap and confirm the behaviour: the 429 → scripted fallback in the UI.
4. XSS through AI output in the chat window: inject markup via `MOCK_REPLY:` and check the rendering on the staging site.
5. `/summary` abuse: oversized history, role confusion, `estimate` field injection.

**Website (staging)**
- CSP/headers review;
- DOM XSS in the form status and fallback (`waLink`, copy text);
- mobile layout and the anti-spam widget on a phone width.

## 9. Test rates and resource limits

- **Form:** ≤ 1 counted request per 21 s from one IP. The staging daily total is **30**, so plan the tests.
- **Chatbot:** ≤ 1 request per 7 s; staging daily total **100** attempts.
- **Burst tests:** at most 1 burst of ≤ 15 requests per endpoint per hour.
- Counters reset automatically: per-hour keys after about an hour, daily keys after about 25 hours. If you need a reset sooner, ask the owner; the Blue Team can clear only the staging KV namespaces.

## 10. Stop conditions (stop immediately and tell the owner)

- Any message reaches the owner's real WhatsApp or Gmail.
- Any request reaches a production Worker or changes production data or settings.
- Any real personal data or secret appears in a response, log or the repo.
- Signs of unexpected cost or quota use on any real provider account.
- Staging returns `staging_not_isolated`. Isolation is broken: stop and report.
- The testing window ends.

## 11. Deliverable

For each finding:
- the endpoint;
- reproduction steps with secrets redacted;
- evidence;
- impact;
- severity (Critical / High / Medium / Low / Info);
- a suggested fix.

Plus a list of controls that held up, and recommended rate-limit adjustments with evidence.
