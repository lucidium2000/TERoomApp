#!/usr/bin/env python3
"""Builds vendor/logos/ and js/logos.js: logos for the providers and apps that
show up in Internet Insights, so the list and cards show a real mark instead
of initials.

Two sources, both fetched once here (the app never fetches logos at runtime):
  - Simple Icons (simpleicons.org, CC0): crisp single-colour brand marks,
    coloured with each brand's own colour (white when the brand colour is too
    dark to read on the app's dark tiles).
  - The company's own site icon (apple-touch-icon / icon links, else Google's
    favicon service at 128 px), for names Simple Icons doesn't carry.

Usage: python3 scripts/build-logos.py   (re-run after adding to CATALOG)
"""
import base64, colorsys, io, json, os, re, sys, urllib.request
from html.parser import HTMLParser
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'vendor', 'logos')
SI = 'https://cdn.jsdelivr.net/npm/simple-icons@13.21.0'
UA = {'User-Agent': 'Mozilla/5.0 (TERoomApp logo builder; github.com/lucidium2000/TERoomApp)'}

# (key, name pattern (JS regex, case-insensitive), source) - source is
# 'si:<slug>' for Simple Icons or 'site:<domain>'. First match wins, so more
# specific names go first.
CATALOG = [
    # Social / consumer apps
    ('x', r'^x$|twitter', 'si:x'),
    ('youtube', r'youtube', 'si:youtube'),
    ('spotify', r'spotify', 'si:spotify'),
    ('netflix', r'netflix', 'si:netflix'),
    ('instagram', r'instagram', 'si:instagram'),
    ('whatsapp', r'whatsapp', 'si:whatsapp'),
    ('facebook', r'facebook', 'si:facebook'),
    ('meta', r'\bmeta\b', 'si:meta'),
    ('discord', r'discord', 'si:discord'),
    ('twitch', r'twitch', 'si:twitch'),
    ('reddit', r'reddit', 'si:reddit'),
    ('tiktok', r'tiktok', 'si:tiktok'),
    ('snapchat', r'snapchat', 'si:snapchat'),
    ('linkedin', r'linkedin', 'si:linkedin'),
    ('apple', r'\bapple\b|icloud', 'si:apple'),
    ('paypal', r'paypal', 'si:paypal'),
    ('shopify', r'shopify', 'si:shopify'),
    ('stripe', r'stripe', 'si:stripe'),
    # Work apps
    ('webex', r'webex', 'si:webex'),
    ('zoom', r'\bzoom\b', 'si:zoom'),
    ('slack', r'slack', 'si:slack'),
    ('salesforce', r'salesforce', 'si:salesforce'),
    ('okta', r'\bokta\b', 'si:okta'),
    ('dropbox', r'dropbox', 'si:dropbox'),
    ('box', r'^box\b', 'si:box'),
    ('atlassian', r'atlassian|jira|confluence cloud', 'si:atlassian'),
    ('adobe', r'adobe', 'si:adobe'),
    ('github', r'github', 'si:github'),
    ('twilio', r'twilio', 'si:twilio'),
    ('sap', r'\bsap\b', 'si:sap'),
    ('oracle', r'oracle', 'si:oracle'),
    ('mimecast', r'mimecast', 'site:mimecast.com'),
    ('zscaler', r'zscaler', 'site:zscaler.com'),
    ('servicenow', r'servicenow', 'site:servicenow.com'),
    ('workday', r'workday', 'site:workday.com'),
    ('ringcentral', r'ringcentral', 'site:ringcentral.com'),
    # Cloud, CDN, security
    ('microsoft', r'microsoft|office ?365|azure|outlook|\bteams\b', 'site:microsoft.com'),
    ('google', r'google|gmail', 'si:google'),
    ('amazon', r'amazon|\baws\b', 'si:amazon'),
    ('cloudflare', r'cloudflare', 'si:cloudflare'),
    ('akamai', r'akamai|prolexic|linode', 'si:akamai'),
    ('fastly', r'fastly', 'si:fastly'),
    ('digitalocean', r'digitalocean', 'si:digitalocean'),
    ('alibaba', r'alibaba|aliyun', 'si:alibabacloud'),
    ('tencent', r'tencent', 'si:tencentqq'),
    ('ovh', r'\bovh', 'si:ovh'),
    ('hetzner', r'hetzner', 'si:hetzner'),
    ('equinix', r'equinix', 'site:equinix.com'),
    ('vercara', r'vercara|neustar|ultradns', 'site:vercara.com|digicert.com'),
    ('netscout', r'arbor|netscout', 'site:netscout.com'),
    ('imperva', r'imperva|incapsula', 'site:imperva.com'),
    ('edgio', r'edgio|edgecast|limelight', 'site:edg.io|edgio.net'),
    ('cisco', r'\bcisco\b|opendns|umbrella', 'si:cisco'),
    # Carriers and transit
    ('att', r'at&t|\batt\b|at and t', 'si:atandt'),
    ('verizon', r'verizon|mci\b|uunet', 'si:verizon'),
    ('lumen', r'lumen|level ?3|centurylink|qwest', 'si:lumen'),
    ('tmobile', r't-mobile|tmobile', 'si:tmobile'),
    ('vodafone', r'vodafone', 'si:vodafone'),
    ('orange', r'\borange\b|opentransit', 'si:orange'),
    ('bt', r'\bbt\b|british telecom', 'si:bt'),
    ('comcast', r'comcast|xfinity', 'site:comcastbusiness.com|comcast.com'),
    ('charter', r'charter|spectrum', 'site:spectrum.com'),
    ('cox', r'\bcox\b', 'site:cox.com'),
    ('colt', r'\bcolt\b', 'site:colt.net'),
    ('pccw', r'pccw', 'site:pccwglobal.com'),
    ('zayo', r'zayo', 'site:zayo.com'),
    ('cogent', r'cogent', 'site:cogentco.com|www.cogentco.com'),
    ('he', r'hurricane electric', 'site:he.net|bgp.he.net|tunnelbroker.net'),
    ('arelion', r'arelion|telia', 'site:arelion.com'),
    ('ntt', r'\bntt\b', 'site:ntt.com'),
    ('gtt', r'\bgtt\b', 'site:gtt.net'),
    ('telstra', r'telstra', 'site:telstra.com'),
    ('dtag', r'deutsche telekom|telekom', 'site:telekom.com'),
    ('telefonica', r'telef[oó]nica|telxius|movistar', 'site:telefonica.com'),
    ('sparkle', r'sparkle|telecom italia|\btim\b', 'site:tisparkle.com'),
    ('chinatelecom', r'china telecom', 'site:chinatelecomglobal.com|chinatelecom-h.com|ctamericas.com'),
    ('chinaunicom', r'china unicom', 'site:chinaunicomglobal.com|chinaunicom.com.hk|chinaunicom.cn'),
    ('singtel', r'singtel', 'site:singtel.com|www.singtel.com'),
    ('kddi', r'kddi', 'site:kddi.com|www.kddi.com|global.kddi.com'),
    ('softbank', r'softbank', 'site:softbank.jp'),
    ('airtel', r'airtel|bharti', 'site:airtel.in'),
    ('jio', r'\bjio\b|reliance', 'site:jio.com'),
    ('frontier', r'frontier', 'site:frontier.com'),
    ('windstream', r'windstream', 'site:windstream.com'),
    ('liberty', r'liberty global', 'site:libertyglobal.com|www.libertyglobal.com'),
    ('confluence', r'confluence networks', 'site:confluence-networks.com|www.confluence-networks.com'),
    ('megaport', r'megaport', 'site:megaport.com'),
    ('seabone', r'seabone', 'site:tisparkle.com'),
    ('telmex', r'telmex|uninet', 'site:telmex.com'),
    ('claro', r'\bclaro\b|am[eé]rica m[oó]vil|embratel', 'site:claro.com.br|claro.com.co'),
    ('rogers', r'\brogers\b', 'site:rogers.com'),
    ('bell', r'\bbell canada\b|\bbell\b', 'site:bell.ca'),
    ('telus', r'telus', 'site:telus.com'),
    ('shaw', r'\bshaw\b', 'site:shaw.ca'),
    ('optus', r'optus', 'site:optus.com.au'),
    ('swisscom', r'swisscom', 'site:swisscom.ch'),
    ('kpn', r'\bkpn\b', 'site:kpn.com'),
    ('proximus', r'proximus', 'site:proximus.be'),
    ('telenor', r'telenor', 'site:telenor.com'),
    ('turkcell', r'turkcell', 'site:turkcell.com.tr'),
    ('etisalat', r'etisalat|\be&\b', 'site:etisalat.ae|eand.com'),
    ('stc', r'saudi telecom|\bstc\b', 'site:stc.com.sa'),
    ('iij', r'\biij\b|internet initiative japan', 'site:iij.ad.jp'),
    ('hkt', r'\bhkt\b|hong kong telecom', 'site:hkt.com'),
    ('globe', r'globe telecom', 'site:globe.com.ph'),
    ('pldt', r'pldt', 'site:pldt.com'),
    ('rostelecom', r'rostelecom', 'site:rostelecom.ru'),
]


