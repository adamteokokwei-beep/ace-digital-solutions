#!/bin/bash
# STAGING ONLY - runs the Blue Team checks while recording the staging Workers' logs, then checks those logs
# for synthetic enquiry/chat content and for the access key. Prints counts only; deletes the raw logs afterwards.
cd "$(dirname "$0")"
WR="npx --yes wrangler@4.152.0"
. ./STAGING-CREDENTIALS.env
umask 077
$WR tail ace-wa-enquiry-staging --format json > .tail-enq.json 2>/dev/null & T1=$!
$WR tail ace-chat-staging --format json > .tail-chat.json 2>/dev/null & T2=$!
sleep 12
node blueteam-staging.mjs; RC=$?
sleep 8; kill $T1 $T2 2>/dev/null; wait 2>/dev/null
MARK=$(grep -m1 '^marker for log check:' blueteam-results.txt | awk '{print $NF}')
EV1=$(grep -c '"outcome"' .tail-enq.json 2>/dev/null || echo 0); EV2=$(grep -c '"outcome"' .tail-chat.json 2>/dev/null || echo 0)
M=$(cat .tail-enq.json .tail-chat.json 2>/dev/null | grep -c "$MARK")
SYN=$(cat .tail-enq.json .tail-chat.json 2>/dev/null | grep -ci "Synthetic Blue Team\|Synthetic Co\|012-555\|Special price for you\|30% off")
K=$(cat .tail-enq.json .tail-chat.json 2>/dev/null | grep -c "$STAGING_ACCESS_KEY")
LOGS=$(cat .tail-enq.json .tail-chat.json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=s.match(/"message":\s*\[[^\]]*\]/g)||[];const set=new Set(m.map(x=>x.replace(/\s+/g," ").slice(0,140)));console.log([...set].slice(0,15).join("\n"))})')
{
echo "== log check (staging Workers, recorded during the run) =="
echo "log events captured: form $EV1, chat $EV2"
echo "lines containing the synthetic marker: $M   (expected 0)"
echo "lines containing synthetic enquiry/chat text: $SYN   (expected 0)"
echo "lines containing the staging access key: $K   (expected 0; request headers are redacted by Cloudflare tail)"
echo "distinct log messages written by the code:"; echo "$LOGS"
} | tee -a blueteam-results.txt
rm -f .tail-enq.json .tail-chat.json
exit $RC
