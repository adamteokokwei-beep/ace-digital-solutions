"""Build crawlable pages from the existing translated content, without duplicating copy."""
import html
import json
import os
import re
import subprocess
from ordering_calculator import markup as ordering_calculator_markup
from html.parser import HTMLParser

DOMAIN = "https://acedigitalsolutionsbiz.org"


class Posts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.posts, self.current = [], None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and "blog-post" in attrs.get("class", "").split():
            self.current = {"attrs": attrs, "raw": ""}

    def handle_data(self, data):
        if self.current is not None:
            self.current["raw"] += data

    def handle_endtag(self, tag):
        if tag == "script" and self.current is not None:
            self.posts.append(self.current)
            self.current = None


def field(raw, key):
    match = re.search(r"^\s*\**" + re.escape(key) + r"\**\s*:[ \t]*(.*)$", raw, re.M | re.I)
    return match[1].replace("**", "").strip() if match else ""


def json_script(data):
    return '<script type="application/ld+json">' + json.dumps(data, ensure_ascii=False).replace("</", "<\\/") + '</script>'


def build(root, languages):
    site = os.path.join(root, "site")
    labels = {
        "en": ("Website Guides for Malaysian Businesses", "Practical guides to website costs, features and online enquiries for businesses in Malaysia.", "All articles", "By Adam, Ace Digital Solutions", "Ask Adam about your website"),
        "bm": ("Panduan Laman Web untuk Perniagaan Malaysia", "Panduan praktikal tentang kos laman web, ciri dan pertanyaan dalam talian untuk perniagaan di Malaysia.", "Semua artikel", "Oleh Adam, Ace Digital Solutions", "Tanya Adam tentang laman web anda"),
        "zh": ("马来西亚企业网站指南", "为马来西亚企业提供实用的网站费用、功能与网上询问指南。", "全部文章", "作者：Adam，Ace Digital Solutions", "向 Adam 咨询你的网站"),
    }
    records, routes = {}, []
    for code, cfg in languages.items():
        home = open(os.path.join(site, cfg["path"].strip("/"), "index.html"), encoding="utf-8").read()
        parser = Posts()
        parser.feed(home)
        images = json.loads(re.search(r'<script type="application/json" id="blog-images">(.*?)</script>', home, re.S)[1])
        posts = []
        for post in parser.posts:
            raw, attrs = post["raw"], post["attrs"]
            if "coming soon" in field(raw, "STATUS").lower():
                continue
            slug = attrs.get("data-id", "")
            if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
                raise ValueError("Published article requires a stable data-id")
            body = re.split(r"^\s*\**BODY\**\s*:[ \t]*", raw, maxsplit=1, flags=re.M | re.I)[1]
            cover = field(raw, "COVER")
            cover = images.get(cover[4:], "") if cover.startswith("img:") else cover
            posts.append({"slug": slug, "title": field(raw, "TITLE"), "seo_title": field(raw, "SEO TITLE"),
                          "description": field(raw, "META DESCRIPTION") or field(raw, "EXCERPT"),
                          "excerpt": field(raw, "EXCERPT"), "date": attrs.get("data-date", ""),
                          "body": body, "cover": cover, "alt": field(raw, "COVER ALT"),
                          "flat": "flat" in field(raw, "LAYOUT").lower()})
        rendered = json.loads(subprocess.run(["node", os.path.join(root, "src", "render_blog.cjs")],
            input=json.dumps({"images": images, "bodies": [p["body"] for p in posts]}), text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout)
        for post, body in zip(posts, rendered):
            post["body_html"] = body.replace("<p>ORDERING_COST_CALCULATOR</p>", ordering_calculator_markup(code))
        records[code] = (home, posts)

    def url(code, route):
        return DOMAIN + languages[code]["path"] + route

    def alternates(route):
        return [(cfg["hreflang"], url(code, route)) for code, cfg in languages.items()] + [("x-default", url("en", route))]

    for code, cfg in languages.items():
        home, posts = records[code]
        title, desc, back, author, cta = labels[code]
        header = re.search(r'<header\b.*?</header>', home, re.S)[0]
        footer = re.search(r'<footer\b.*?</footer>', home, re.S)[0]
        symbols = re.search(r'<svg[^>]*>\s*<symbol.*?</svg>', home, re.S)[0]
        styles = re.search(r'<style>.*?</style>', home, re.S)[0]
        resources = ''.join(re.findall(r'<link (?:rel="icon"|rel="preconnect"|rel="stylesheet")[^>]+>', home))

        def shell(route, page_title, description, content, structured, image="/og-image.jpg", image_alt="Ace Digital Solutions"):
            canonical = url(code, route)
            alternate_tags = ''.join(f'<link rel="alternate" hreflang="{lang}" href="{href}">' for lang, href in alternates(route))
            nav = header
            for other, ocfg in languages.items():
                nav = nav.replace('href="' + ocfg["path"] + '"', 'href="' + ocfg["path"] + route + '"')
            nav = nav.replace(' class="on"', '').replace(' aria-current="page"', '')
            def links(part):
                part = re.sub(r'href="#(post-)([a-z0-9-]+)"', lambda m: f'href="{cfg["path"]}articles/{m[2]}/"', part)
                return re.sub(r'(<a\b[^>]*?)href="#([\w-]+)"', lambda m: m[1] + 'href="' + cfg["path"] + ("articles/" if m[2] == "articles" else "about/" if m[2] == "about" else "#" + m[2]) + '"', part)
            nav, foot, content = links(nav), links(footer), links(content)
            image_url = image if image.startswith('https://') else DOMAIN + image
            menu = "document.querySelectorAll('.lang a[data-lang],.lang-m a[lang]').forEach(a=>a.addEventListener('click',()=>{try{localStorage.setItem('ace-lang',a.dataset.lang||(a.lang==='ms'?'bm':a.lang==='zh-Hans'?'zh':'en'));sessionStorage.setItem('ace-lang-checked','1');}catch(e){}}));const b=document.getElementById('burger'),h=document.getElementById('head');b.addEventListener('click',()=>{const open=h.classList.toggle('open');b.setAttribute('aria-expanded',String(open));});document.addEventListener('keydown',e=>{if(e.key==='Escape'){h.classList.remove('open');b.setAttribute('aria-expanded','false');}});"
            if route == 'articles/delivery-apps-vs-ordering-website-malaysia/':
                menu += open(os.path.join(root, 'src', 'ordering_calculator.js'), encoding='utf-8').read()
            out = f'''<!doctype html>
<html lang="{cfg['html_lang']}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{html.escape(page_title)}</title><meta name="description" content="{html.escape(description, quote=True)}">
<meta name="robots" content="index,follow,max-image-preview:large"><link rel="canonical" href="{canonical}">{alternate_tags}
<meta property="og:type" content="{'article' if route.startswith('articles/') and route != 'articles/' else 'website'}"><meta property="og:site_name" content="Ace Digital Solutions"><meta property="og:locale" content="{cfg['og_locale']}">
<meta property="og:title" content="{html.escape(page_title, quote=True)}"><meta property="og:description" content="{html.escape(description, quote=True)}"><meta property="og:url" content="{canonical}"><meta property="og:image" content="{image_url}"><meta property="og:image:alt" content="{html.escape(image_alt, quote=True)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{html.escape(page_title, quote=True)}"><meta name="twitter:description" content="{html.escape(description, quote=True)}"><meta name="twitter:image" content="{image_url}">
{resources}{styles}{json_script(structured)}</head><body>{symbols}{nav}<main>{content}</main>{foot}<script>{menu}</script></body></html>'''
            # Inline the existing sprite artwork so icons work before any script runs.
            icon_map = {m[0]: m[1] for m in re.findall(r'<symbol id="([^"]+)"[^>]*>(.*?)</symbol>', symbols, re.S)}
            out = re.sub(r'<svg([^>]*)><use href="#([^"]+)"\s*/></svg>', lambda m: '<svg' + m[1] + ' viewBox="0 0 24 24">' + icon_map[m[2]] + '</svg>' if m[2] in icon_map else m[0], out)
            dest = os.path.join(site, cfg["path"].strip('/'), route, 'index.html')
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            open(dest, 'w', encoding='utf-8').write(out)
            routes.append((canonical, alternates(route)))

        cards = ''.join(f'<a class="post-card" href="{cfg["path"]}articles/{p["slug"]}/"><div class="post-body"><h2>{html.escape(p["title"])}</h2><p>{html.escape(p["excerpt"])}</p><time datetime="{p["date"]}">{p["date"]}</time></div></a>' for p in posts)
        shell('articles/', title + ' | Ace Digital Solutions', desc,
              f'<section class="article-hero dark"><div class="wrap"><h1>{title}</h1><p class="lede">{desc}</p></div></section><section class="band"><div class="wrap blog-grid">{cards}</div></section>',
              {"@context": "https://schema.org", "@type": "CollectionPage", "name": title, "url": url(code, 'articles/'), "inLanguage": cfg['html_lang'],
               "mainEntity": {"@type": "ItemList", "itemListElement": [{"@type": "ListItem", "position": i + 1, "url": url(code, 'articles/' + p['slug'] + '/'), "name": p['title']} for i, p in enumerate(posts)]}})
        about = re.search(r'<div id="aboutView" hidden>(.*?)</div><!-- /aboutView -->', home, re.S)[1]
        about_title = {'en': 'About Adam, Web Designer in Malaysia', 'bm': 'Tentang Adam, Pereka Web di Malaysia', 'zh': '关于 Adam，马来西亚网页设计师'}[code]
        shell('about/', about_title + ' | Ace Digital Solutions', cfg['desc'], about,
              {"@context": "https://schema.org", "@type": "AboutPage", "url": url(code, 'about/'), "name": about_title, "inLanguage": cfg['html_lang'], "mainEntity": {"@type": "Person", "name": "Adam", "jobTitle": "Freelance Web Designer", "worksFor": {"@id": DOMAIN + '/#business'}}})
        for p in posts:
            route = 'articles/' + p['slug'] + '/'
            cover = f'<img src="{p["cover"]}" alt="{html.escape(p["alt"], quote=True)}" fetchpriority="high" style="width:100%;height:auto">' if p['cover'] else ''
            body = f'<section class="article-hero dark"><div class="wrap"><a class="back" href="{cfg["path"]}articles/">{back}</a><h1>{html.escape(p["title"])}</h1><p class="lede">{html.escape(p["excerpt"])}</p><p>{author} · <time datetime="{p["date"]}">{p["date"]}</time></p></div></section><section class="band"><div class="wrap">{cover}<article class="article rich {"flat" if p["flat"] else ""}">{p["body_html"]}<p class="article-enquiry"><a class="btn btn-primary" href="{cfg["path"]}#contact">{cta}</a></p></article></div></section>'
            shell(route, (p['seo_title'] or p['title']) + ' | Ace Digital Solutions', p['description'], body,
                  {"@context": "https://schema.org", "@type": "BlogPosting", "@id": url(code, route) + '#article', "url": url(code, route), "mainEntityOfPage": url(code, route), "headline": p['title'], "description": p['description'], "datePublished": p['date'], "inLanguage": cfg['html_lang'], "author": {"@type": "Person", "name": "Adam", "url": url(code, 'about/')}, "publisher": {"@type": "Organization", "@id": DOMAIN + '/#business', "name": "Ace Digital Solutions", "url": DOMAIN + '/'}, "image": DOMAIN + p['cover'] if p['cover'] else DOMAIN + '/og-image.jpg'}, p['cover'] or '/og-image.jpg', p['alt'])
    return routes
