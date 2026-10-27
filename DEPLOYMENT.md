# Production deployment

The website is hosted directly on Cloudflare Worker `ace-digital-solutions`, with apex and www custom domains. Netlify is not the production hosting dependency.

Build the enabled-chatbot website with `python3 src/build_site.py`, then deploy the committed `site/` assets using the root `wrangler.toml`. Do not use `--form-only` for the current production release. Generated `site/` assets are committed so Cloudflare can deploy them without rebuilding.

Backend deployments are separate: `backend/wrangler.toml` for `ace-chat`, and `whatsapp-enquiry/wrangler.toml` for `ace-wa-enquiry`. Their configs match the verified production release. Preserve existing encrypted provider and WhatsApp credentials; do not put secrets in Git. The form configs deliberately omit plaintext duplicates of existing origin/CAPTCHA/dry-run secrets and keep the legacy KV binding for rollback. Email delivery is disabled.

Current limits: chat 100 model attempts/day and 20/visitor/hour, with one counted backup attempt at most; form 50 deliveries/day with shared atomic reservations. Handover text quotes visitor messages without asking AI to rewrite them. See docs/security/chatbot-launch-2026-10-27.md for validation and limitations.

When publishing new website changes, regenerate the security headers through the builder and verify canonical URLs, language links, chatbot fallback and the contact form. Do not merge historical branch snapshots over these release files.
