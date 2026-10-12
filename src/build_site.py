#!/usr/bin/env python3
"""Builds the live site from one source file.

  src/index.src.html   the page (English), edited by hand
  src/i18n/bm.json     English text -> Bahasa Melayu
  src/i18n/zh.json     English text -> Simplified Chinese

Writes site/index.html (EN), site/bm/index.html (BM), site/zh/index.html (中文) and site/sitemap.xml.
Run:  python3 src/build_site.py          (add --missing to list text that has no translation yet)
"""
import json, os, re, sys, html as H

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src", "index.src.html")
SITE = os.path.join(ROOT, "site")
DOMAIN = "https://acedigitalsolutionsbiz.org"
WA_NUMBER = "60102641824"
FB = "https://www.facebook.com/profile.php?id=61595360692132"

LANGS = {
  "en": {"path": "/", "html_lang": "en-MY", "hreflang": "en", "og_locale": "en_MY",
         "title": "Professional Websites for Malaysian Businesses | Ace Digital Solutions",
         "desc": "Professional, mobile-friendly websites for businesses in Malaysia, built by Adam in Johor Bahru. RM1,500 for up to 8 pages, or RM1,600 with a website chatbot, with a free domain for the first year and free Google Business Profile setup.",
         "wa_text": "Hi Adam, I'm interested in a website for my business.",
         "wa_tuition": "Hi Adam, I'd like to know more about the tuition centre website pilot.",
         "blog_note": ""},
  "bm": {"path": "/bm/", "html_lang": "ms-MY", "hreflang": "ms", "og_locale": "ms_MY",
         "title": "Laman Web Profesional untuk Perniagaan di Malaysia | Ace Digital Solutions",
         "desc": "Laman web profesional dan mesra telefon untuk perniagaan di Malaysia, dibina oleh Adam di Johor Bahru. RM1,500 untuk sehingga 8 halaman, atau RM1,600 bersama chatbot laman web, dengan domain percuma untuk tahun pertama dan persediaan Google Business Profile percuma.",
         "wa_text": "Hai Adam, saya berminat dengan laman web untuk perniagaan saya.",
         "wa_tuition": "Hai Adam, saya ingin tahu lebih lanjut tentang perintis laman web untuk pusat tuisyen.",
         "blog_note": "Artikel blog buat masa ini dalam Bahasa Inggeris sahaja."},
  "zh": {"path": "/zh/", "html_lang": "zh-Hans", "hreflang": "zh-Hans", "og_locale": "zh_CN",
         "title": "为马来西亚企业打造的专业网站 | Ace Digital Solutions",
         "desc": "由新山的 Adam 亲自为马来西亚企业打造专业、适合手机浏览的网站。RM1,500，最多 8 个页面（加上网站聊天机器人 RM1,600），首年域名免费，并免费设置 Google 商家资料（Google Business Profile）。",
         "wa_text": "Adam 你好，我想了解为我的生意制作网站。",
         "wa_tuition": "Adam 你好，我想了解补习中心网站试行配套。",
         "blog_note": "博客文章目前只有英文版。"},
}
# Text used by the page script through a variable rather than L("…"), so it is not found automatically
EXTRA_JS_KEYS = ["Additional page or section", "Additional language", "Enquiry & booking request form",
                 "Listings setup (Apple Maps + Foursquare)"]

norm = lambda t: re.sub(r"\s+", " ", t).strip()
WORDY = re.compile(r"[A-Za-z]{2,}")

def tr_text(t, D, missing):
    key = norm(t)
    if not key or not WORDY.search(key) or "{{" in key:
        return t
    if key in D:
        lead = t[:len(t) - len(t.lstrip())]; trail = t[len(t.rstrip()):]
        return lead + D[key] + trail
    missing.add(key)
    return t

