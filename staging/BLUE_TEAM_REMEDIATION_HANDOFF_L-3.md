# Blue Team remediation handoff: L-3 (concurrency-safe Gemini usage limits)

Branch `malaysia` @ `9ea2bc1` · Implemented and tested **locally only**. **Not deployed** (staging or production). `main` unchanged (`e6e270e`). No live settings changed.

## 1. Files changed

| File | Change |
|---|---|
| `backend/chat-worker.js` | New `ChatUsage` Durable Object class and `reserveAttempt()`. One unit is reserved before **every** AI attempt (Gemini main + backup, OpenAI, Claude, staging mock). `throttle()` is split out (the per-minute limiter, unchanged). Validation now runs before any limit. Removed `limitCheck()`, `countExtraAttempts()` and the chat KV counters |
| `backend/chat-worker.test.mjs` | Tests now use the **real** `ChatUsage` class behind a fake namespace (async storage, requests **not** serialised). +20 L-3 tests |
| `backend/wrangler.toml` (production config, repo only) | `CHAT_KV` binding removed; `USAGE` Durable Object binding + `[[migrations]] v1 new_sqlite_classes = ["ChatUsage"]` added |
| `staging/wrangler.chat.toml` | Same change for `ace-chat-staging` |

Production form config (`whatsapp-enquiry/wrangler.toml`) is unchanged.

## 2. Root cause and fix

**Root cause (confirmed):**
- `limitCheck()` read the KV counter, compared it, then wrote count + 1. Concurrent requests all read the same value and all passed. Each wrote the same "+1", so increments were lost.
- `countExtraAttempts()` charged backup attempts *after* the AI call, so retries were never stopped beforehand.
- `limitCheck()` ran before message validation, so invalid requests used up allowance.

**Fix:**
1. **Atomic counter.** A single `ChatUsage` Durable Object instance (`idFromName("chat-usage-v1")`) holds the daily total and the per-visitor hourly counts. `reserve()` is **synchronous**: check and increment happen with no `await` in between, so no two requests can take the same last unit. State loads once in `blockConcurrencyWhile()` and is persisted with `storage.put()` after each successful reservation; Durable Object output gates hold the reply until the write is confirmed.
2. **Reserve before every attempt.** `callAI(…, reserve)` calls `reserveAttempt()` before each provider call, including the backup model. Failed, timed-out and empty attempts keep their unit. If a reservation is refused, **no AI call is made**: a 429 on the first attempt, or no backup attempt.
3. **Per-visitor hourly limit** (`CHAT_IP_PER_HOUR`, default 60 attempts) is enforced in the same atomic object, keyed by the existing HMAC visitor id (no raw IP stored). Above 5,000 distinct visitors per hour, new visitors are refused (fail-closed memory bound).
4. **Validate first.** Origin, size, JSON and message validation all run before the throttle and before any reservation. Invalid requests get 400 and consume nothing.
5. **Fail closed.** Usage binding missing, Durable Object error or timeout (3 s), HMAC key missing, or a malformed counter reply → `503 unavailable`, no AI call, and the website shows its scripted answers.
6. **Unchanged:**
   - the per-minute `CHAT_LIMITER` throttle;
   - origin and size checks;
   - the reply check;
   - staging gate and mock;
   - the HMAC ids;
   - Turnstile on the form;
   - logs (reason codes only, no visitor text).

## 3. Test commands and actual results (25 Oct 2026)

| Command | Result |
|---|---|
| `cd backend && node chat-worker.test.mjs` | **84 passed, 0 failed** (64 existing, adapted to the Durable Object, + 20 new L-3) |
| `cd backend && node reply-check.corpus.test.mjs` | **126 passed, 0 failed** |
| `cd whatsapp-enquiry && npm test` | **33 / 33 pass** |
| `NODE_PATH=$(npm root -g) node tests/site-form.browser.cjs` | **7 / 7 pass** |
| `NODE_PATH=$(npm root -g) node tests/csp.browser.cjs` | **all pass** (CSP enforced, EN/BM/ZH, form, chat, mobile, demos) |
| `wrangler@4.152.0 deploy --dry-run` (backend/ and `staging/wrangler.chat.toml`) | Both build; bindings `env.USAGE (ChatUsage) Durable Object`, `env.CHAT_LIMITER`; no KV |