def get(url, tries=1):
    """Fetch with curl (works whatever Python's certificate setup is)."""
    import subprocess, tempfile
    with tempfile.NamedTemporaryFile() as f:
        r = subprocess.run(['curl', '-sL', '--max-time', '20', '-A', UA['User-Agent'], '-o', f.name,
                            '-w', '%{http_code}\t%{content_type}\t%{url_effective}', url], capture_output=True, text=True)
        code, ctype, final = (r.stdout.split('\t') + ['', '', ''])[:3]
        if r.returncode or not code.startswith('2'):
            raise IOError(f'{url}: HTTP {code or r.returncode}')
        return open(f.name, 'rb').read(), ctype, final


def readable(hexc):
    """The brand colour, or white if it's too dark to read on a dark tile."""
    r, g, b = (int(hexc[i:i + 2], 16) / 255 for i in (0, 2, 4))
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return '#' + hexc if lum > 0.16 else '#ffffff'


class IconLinks(HTMLParser):
    def __init__(self):
        super().__init__(); self.links = []
    def handle_starttag(self, tag, a):
        if tag != 'link': return
        a = dict(a); rel = (a.get('rel') or '').lower()
        if 'icon' in rel and a.get('href'):
            m = re.search(r'(\d+)x\1', a.get('sizes') or '')
            self.links.append((int(m.group(1)) if m else (180 if 'apple' in rel else 32), a['href']))


