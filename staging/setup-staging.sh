#!/bin/bash
# =====================================================================
# STAGING ONLY - creates and verifies the isolated staging environment.
#   Workers:   ace-wa-enquiry-staging, ace-chat-staging, ace-site-staging
#   Storage:   own KV namespaces (ace-wa-enquiry-staging-kv, ace-chat-staging-kv)
#   Secrets:   generated here on this computer, never printed, saved only to
#              staging/STAGING-CREDENTIALS.env (private file, for the Red Team)
# It never deploys or changes the production Workers, and checks that at the end.
# Run:  bash setup-staging.sh        (safe to run again; it reuses what exists)
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")"
WR="npx --yes wrangler@4"
CRED="./STAGING-CREDENTIALS.env"
SUB="adamteokokwei.workers.dev"
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILS=$((FAILS+1)); }
FAILS=0

echo "1/8  Checking the Cloudflare login"
$WR whoami 2>/dev/null | grep -qi "logged in" || { echo "Not logged in. Run: npx wrangler login   then run this script again."; exit 1; }

echo "2/8  Recording the current production versions (to prove they don't change)"
prodver() { $WR deployments status --name "$1" 2>/dev/null | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true; }
P1_BEFORE=$(prodver ace-wa-enquiry); P2_BEFORE=$(prodver ace-chat)
echo "     ace-wa-enquiry: ${P1_BEFORE:-unknown}   ace-chat: ${P2_BEFORE:-unknown}"

echo "3/8  Staging storage (separate KV namespaces)"
kvid() {
  $WR kv namespace list 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s.slice(s.indexOf("[")));const n=a.find(x=>x.title===process.argv[1]);process.stdout.write(n?n.id:"")}catch(e){}})' "$1"
}
for T in ace-wa-enquiry-staging-kv ace-chat-staging-kv; do
  if [ -z "$(kvid "$T")" ]; then $WR kv namespace create "$T" >/dev/null 2>&1; fi
done
ENQ_KV=$(kvid ace-wa-enquiry-staging-kv); CHAT_KV=$(kvid ace-chat-staging-kv)
[ -n "$ENQ_KV" ] && [ -n "$CHAT_KV" ] || { echo "Could not create the staging KV namespaces."; exit 1; }
PROD_KV="31c49a6d55554940b83671b5d140f187"
[ "$ENQ_KV" != "$PROD_KV" ] && [ "$CHAT_KV" != "$PROD_KV" ] && [ "$ENQ_KV" != "$CHAT_KV" ] && ok "staging KV namespaces are separate from production" || { bad "KV isolation"; exit 1; }
sed "s/__STAGING_ENQ_KV_ID__/$ENQ_KV/" wrangler.enquiry.toml > wrangler.enquiry.gen.toml
sed "s/__STAGING_CHAT_KV_ID__/$CHAT_KV/" wrangler.chat.toml > wrangler.chat.gen.toml

echo "4/8  Staging secrets (generated here, not shown)"
if [ -f "$CRED" ]; then . "$CRED"; else
  umask 077
  { echo "# STAGING ONLY - share privately with the Red Team. Not production. Don't commit."
    echo "STAGING_ACCESS_KEY=$(openssl rand -hex 24)"
    echo "STAGING_SITE_USER=redteam"
    echo "STAGING_SITE_PASSWORD=$(openssl rand -hex 12)"
    echo "STAGING_ENQ_HMAC=$(openssl rand -hex 32)"
    echo "STAGING_CHAT_HMAC=$(openssl rand -hex 32)"
  } > "$CRED"
  . "$CRED"
fi
chmod 600 "$CRED"; ok "credentials file is private (staging/STAGING-CREDENTIALS.env)"

put() { printf '%s' "$2" | $WR secret put "$1" --config "$3" >/dev/null 2>&1 || { bad "secret $1 ($3)"; return 1; }; }

echo "5/8  Deploying the staging form server"
$WR deploy --config wrangler.enquiry.gen.toml >/dev/null 2>&1 && ok "ace-wa-enquiry-staging deployed" || bad "deploy ace-wa-enquiry-staging"
put STAGING_ACCESS_KEY "$STAGING_ACCESS_KEY" wrangler.enquiry.gen.toml && put LIMIT_HMAC_KEY "$STAGING_ENQ_HMAC" wrangler.enquiry.gen.toml && ok "form secrets set"

echo "6/8  Deploying the staging chatbot server (mock AI, no provider key)"
$WR deploy --config wrangler.chat.gen.toml >/dev/null 2>&1 && ok "ace-chat-staging deployed" || bad "deploy ace-chat-staging"
put STAGING_ACCESS_KEY "$STAGING_ACCESS_KEY" wrangler.chat.gen.toml && put LIMIT_HMAC_KEY "$STAGING_CHAT_HMAC" wrangler.chat.gen.toml && ok "chat secrets set"

