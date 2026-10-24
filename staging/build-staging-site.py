#!/usr/bin/env python3
"""STAGING ONLY. Copies site/ to staging/site-dist/ and points it at the staging servers:
staging form/chat URLs, Cloudflare's always-pass Turnstile TEST site key, and the X-Staging-Key header."""
import os, re, shutil, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC, DST = os.path.join(ROOT, "site"), os.path.join(ROOT, "staging", "site-dist")
REPL = [
    ("https://ace-wa-enquiry.adamteokokwei.workers.dev", "https://ace-wa-enquiry-staging.adamteokokwei.workers.dev"),
    ("https://ace-chat.adamteokokwei.workers.dev", "https://ace-chat-staging.adamteokokwei.workers.dev"),
    ('const TURNSTILE_SITEKEY = "0x4AAAAAAFjkFvWRmLvTXswG"', 'const TURNSTILE_SITEKEY = "1x00000000000000000000AA"'),
    ('headers:{"Content-Type":"application/json"}', 'headers:{"Content-Type":"application/json","X-Staging-Key":(window.__STG_KEY__||"")}'),
]
if os.path.exists(DST): shutil.rmtree(DST)
shutil.copytree(SRC, DST)
counts = {r[0][:40]: 0 for r in REPL}
for d, _, files in os.walk(DST):
    for f in files:
        if not f.endswith(".html"): continue
        p = os.path.join(d, f); s = open(p, encoding="utf-8").read(); o = s
        for a, b in REPL:
            counts[a[:40]] += s.count(a); s = s.replace(a, b)
        if s != o: open(p, "w", encoding="utf-8").write(s)
# safety: no production endpoint or production site key may remain
left = []
for d, _, files in os.walk(DST):
    for f in files:
        if f.endswith(".html"):
            s = open(os.path.join(d, f), encoding="utf-8").read()
            if re.search(r"https://ace-(wa-enquiry|chat)\.adamteokokwei|0x4AAAAAAFjkFvWRmLvTXswG", s): left.append(f)
print("replacements:", counts)
if left: sys.exit("ERROR: production references left in " + ", ".join(left))
print("staging site built:", DST)