**Key L-3 results** (from `chat-worker.test.mjs`):
- **20 simultaneous requests, daily cap 5, slow async storage → exactly 5 AI attempts, 5 answered, 15 refused (429); counter = 5.** The cap still holds afterwards, with 0 AI calls.
- 5 repeated bursts with different storage delays: the worst case is **5** attempts.
- Failing provider, cap 3, sequential: **3 attempts in total**, so backup attempts were reserved too; the 4th request gets 429 with no call.
- 10 concurrent failing requests with retries, cap 4: **exactly 4 attempts**.
- 2 timed-out attempts → 2 units consumed.
- No AI call when: the counter is down, the counter binding is missing, the HMAC key is missing, or the cap is 0. With cap 1, the backup is **not** called once its reservation is refused.
- 6 invalid requests (empty, wrong type, assistant-only, system role, blank, bad JSON) → all 400, **0 throttle calls, 0 reservations, 0 AI**.
- One visitor, 12 concurrent requests, hourly cap 3 → exactly **3** attempts; another visitor is unaffected.
- `ChatUsage` unit checks: the day rolls over, malformed input is refused, state is persisted and survives a restart.

**Negative control:** the same 20-request burst against a deliberately non-atomic counter (read, await, write) admitted **20 attempts with the counter at 1**, reproducing the original bug. So the test detects the problem.

**Production unchanged:** nothing was deployed, `main` is still `e6e270e`, and no Cloudflare settings were touched. The production chatbot config change exists only on `malaysia`.

## 4. Remaining risks

- **One global counter object** handles all AI reservations: about 1 small request per AI attempt. That's ample for this site; at very high traffic it would need sharding.
- **Real Durable Object behaviour isn't tested yet:** placement, a cold start under load, and a regional outage that fails closed. It's covered by local tests and dry-run builds only; it needs a staging deploy (awaiting approval).
- **The hourly window is a fixed clock hour (UTC),** not a sliding window, so a visitor can use up to 2× the limit across an hour boundary.
- **The per-minute `CHAT_LIMITER` stays approximate** (a throttle only).
- **The form's KV caps** (`whatsapp-enquiry`) are still read-then-write. They're out of scope for L-3 and mitigated because every enquiry needs its own Turnstile pass; they could adopt the same pattern later.
- **The request cap is not a money cap.** The provider-side prepaid credit and spend cap are still recommended before Gemini billing.

## 5. Independent Red Team verification (after an approved staging deploy)

**Deploy (owner approval needed):** re-run `RUN STAGING SETUP.command` with the updated bundle. The new Durable Object migration is created automatically. Staging uses the mock AI, so there's no cost.

**Retest, staging only:**
1. **Concurrency:**
   - temporarily set staging `CHAT_DAILY_CAP=5`;
   - from a fresh day/counter, send 20 simultaneous valid `/chat` requests with `X-Staging-Key`;
   - expect at most 5 × 200 and the rest 429;
   - the next request → 429.
2. **Retries:** send `MOCK_FAIL:503` requests with a small cap, and confirm each request consumes 2 units and that nothing goes past the cap.
3. **Invalid requests:** malformed bodies, empty or role-confused messages, and bad JSON should give 400 and must not reduce the remaining allowance. Check with a valid request afterwards.
4. **Hourly per-visitor:** set `CHAT_IP_PER_HOUR=3`; 12 concurrent requests from one IP → at most 3 × 200.
5. **Fail-closed:** if possible on a throwaway staging copy, remove the `USAGE` binding or the HMAC key and confirm 503 with no AI.
6. **Logs:** confirm no visitor text or raw IP in the Worker logs.

**Stop conditions:** the same as `RED_TEAM_HANDOFF.md`. Production is out of scope.
