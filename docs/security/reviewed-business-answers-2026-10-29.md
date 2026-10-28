# Reviewed business answers - 29 October 2026

Status: candidate prepared for owner review; not merged or deployed. Base main a684dfa2fce055a5c2850421cd255053bf75a033. This supersedes the remaining M-A price-context gap for the normal business widget.

## Behaviour and tradeoff

The AI selects an answer ID instead of writing business replies. The backend accepts only a JSON object with exactly one key and an approved string ID, then returns the corresponding server-owned English, Malay or Simplified Chinese answer. Invalid output uses the fixed contact/written-quote referral. Visitor text, generated explanations, price calculations and extra fields are never interpolated into normal business replies. The router's contact choice intentionally resolves to the safe referral.

The reviewed catalogue covers pricing, included services, payment, timing, Care, domains, languages, content, general business websites, meetings and privacy. This is a deliberate shift from free-form business replies: answers are bounded and less personalised. The AI can select an irrelevant answer or fail JSON formatting; usefulness must be distinguished from output safety. Future changes to catalogue facts require review. Real-provider answer-selection quality has not been tested in this candidate.

Existing AI attempt quotas, model fallback, timeouts, kill switch, origins and credentials are unchanged. Provider requests still occur and count normally; this is not an offline or zero-provider-use chatbot. Provider outages still use the website's existing scripted fallback. The cost calculator continues deterministic estimates; final agreement remains Adam's written quote.

## Calculator correction

Both calculator and typed-needs estimate previously displayed a 50% starting amount. They now use the published RM200 deposit; the calculator's remaining balance is total minus RM200. An empty selection returns to the calculator and does not quote a deposit. Current nonempty project selections are at least RM500. Totals, rush fees and add-on rates are unchanged.

## Independent review and tests

The independent red-team retest found no blocker for the normal business widget: seven original complete-Worker probes, indirect phrases such as 'half a grand'/'on the house', and 30 additional malformed/prototype/duplicate-key probes emitted only reviewed text. It also confirmed old numeric addresses/history cannot lock later answers into pricing. Evidence is in outputs/pricing-fix-2026-10-29 outside the repo.

Fresh local tests: 91 chatbot assertions, 126 legacy reply-corpus cases, nine security regressions and five new reviewed-output tests. The five new tests exercise the complete Worker path in every language, every catalogue answer, malformed/extra/prototype output, numeric history and published rates. The legacy checkReply corpus remains a secondary/demo regression suite; passing it alone does not prove the business output boundary.

Browser scenarios verify all three languages with provider success/outage, full chat copy/download, reset, escaping and CSP, plus RM200/RM1,400 default deposit/balance and empty-selection behaviour. Enforced-CSP checks pass; the backend dry-run bundle succeeds without uploading.

## Scope and publication

The separate public jb-demo/capitol-demo request modes intentionally retain their existing generated-demo behaviour and wording checks. The actual business widget sends no demo selector. Do not describe the entire endpoint or demos as template-only; the mode selector is not an authorization boundary. Client-side transcript labels and written-quote reminder remain.

No production deployment, real AI/Meta/Turnstile request, form submission, WhatsApp message, credential or billing change was made for this candidate. Owner approval is required before merging/deploying. After publication, verify active backend code and run a small owner acceptance check for answer-selection usefulness.
