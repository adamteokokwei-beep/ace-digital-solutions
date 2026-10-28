# Production deployment

The website is hosted directly on Cloudflare Worker `ace-digital-solutions`, with apex and www custom domains. Netlify is not the production hosting dependency.

Build the enabled-chatbot website with `python3 src/build_site.py`, then deploy the committed `site/` assets using the root `wrangler.toml`. Do not use `--form-only` for the current production release. Generated `site/` assets are committed so Cloudflare can deploy them without rebuilding.

Backend deployments are separate: `backend/wrangler.toml` for `ace-chat`, and `whatsapp-enquiry/wrangler.toml` for `ace-wa-enquiry`. Their configs match the verified production release. Preserve existing encrypted provider and WhatsApp credentials; do not put secrets in Git. The form configs deliberately omit plaintext duplicates of existing origin/CAPTCHA/dry-run secrets and keep the legacy KV binding for rollback. Email delivery is disabled.

Current limits: chat 100 model attempts/day and 20/visitor/hour, with one counted backup attempt at most; form 50 deliveries/day with shared atomic reservations. Handover preserves the full displayed chat without AI rewriting. Assistant turns are labelled automated and not a quote; every content line is quoted. Long percent-encoded links use a full local copy/download fallback instead of truncation. See docs/security/chatbot-launch-2026-10-27.md for validation and limitations.

When publishing new website changes, regenerate the security headers through the builder and verify canonical URLs, language links, chatbot fallback and the contact form. Do not merge historical branch snapshots over these release files.

## Pull-request previews

Cloudflare preview builds run `npx wrangler preview`. The website uses repository root `/`. The chatbot production root is `backend/`. The repaired PR #1 branch trigger uses root `backend` with `npx wrangler preview`; the preview base uses root `/` with `npx wrangler preview --config backend/wrangler.toml`. Existing branch triggers can differ from the base. Production and preview build settings are separate; verify the actual build log uses the chatbot entry point.

The website config explicitly enables static previews. The chatbot preview overrides disable AI and set both attempt caps to zero, with no required secrets or production counter bindings. The preview returns a safe 503; it is a configuration/build check, not a real-provider acceptance environment. Do not import production secrets into Previews Base. The existing isolated mock staging Worker remains the functional test environment.

## Form settings preflight

All nine names in `whatsapp-enquiry/wrangler.toml` `[secrets].required` must exist as encrypted production secrets. On 28 October a names-only API check confirmed all nine; no values were read or changed. `keep_vars = false` removes inherited plaintext variables but preserves encrypted secrets. Do not deploy if any required name is missing; the owner must supply its reviewed value privately. This preflight is not a verification of secret correctness or production build-trigger isolation.