def site_icon(domain):
    """The best square icon a site offers, as a 96 px PNG (bytes) or None."""
    cands = []
    try:
        html, _, final = get(f'https://{domain}/')
        p = IconLinks(); p.feed(html.decode('utf-8', 'ignore'))
        for size, href in p.links:
            cands.append((size, urllib.parse.urljoin(final, href)))
    except Exception:
        pass
    cands.append((180, f'https://{domain}/apple-touch-icon.png'))
    cands.append((128, f'https://www.google.com/s2/favicons?domain={domain}&sz=128'))
    best = None
    for size, url in sorted(cands, key=lambda c: -c[0]):
        if url.endswith('.svg'):
            continue
        try:
            data, ctype, _ = get(url)
            im = Image.open(io.BytesIO(data)); im.load()
            if im.width < 24:
                continue
            im = im.convert('RGBA')
            if not best or im.width > best.width:
                best = im
            if best.width >= 96:
                break
        except Exception:
            continue
    if not best:
        return None
    best = best.resize((96, 96), Image.LANCZOS) if best.width != 96 else best
    buf = io.BytesIO(); best.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def main():
    import urllib.parse  # noqa: F401 (used in site_icon)
    os.makedirs(OUT, exist_ok=True)
    data = json.loads(get(SI + '/_data/simple-icons.json')[0])
    icons = data['icons'] if isinstance(data, dict) else data
    hexes = {}
    for i in icons:
        slug = i.get('slug') or re.sub(r'[^a-z0-9]', '', i['title'].lower().replace('+', 'plus').replace('.', 'dot').replace('&', 'and'))
        hexes[slug] = i['hex']
    entries, done = [], set()
    for key, pattern, src in CATALOG:
        kind, ref = src.split(':', 1)
        file = None
        try:
            if kind == 'si':
                svg = get(f'{SI}/icons/{ref}.svg')[0].decode()
                col = readable(hexes.get(ref, 'FFFFFF'))
                svg = svg.replace('<svg ', f'<svg fill="{col}" ', 1)
                file = f'{key}.svg'
                if key not in done:
                    open(os.path.join(OUT, file), 'w').write(svg)
            else:
                png = None
                for dom in ref.split('|'):   # alternate domains, in order
                    png = site_icon(dom)
                    if png: break
                if png:
                    file = f'{key}.png'
                    if key not in done:
                        open(os.path.join(OUT, file), 'wb').write(png)
        except Exception as e:
            print('  !', key, e, file=sys.stderr)
        done.add(key)
        print(('ok ' if file else '-- ') + key, src)
        if file:
            entries.append({'re': pattern, 'file': file, 'mark': kind == 'si'})
    js = ('/* Logos for providers and apps (built by scripts/build-logos.py from\n'
          ' * Simple Icons, CC0, and the companies\' own site icons). First match wins.\n'
          ' * mark: a single-colour brand mark (drawn on a dark tile); else a full icon. */\n'
          '(function (root) {\n  \'use strict\';\n  const LIST = [\n'
          + ''.join(f"    [/{e['re'].replace('/', '\\/')}/i, '{e['file']}', {str(e['mark']).lower()}],\n" for e in entries)
          + '  ];\n  /** The logo for a name: { src, mark } or null. */\n'
          '  function find(name) {\n    const n = String(name || \'\').trim();\n'
          '    for (const [re, file, mark] of LIST) if (re.test(n)) return { src: \'vendor/logos/\' + file, mark };\n'
          '    return null;\n  }\n  root.Logos = { find };\n'
          '})(typeof window !== \'undefined\' ? window : globalThis);\n')
    open(os.path.join(ROOT, 'js', 'logos.js'), 'w').write(js)
    print(len(entries), 'logos')


if __name__ == '__main__':
    import urllib.parse
    main()