def tr_tag(tag, D, missing):
    def rep(m):
        val = m.group(2)
        key = norm(H.unescape(val))
        if key in D:
            return f'{m.group(1)}="{H.escape(D[key], quote=True)}"'
        if WORDY.search(key):
            missing.add(key)
        return m.group(0)
    return re.sub(r'\b(placeholder|aria-label|title|alt)="([^"]*)"', rep, tag)

def translate_html(s, D, missing):
    cut = s.index("</style>")                     # everything before the styles is head material built separately
    return s[:cut] + _translate_body(s[cut:], D, missing)

def _translate_body(s, D, missing):
    out, pos = [], 0
    for m in re.finditer(r"<script\b[^>]*>.*?</script>|<style\b[^>]*>.*?</style>|<svg\b.*?</svg>|<!--.*?-->", s, re.S):
        out.append(tr_chunk(s[pos:m.start()], D, missing)); out.append(m.group(0)); pos = m.end()
    out.append(tr_chunk(s[pos:], D, missing))
    return "".join(out)

def tr_chunk(c, D, missing):
    parts = re.split(r"(<[^>]+>)", c)
    for i, p in enumerate(parts):
        parts[i] = tr_tag(p, D, missing) if p.startswith("<") else tr_text(p, D, missing)
    return "".join(parts)

def js_keys(s):
    keys = set(EXTRA_JS_KEYS)
    for m in re.finditer(r'\b[LC]\("((?:[^"\\]|\\.)*)"', s):
        keys.add(json.loads('"' + m.group(1) + '"'))
    keys.discard("English text")                  # appears only in a code comment
    return keys

def wa_link(text):
    from urllib.parse import quote
    return f"https://wa.me/{WA_NUMBER}?text=" + quote(text)

