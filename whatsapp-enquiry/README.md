# WhatsApp enquiry form (test kit)

A website enquiry form whose submissions go **straight to the business owner's WhatsApp**, sent by a small
server using Meta's official **WhatsApp Business Platform Cloud API**. The customer just presses *Send enquiry*.
They don't need to open WhatsApp, and the owner's number is never shown on the website.

This kit is separate from the live Ace Digital Solutions website and from the `ace-chat` chatbot server.
Nothing here is published or deployed.

## 1. What's in this folder

| File | What it is |
|---|---|
| `worker.js` | The server code (a Cloudflare Worker). It checks the form, blocks spam and sends the WhatsApp message. |
| `public/index.html` | The enquiry form test page (mobile friendly, same look as your site). |
| `dev-server.mjs` | Runs `worker.js` and the test page on your computer, with no installs. |
| `.env.example` | The settings you need. Copy it to `.env` and fill it in. |
| `wrangler.toml` | Cloudflare settings, used only when you deploy. |
| `test/worker.test.mjs` | 15 automatic tests. All WhatsApp calls are faked, so nothing is ever sent. |

## 2. How it fits your current setup

- **Your site:** a static website on Netlify (plain HTML, no framework), with the chatbot server on Cloudflare Workers.
- **Why a Worker:** Netlify serves only files here, so the secure part (the WhatsApp token) lives in a separate
  Cloudflare Worker called `ace-wa-enquiry`. That's the same kind of service as your chatbot server, on the
  free plan for this volume.
- **The website side:** the form posts to that Worker over HTTPS. The token stays on the server and never reaches the browser.

## 3. Try it on your computer (no WhatsApp account needed)

You need Node.js 18 or newer. Type `node -v` in Terminal; if nothing shows, install it from nodejs.org.

```bash
cd "WhatsApp enquiry test"
cp .env.example .env          # WHATSAPP_DRY_RUN=true is already set: nothing will be sent
node dev-server.mjs
```

Then open **http://localhost:8787**. In dry-run mode, the page shows the exact message the owner would receive.

You can also see every screen without any server: open `public/index.html` and add one of these to the address:

| Add to the address | Shows |
|---|---|
| `?mock=ok` | Success |
| `?mock=dry` | Dry-run preview |
| `?mock=auth` | Login failure |
| `?mock=rejected` | WhatsApp refused the message |
| `?mock=timeout` | Timeout |
| `?mock=busy` | WhatsApp busy |
| `?mock=rate` | Rate limit |
| `?mock=invalid` | Invalid phone number |

Run the automatic tests:

```bash
node --test test/worker.test.mjs
```

## 4. Meta setup (you have to do this, signed in to your own accounts)

Official docs: https://developers.facebook.com/docs/whatsapp/cloud-api/

1. **Create the app.** Go to developers.facebook.com, choose *My Apps → Create app → Business*, and add the **WhatsApp** product.
   This creates a Meta Business portfolio and a **test business phone number**.
2. On **WhatsApp → API Setup**, copy:
   - the **Phone number ID**, into `WHATSAPP_PHONE_NUMBER_ID`
   - the **temporary access token**, into `WHATSAPP_ACCESS_TOKEN`. It lasts about 24 hours, so use it for first tests only.
   - the **API version** shown in the example request (e.g. `v23.0`), into `WHATSAPP_API_VERSION`
3. **Add yourself as a test recipient.** Under *To*, add the WhatsApp number that should **receive** enquiries
   (your own number) and confirm the code WhatsApp sends you. The test number can only message numbers added
   here (up to 5). Put that number in `WHATSAPP_RECIPIENT_NUMBER` with the country code and no `+`
   (e.g. `60123456789`).
4. **First real test (the 24-hour rule).** WhatsApp only allows normal text messages from a business within
   24 hours of the recipient last messaging that business number. So, from your phone, send any message
   (e.g. "hi") **to the test business number**. Then set `WHATSAPP_DRY_RUN=false`, run the server again and
   submit the form. The enquiry should arrive within seconds.
5. **For real use, create a message template** so it works any time, not just within 24 hours.
   In *WhatsApp Manager → Message templates*, create one with:
   - **Category:** Utility. **Name:** `website_enquiry`. **Language:** English.
   - **Body:**
     ```
     New website enquiry
     Name: {{1}}
     WhatsApp: {{2}}
     Enquiry type: {{3}}
     Location: {{4}}
     Budget: {{5}}
     Timeline: {{6}}
     Description: {{7}}
     Source: Website enquiry form
     ```
   After Meta approves it, set `WHATSAPP_TEMPLATE_NAME=website_enquiry` (and `WHATSAPP_TEMPLATE_LANGUAGE=en`).
   Template values can't contain line breaks, so line breaks in the description become " / ".
6. **Permanent token.** Go to *Business settings → Users → System users*, add a system user, assign the app
   and your WhatsApp account, then generate a token with the `whatsapp_business_messaging` and
   `whatsapp_business_management` permissions. This replaces the 24-hour token.
