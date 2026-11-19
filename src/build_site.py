#!/usr/bin/env python3
"""Builds the live site from one source file.

  src/index.src.html   the page (English), edited by hand
  src/i18n/bm.json     English text -> Bahasa Melayu
  src/i18n/zh.json     English text -> Simplified Chinese

Writes site/index.html (EN), site/bm/index.html (BM), site/zh/index.html (中文) and site/sitemap.xml.
Run:  python3 src/build_site.py          (add --missing to list text that has no translation yet)
"""
import json, os, re, sys, html as H
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # for csp.py

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src", "index.src.html")
SITE = os.path.join(ROOT, "site")
DOMAIN = "https://acedigitalsolutionsbiz.org"
WA_NUMBER = "60102641824"
FB = "https://www.facebook.com/profile.php?id=61595360692132"

LANGS = {
  "en": {"path": "/", "html_lang": "en-MY", "hreflang": "en", "og_locale": "en_MY",
         "title": "Business Process Automation Malaysia | Ace Digital Solutions",
         "desc": "Ace Digital Solutions helps businesses reduce manual work and human error with custom software, automation, AI, POS workflow redesign and system integration.",
         "wa_text": "Hi Adam, I'd like help with a business problem.",
         "blog_note": ""},
  "bm": {"path": "/bm/", "html_lang": "ms-MY", "hreflang": "ms", "og_locale": "ms_MY",
         "title": "Automasi Proses Perniagaan di Malaysia | Ace Digital Solutions",
         "desc": "Ace Digital Solutions membantu perniagaan mengurangkan kerja manual dan kesilapan manusia melalui perisian tersuai, automasi, AI, reka semula aliran kerja POS dan integrasi sistem.",
         "wa_text": "Hai Adam, saya perlukan bantuan untuk masalah perniagaan.",
         "blog_note": "Artikel blog buat masa ini dalam Bahasa Inggeris sahaja."},
  "zh": {"path": "/zh/", "html_lang": "zh-Hans", "hreflang": "zh-Hans", "og_locale": "zh_CN",
         "title": "马来西亚业务流程自动化 | Ace Digital Solutions",
         "desc": "Ace Digital Solutions 通过定制软件、自动化、AI、POS 流程重新设计与系统整合，帮助企业减少手工作业与人为错误。",
         "wa_text": "Adam 你好，我想咨询一个业务上的问题。",
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
    image_alt = {"en": "Ace Digital Solutions: business process automation, POS and custom software", "bm": "Ace Digital Solutions: automasi proses perniagaan, POS dan perisian tersuai", "zh": "Ace Digital Solutions：业务流程自动化、POS 与定制软件"}[code]
    t, d = H.escape(cfg["title"]), H.escape(cfg["desc"], quote=True)
    org = {"@context": "https://schema.org", "@type": "Organization", "@id": DOMAIN + "/#business", "name": "Ace Digital Solutions",
           "url": DOMAIN + "/", "image": DOMAIN + "/og-image.jpg", "logo": DOMAIN + "/og-image.jpg", "sameAs": [FB, "https://www.instagram.com/acedigitalsolutionsbiz/", "https://www.youtube.com/@AceDigitalSolutionsBiz"],
           "description": cfg["desc"], "email": "adamteokokwei@gmail.com", "telephone": "+60102641824",
           "founder": {"@type": "Person", "name": "Adam", "jobTitle": "Digital Solutions Consultant"},
           "address": {"@type": "PostalAddress", "addressLocality": "Johor Bahru", "addressRegion": "Johor", "addressCountry": "MY"},
           "areaServed": {"@type": "Country", "name": "Malaysia"},
           "contactPoint": {"@type": "ContactPoint", "contactType": "sales", "telephone": "+60102641824",
                            "availableLanguage": ["English", "Malay", "Chinese"]},
           "hasOfferCatalog": {"@type": "OfferCatalog", "name": "Business solutions", "itemListElement": [
             {"@type": "Offer", "name": "Simple automation", "price": "388", "priceCurrency": "MYR"},
             {"@type": "Offer", "name": "Website development (up to 8 pages or sections)", "price": "888", "priceCurrency": "MYR"},
             {"@type": "Offer", "name": "AI enquiry processing", "price": "888", "priceCurrency": "MYR"},
             {"@type": "Offer", "name": "Software and API integration", "price": "1288", "priceCurrency": "MYR"},
             {"@type": "Offer", "name": "POS workflow customisation", "price": "1888", "priceCurrency": "MYR"},
             {"@type": "Offer", "name": "Accounting workflow automation", "price": "1888", "priceCurrency": "MYR"},
             {"@type": "Offer", "name": "Custom POS development, setup (plus RM288/month for 24 months)", "price": "2888", "priceCurrency": "MYR"},
             {"@type": "Offer", "name": "Website add-on, bundled with the website or another add-on", "price": "400", "priceCurrency": "MYR"},
             {"@type": "Offer", "name": "Website upkeep, every 3 months", "price": "88", "priceCurrency": "MYR"}]}}
    service = {"@type": "Service", "@id": DOMAIN + "/#website-design",
               "name": "Business process optimisation and custom software", "serviceType": "Business process automation",
               "provider": {"@id": DOMAIN + "/#business"},
               "areaServed": {"@type": "Country", "name": "Malaysia"},
               "hasOfferCatalog": {"@id": DOMAIN + "/#website-services"}}
    org["hasOfferCatalog"]["@id"] = DOMAIN + "/#website-services"
    org.pop("@context")
    structured_data = {"@context": "https://schema.org", "@graph": [org, service]}
    return (f"<title>{t}</title>\n<meta name=\"description\" content=\"{d}\">\n"
            '<meta name="robots" content="index, follow, max-image-preview:large">\n'
            '<meta name="author" content="Adam, Ace Digital Solutions">\n<meta name="theme-color" content="#0B1220">\n'
            f'<link rel="canonical" href="{url}">\n{alts}'
            f'<meta property="og:type" content="website">\n<meta property="og:site_name" content="Ace Digital Solutions">\n'
            f'<meta property="og:url" content="{url}">\n<meta property="og:title" content="{t}">\n<meta property="og:description" content="{d}">\n'
            f'<meta property="og:locale" content="{cfg["og_locale"]}">\n'
            + "".join(f'<meta property="og:locale:alternate" content="{c["og_locale"]}">\n' for k, c in LANGS.items() if k != code) +
            f'<meta property="og:image" content="{DOMAIN}/og-image.jpg">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n'
            f'<meta property="og:image:alt" content="{image_alt}">\n'
            f'<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:title" content="{t}">\n<meta name="twitter:description" content="{d}">\n'
            f'<meta name="twitter:image" content="{DOMAIN}/og-image.jpg">\n'
            f'<script type="application/ld+json">{json.dumps(structured_data, ensure_ascii=False)}</script>\n')

def preview_paths(page, root):
    """Relative links so the files can be opened straight from a folder (no web server)."""
    for a, b in [('"/img/', '"' + root + 'img/'), ('href="/bm/"', 'href="' + root + 'bm/index.html"'),
                 ('href="/zh/"', 'href="' + root + 'zh/index.html"'), ('href="/privacy/"', 'href="' + root + 'privacy/index.html"'),
                 ('"/demos/jb-plumbing/"', '"' + root + 'demos/jb-plumbing/index.html"'),
                 ('"/demos/skudai-tuition/"', '"' + root + 'demos/skudai-tuition/index.html"'), ('href="/#work"', 'href="' + root + 'index.html#work"'),
                 ('href="/"', 'href="' + root + 'index.html"')]:
        page = page.replace(a, b)
    return page

def build(show_missing=False, preview_dir=None, form_only=False):
    src = open(SRC, encoding="utf-8").read()
    if form_only:
        src = src.replace('const CHAT_API = "https://ace-chat.adamteokokwei.workers.dev/chat";', 'const CHAT_API = "";')
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
        s = s.replace("{{WA}}", H.escape(wa_link(cfg["wa_text"]), quote=True))
        head = head_for(code, cfg)
        head += f'<script type="application/ld+json">{json.dumps(faq_jsonld(s), ensure_ascii=False)}</script>\n'
        s = s.replace("<!--HEAD-->", head, 1)
        i = s.index("</style>") + len("</style>")
        page = ('<!doctype html>\n<html lang="%s">\n<head>\n<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' % cfg["html_lang"]
                + s[:i] + "\n</head>\n<body>\n" + s[i:] + "\n</body>\n</html>\n")
        assert "{{" not in page, re.findall(r"\{\{\w+\}\}", page)
        page = page.replace('href="#articles"', f'href="{cfg["path"]}articles/"').replace('href="#about"', f'href="{cfg["path"]}about/"').replace('href="#websites"', f'href="{cfg["path"]}websites/"')
        out = os.path.join(SITE, cfg["path"].strip("/"), "index.html")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        if code == "zh":  # Chinese needs no space after full-width punctuation
            page = re.sub(r"([，。！？])<span> ", r"\1<span>", page)
        open(out, "w", encoding="utf-8").write(page)
        if preview_dir:
            pv = os.path.join(preview_dir, cfg["path"].strip("/"), "index.html")
            os.makedirs(os.path.dirname(pv), exist_ok=True)
            open(pv, "w", encoding="utf-8").write(preview_paths(page, "" if code == "en" else "../"))
        report[code] = sorted(missing)
    # Publish existing articles as ordinary HTML pages before hashing scripts.
    import seo_pages
    seo_routes = seo_pages.build(ROOT, LANGS)
    # Sitemap with language alternates
    alts = "".join(f'    <xhtml:link rel="alternate" hreflang="{c["hreflang"]}" href="{DOMAIN}{c["path"]}"/>\n' for c in LANGS.values())
    alts += f'    <xhtml:link rel="alternate" hreflang="x-default" href="{DOMAIN}/"/>\n'
    urls = "".join(f'  <url>\n    <loc>{DOMAIN}{c["path"]}</loc>\n{alts}  </url>\n' for c in LANGS.values())
    urls += f'  <url>\n    <loc>{DOMAIN}/privacy/</loc>\n  </url>\n'
    for page_url, variants in seo_routes:
        alt_xml = "".join(f'    <xhtml:link rel="alternate" hreflang="{lang}" href="{href}"/>\n' for lang, href in variants)
        urls += f"  <url>\n    <loc>{page_url}</loc>\n{alt_xml}  </url>\n"
    # Content Security Policy (hashes of every inline script) -> site/_headers
    import csp as _csp
    _name, _ = _csp.write_headers(SITE, ["https://ace-wa-enquiry.adamteokokwei.workers.dev", "https://ace-chat.adamteokokwei.workers.dev"])
    print("security headers:", _name, "written to site/_headers")
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
    build("--missing" in sys.argv, pv, "--form-only" in sys.argv)
    if pv:  # copy the other files, with relative links for the extra pages
        import shutil
        for d in ["img", "demos"]:
            shutil.copytree(os.path.join(SITE, d), os.path.join(pv, d), dirs_exist_ok=True)
        for f in ["og-image.jpg", "robots.txt", "sitemap.xml"]:
            shutil.copy(os.path.join(SITE, f), pv)
        for rel, root in [("privacy/index.html", "../"), ("demos/jb-plumbing/index.html", "../../"), ("demos/skudai-tuition/index.html", "../../")]:
            src = open(os.path.join(SITE, rel), encoding="utf-8").read()
            os.makedirs(os.path.dirname(os.path.join(pv, rel)), exist_ok=True)
            open(os.path.join(pv, rel), "w", encoding="utf-8").write(preview_paths(src, root))