def faq_jsonld(s):
    items = []
    for q, a in re.findall(r"<details><summary>(.*?)</summary><p>(.*?)</p></details>", s, re.S):
        strip = lambda x: norm(H.unescape(re.sub(r"<[^>]+>", "", x)))
        items.append({"@type": "Question", "name": strip(q), "acceptedAnswer": {"@type": "Answer", "text": strip(a)}})
    return {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": items}

def head_for(code, cfg):
    url = DOMAIN + cfg["path"]
    alts = "".join(f'<link rel="alternate" hreflang="{c["hreflang"]}" href="{DOMAIN}{c["path"]}">\n' for c in LANGS.values())
    alts += f'<link rel="alternate" hreflang="x-default" href="{DOMAIN}/">\n'
    t, d = H.escape(cfg["title"]), H.escape(cfg["desc"], quote=True)
    org = {"@context": "https://schema.org", "@type": "ProfessionalService", "name": "Ace Digital Solutions",
           "url": url, "image": DOMAIN + "/og-image.jpg", "logo": DOMAIN + "/og-image.jpg", "sameAs": [FB],
           "description": cfg["desc"], "email": "adamteokokwei@gmail.com", "telephone": "+60102641824",
           "priceRange": "RM1,500–RM1,600", "inLanguage": cfg["html_lang"],
           "founder": {"@type": "Person", "name": "Adam", "jobTitle": "Freelance Web Designer"},
           "address": {"@type": "PostalAddress", "addressLocality": "Johor Bahru", "addressRegion": "Johor", "addressCountry": "MY"},
           "areaServed": {"@type": "Country", "name": "Malaysia"},
           "serviceType": "Website design for businesses", "availableLanguage": ["English", "Malay", "Chinese"],
           "hasOfferCatalog": {"@type": "OfferCatalog", "name": "Website services", "itemListElement": [
             {"@type": "Offer", "name": "Professional website (up to 8 pages or sections)", "price": "1500", "priceCurrency": "MYR"},
            {"@type": "Offer", "name": "Professional website with a website chatbot (up to 8 pages or sections)", "price": "1600", "priceCurrency": "MYR"},
              {"@type": "Offer", "name": "Website add-on, bundled with the website or another add-on", "price": "400", "priceCurrency": "MYR"},
             {"@type": "Offer", "name": "Website add-on on its own", "price": "500", "priceCurrency": "MYR"},
             {"@type": "Offer", "name": "Website Care (hosting and domain renewal included)", "price": "199", "priceCurrency": "MYR",
              "priceSpecification": {"@type": "UnitPriceSpecification", "price": "199", "priceCurrency": "MYR", "unitText": "MONTH"}}]}}
    return (f"<title>{t}</title>\n<meta name=\"description\" content=\"{d}\">\n"
            '<meta name="robots" content="index, follow, max-image-preview:large">\n'
            '<meta name="author" content="Adam, Ace Digital Solutions">\n<meta name="theme-color" content="#0B1220">\n'
            f'<link rel="canonical" href="{url}">\n{alts}'
            f'<meta property="og:type" content="website">\n<meta property="og:site_name" content="Ace Digital Solutions">\n'
            f'<meta property="og:url" content="{url}">\n<meta property="og:title" content="{t}">\n<meta property="og:description" content="{d}">\n'
            f'<meta property="og:locale" content="{cfg["og_locale"]}">\n'
            + "".join(f'<meta property="og:locale:alternate" content="{c["og_locale"]}">\n' for k, c in LANGS.items() if k != code) +
            f'<meta property="og:image" content="{DOMAIN}/og-image.jpg">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n'
            '<meta property="og:image:alt" content="Ace Digital Solutions: professional websites for businesses in Malaysia, from RM1,500">\n'
            f'<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:title" content="{t}">\n<meta name="twitter:description" content="{d}">\n'
            f'<meta name="twitter:image" content="{DOMAIN}/og-image.jpg">\n'
            f'<script type="application/ld+json">{json.dumps(org, ensure_ascii=False)}</script>\n')

def preview_paths(page, root):
    """Relative links so the files can be opened straight from a folder (no web server)."""
    for a, b in [('"/img/', '"' + root + 'img/'), ('href="/bm/"', 'href="' + root + 'bm/index.html"'),
                 ('href="/zh/"', 'href="' + root + 'zh/index.html"'), ('href="/privacy/"', 'href="' + root + 'privacy/index.html"'),
                 ('"/demos/jb-plumbing/"', '"' + root + 'demos/jb-plumbing/index.html"'), ('href="/"', 'href="' + root + 'index.html"')]:
        page = page.replace(a, b)
    return page

def build(show_missing=False, preview_dir=None):
    src = open(SRC, encoding="utf-8").read()
    keys = js_keys(src)
    global ALL_JS
    ALL_JS = {}
    for c in ("bm", "zh"):
        Dc = json.load(open(os.path.join(ROOT, "src", "i18n", c + ".json"), encoding="utf-8"))
        ALL_JS[c] = {k: Dc[k] for k in sorted(keys) if k in Dc}
    report = {}
    for code, cfg in LANGS.items():
        s = src
        D = {}
        if code != "en":
            D = json.load(open(os.path.join(ROOT, "src", "i18n", code + ".json"), encoding="utf-8"))
        for c in LANGS:
            s = s.replace("{{ON_%s}}" % c, ' class="on" aria-current="page"' if c == code else "")
        missing = set()
        if code != "en":
            s = translate_html(s, D, missing)
            js = {k: D[k] for k in sorted(keys) if k in D}
            missing |= {k for k in keys if k not in D}
            s = s.replace('/*LANG*/"en"/*/LANG*/', '/*LANG*/"%s"/*/LANG*/' % code)
            s = s.replace("/*I18N*/{}/*/I18N*/", "/*I18N*/" + json.dumps(js, ensure_ascii=False).replace("</", "<\\/") + "/*/I18N*/")
        s = s.replace("{{BLOG_NOTE}}", cfg["blog_note"])
        # Blog: keep only the posts written in this page's language
        s = s.replace("<!--BLOG_TRANSLATIONS-->", open(os.path.join(ROOT, "src", "blog-translations.html"), encoding="utf-8").read())
        s = re.sub(r'<script type="text/plain" class="blog-post"[^>]*data-lang="(\w+)"[^>]*>.*?</script>\n?',
                   lambda m: m.group(0) if m.group(1) == code else "", s, flags=re.S)
        s = re.sub(r"<!-- (Bahasa Melayu|Simplified Chinese) blog posts[^>]*-->\n?", "", s)
        s = s.replace("/*I18N_ALL*/{}/*/I18N_ALL*/", "/*I18N_ALL*/" + json.dumps(ALL_JS, ensure_ascii=False).replace("</", "<\\/") + "/*/I18N_ALL*/")
        s = s.replace("{{WA_TUITION}}", H.escape(wa_link(cfg["wa_tuition"]), quote=True))
        s = s.replace("{{WA}}", H.escape(wa_link(cfg["wa_text"]), quote=True))
        head = head_for(code, cfg)
        head += f'<script type="application/ld+json">{json.dumps(faq_jsonld(s), ensure_ascii=False)}</script>\n'
        s = s.replace("<!--HEAD-->", head, 1)
        i = s.index("</style>") + len("</style>")
        page = ('<!doctype html>\n<html lang="%s">\n<head>\n<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' % cfg["html_lang"]
                + s[:i] + "\n</head>\n<body>\n" + s[i:] + "\n</body>\n</html>\n")
        assert "{{" not in page, re.findall(r"\{\{\w+\}\}", page)
        out = os.path.join(SITE, cfg["path"].strip("/"), "index.html")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        open(out, "w", encoding="utf-8").write(page)
        if preview_dir:
            pv = os.path.join(preview_dir, cfg["path"].strip("/"), "index.html")
            os.makedirs(os.path.dirname(pv), exist_ok=True)
            open(pv, "w", encoding="utf-8").write(preview_paths(page, "" if code == "en" else "../"))
        report[code] = sorted(missing)
    # Sitemap with language alternates
    alts = "".join(f'    <xhtml:link rel="alternate" hreflang="{c["hreflang"]}" href="{DOMAIN}{c["path"]}"/>\n' for c in LANGS.values())
    alts += f'    <xhtml:link rel="alternate" hreflang="x-default" href="{DOMAIN}/"/>\n'
    urls = "".join(f'  <url>\n    <loc>{DOMAIN}{c["path"]}</loc>\n{alts}  </url>\n' for c in LANGS.values())
    urls += f'  <url>\n    <loc>{DOMAIN}/privacy/</loc>\n  </url>\n'
    open(os.path.join(SITE, "sitemap.xml"), "w").write('<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' + urls + "</urlset>\n")
    for code, miss in report.items():
        if code == "en": continue
        print(f"{code}: {len(miss)} untranslated")
        if show_missing:
            for m in miss: print("   ", json.dumps(m, ensure_ascii=False))
    return report

if __name__ == "__main__":
    pv = sys.argv[sys.argv.index("--preview") + 1] if "--preview" in sys.argv else None
    build("--missing" in sys.argv, pv)
    if pv:  # copy the other files, with relative links for the extra pages
        import shutil
        for d in ["img", "demos"]:
            shutil.copytree(os.path.join(SITE, d), os.path.join(pv, d), dirs_exist_ok=True)
        for f in ["og-image.jpg", "robots.txt", "sitemap.xml"]:
            shutil.copy(os.path.join(SITE, f), pv)
        for rel, root in [("privacy/index.html", "../"), ("demos/jb-plumbing/index.html", "../../")]:
            src = open(os.path.join(SITE, rel), encoding="utf-8").read()
            os.makedirs(os.path.dirname(os.path.join(pv, rel)), exist_ok=True)
            open(os.path.join(pv, rel), "w", encoding="utf-8").write(preview_paths(src, root))
