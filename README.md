# Ace Digital Solutions website

Production is hosted directly on Cloudflare at https://acedigitalsolutionsbiz.org/.

- `src/`: English source, Malay and Simplified Chinese translations, and the site builder.
- `site/`: committed production assets, including crawlable articles, About pages, sitemap and enforced security headers.
- Root `wrangler.toml`: static website deployment only.
- `backend/`: the separately deployed chatbot Worker, with bounded free-model fallback and exact-wording WhatsApp handovers.
- `whatsapp-enquiry/`: the separately deployed WhatsApp form Worker, with Turnstile and atomic submission/usage protection. Form-to-email delivery is disabled.
- `tests/`: browser and runtime regressions.

Build with `python3 src/build_site.py` (requires Python and Node.js). The default preserves the enabled chatbot; `--form-only` is for an intentionally AI-disabled site. Never commit provider credentials or local staging secrets.

See [DEPLOYMENT.md](DEPLOYMENT.md) for deployment boundaries and [docs/security/chatbot-launch-2026-10-27.md](docs/security/chatbot-launch-2026-10-27.md) for validation. The retained Netlify configuration is legacy; Netlify credits are not a dependency for the current production hosting.