7. **Your own sending number (optional, later).** To send from a real business number instead of Meta's test
   number, add it under *API Setup → Add phone number*. It must not already be used in the WhatsApp or
   WhatsApp Business app. You'll also need a payment method, and business verification for higher limits.
   **Cost:** Meta charges per *template* message delivered. Utility messages in Malaysia cost a few sen each;
   check Meta's pricing page for the current rate. Cloudflare Workers' free plan covers this volume.

## 5. Deploy (only when you're ready)

```bash
cd "WhatsApp enquiry test"
npx wrangler login
npx wrangler deploy
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
```

The last command asks you to paste the token; it's never stored in a file. Then, in **Cloudflare → Workers →
ace-wa-enquiry → Settings → Variables**, add the other settings:

| Variable | Value |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | from Meta |
| `WHATSAPP_RECIPIENT_NUMBER` | the number that receives enquiries |
| `WHATSAPP_API_VERSION` | e.g. `v23.0` |
| `WHATSAPP_TEMPLATE_NAME` | e.g. `website_enquiry` |
| `ALLOWED_ORIGIN` | `https://acedigitalsolutionsbiz.org` |
| `WHATSAPP_DRY_RUN` | `false` |

On the website, point the form to `https://ace-wa-enquiry.<your-account>.workers.dev/enquiry`. That's the
`ENDPOINT` line in `public/index.html`. Adding the form to the live site is a separate step I'll only do when you say so.

**Optional captcha:** create a Cloudflare Turnstile widget, put its secret in `TURNSTILE_SECRET`, and add the
widget to the page. When the secret is set, the server rejects submissions without a valid captcha.

## 6. What the customer sees

| Situation | Message | What happens to the form |
|---|---|---|
| WhatsApp accepted the message | "Your enquiry has been sent" | Cleared |
| Missing or invalid field | The field is highlighted | Nothing is sent |
| Any failure: login problem, WhatsApp refused it, timeout, too many tries | "Your enquiry was **not** sent" | Details stay in the form, with **Try again** and **Copy my enquiry** buttons |

The page never shows success unless WhatsApp's API returned a message ID.

There are three different levels of "sent":

1. **Form accepted by the server:** validation and spam checks passed.
2. **Accepted by the WhatsApp API:** Meta returned a message ID. This is what "sent" means on the page.
3. **Delivered or read on the owner's phone:** Meta reports this later through a *webhook*, which isn't
   included yet. It would need a second small endpoint and, to show it to the customer, some short-lived
   storage. I'll ask before adding either.

## 7. Privacy and security

**Done in this kit:**
- no enquiry-content database or queue; durable storage keeps HMAC identifiers, counters and fixed acknowledgement states
- contents are never logged (only HTTP status and Meta error codes)
- no analytics, and nothing is saved in browser storage
- the token is server-side only
- server-side validation, field length limits and an 8 KB request limit
- a honeypot field for spam bots
- Cloudflare rate limiting (3 per minute per IP), plus atomic hourly/day caps; missing bindings fail closed
- the server only accepts requests from your website
- durable duplicate protection for the same submission ID and normalized payload within one UTC day; no exactly-once delivery guarantee

**What is *not* fully under your control (said honestly):**
- **Cloudflare** processes each request in memory. It may keep standard request metadata, such as IP
  addresses and times, in its own logs, but not the form contents unless you add logging.
- **Meta/WhatsApp** stores and processes messages to deliver them, and keeps copies under its own policies. The
  message then stays in the owner's WhatsApp chat, and in their phone backups if those are on.
- **The customer's browser** may autofill or remember what they typed (normal browser behaviour).

**If sending fails**, enquiry content cannot be recovered from the server. The submission ID remains locked for that UTC day to prevent automatic duplicate delivery; ambiguous failures need manual follow-up. That's why the page
keeps the customer's details in the form with *Try again* and *Copy my enquiry*. A possible later option, only
with your approval: have the page offer the customer a WhatsApp chat link when sending fails. The trade-off is
that it shows the business number. Automatic retries would need a queue that stores the enquiry for a short
time, so I haven't added that.

## 8. Checklist

- [ ] `node --test test/worker.test.mjs` shows **15 pass**
- [ ] Dry run: the form shows the preview message, and nothing arrives on WhatsApp
- [ ] `?mock=auth` / `?mock=timeout`: the page says **not sent** and keeps the details
- [ ] Recipient number added and verified in Meta *API Setup*
- [ ] You sent "hi" to the test number, then set `WHATSAPP_DRY_RUN=false`: the enquiry arrives on your WhatsApp
- [ ] Template `website_enquiry` approved, `WHATSAPP_TEMPLATE_NAME` set: an enquiry arrives even after 24 hours
- [ ] Permanent system-user token in place of the temporary token
- [ ] Deployed Worker with `ALLOWED_ORIGIN` set to your website; the token added as a **secret**
- [ ] `.env` is not in Git (it's in `.gitignore`)