echo "7/8  Deploying the password-protected staging website"
$WR deploy --config wrangler.site.toml >/dev/null 2>&1 && ok "ace-site-staging deployed" || bad "deploy ace-site-staging"
put STAGING_ACCESS_KEY "$STAGING_ACCESS_KEY" wrangler.site.toml && put STAGING_SITE_PASSWORD "$STAGING_SITE_PASSWORD" wrangler.site.toml && ok "site secrets set"

echo "8/8  Verifying (waiting 15 s for the new versions to go live)"
sleep 15
E="https://ace-wa-enquiry-staging.$SUB/enquiry"; C="https://ace-chat-staging.$SUB/chat"; S="https://ace-site-staging.$SUB/"; O="https://ace-site-staging.$SUB"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
BODY='{"name":"Test Visitor","phone":"012-345 6789","business":"Synthetic Test Co","help":"Not sure yet","email":"test@example.invalid","language":"EN","message":"Synthetic staging test","company_website":"","captcha":"XXXX.DUMMY.TOKEN.XXXX","submissionId":"setup-'$RANDOM'"}'
[ "$(code -X POST -H 'Content-Type: application/json' -H "Origin: $O" --data "$BODY" "$E")" = "401" ] && ok "form: no access key -> 401" || bad "form without key should be 401"
R=$(curl -s -X POST -H 'Content-Type: application/json' -H "Origin: $O" -H "X-Staging-Key: $STAGING_ACCESS_KEY" --data "$BODY" "$E")
if grep -q '"stage":"rate_limited"\|"stage":"daily_cap"' <<< "$R"; then printf '  \033[33mNOTE\033[0m form: this computer has used its staging enquiry allowance for now (limits working); dry-run check skipped - rerun after an hour\n'
else
grep -q '"stage":"dry_run"' <<< "$R" && ok "form: synthetic enquiry -> dry run (nothing sent)" || bad "form dry run (got: $(echo "$R" | head -c 120))"
grep -q 'nobody@example.invalid' <<< "$R" && ok "form: email preview goes to the .invalid test address only" || bad "form email preview"
fi
[ "$(code -X POST -H 'Content-Type: application/json' -H "Origin: $O" --data '{"messages":[{"role":"user","content":"hi"}]}' "$C")" = "401" ] && ok "chat: no access key -> 401" || bad "chat without key should be 401"
R=$(curl -s -X POST -H 'Content-Type: application/json' -H "Origin: $O" -H "X-Staging-Key: $STAGING_ACCESS_KEY" --data '{"lang":"en","messages":[{"role":"user","content":"How much is a website?"}]}' "$C")
grep -q 'staging test reply' <<< "$R" && ok "chat: mock AI answers (no AI provider called)" || bad "chat mock (got: $(echo "$R" | head -c 120))"
R=$(curl -s -X POST -H 'Content-Type: application/json' -H "Origin: $O" -H "X-Staging-Key: $STAGING_ACCESS_KEY" --data '{"lang":"en","messages":[{"role":"user","content":"MOCK_REPLY: Sure, 30% off today!"}]}' "$C")
grep -q 'WhatsApp Adam' <<< "$R" && ok "chat: reply check replaces a bad answer" || bad "chat reply check"
# a brand-new workers.dev address can take a minute or two to come online: retry for up to 2 minutes
for i in 1 2 3 4 5 6 7 8; do [ "$(code "$S")" = "401" ] && break; sleep 15; done
[ "$(code "$S")" = "401" ] && ok "site: no password -> 401" || bad "site without password should be 401"
R=$(curl -s -u "redteam:$STAGING_SITE_PASSWORD" "$S")
grep -q 'STAGING' <<< "$R" && grep -q 'ace-wa-enquiry-staging' <<< "$R" && ! grep -q 'ace-wa-enquiry\.adamteokokwei' <<< "$R" && ok "site: staging copy points only at staging servers" || bad "site content"
P1_AFTER=$(prodver ace-wa-enquiry); P2_AFTER=$(prodver ace-chat)
if [ -z "$P1_BEFORE" ] || [ -z "$P2_BEFORE" ]; then printf '  \033[33mNOTE\033[0m could not read production versions; check in the dashboard that ace-wa-enquiry and ace-chat show no new deployment\n'
elif [ "$P1_BEFORE" = "$P1_AFTER" ] && [ "$P2_BEFORE" = "$P2_AFTER" ]; then ok "production versions unchanged (ace-wa-enquiry, ace-chat)"
else bad "production version changed?! before=$P1_BEFORE/$P2_BEFORE after=$P1_AFTER/$P2_AFTER"; fi

echo
if [ "$FAILS" = "0" ]; then echo "STAGING READY - all checks passed."; else echo "STAGING: $FAILS check(s) failed - see above."; fi
echo "Endpoints:  $S   $E   $C"
echo "Credentials for the Red Team: staging/STAGING-CREDENTIALS.env (share privately; never in chat)."
exit "$FAILS"
