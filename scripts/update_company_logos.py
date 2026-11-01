"""Import reviewed public logo URLs. No merchant or account data is accepted.

Run from the repository root. Add explicit aliases/URLs to company-logo-sources.json,
then run this importer and review the contact sheet/assets before committing.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'web/expense-report/company-logo-sources.json'
CATALOG = ROOT / 'web/expense-report/src/company-logos.json'
ASSETS = ROOT / 'src/bookiebot/reports/assets'
MAX_BYTES = 250_000


def validated_extension(data: bytes) -> str:
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'jpg'
    if data.startswith(b'\x00\x00\x01\x00'):
        return 'ico'
    # Logos are inert images. Reject executable SVG and all remote resources,
    # including CSS URLs and event attributes; do not silently sanitize a brand.
    root = ET.fromstring(data)
    if root.tag.split('}')[-1] != 'svg':
        raise ValueError('Not an image')
    for element in root.iter():
        tag = element.tag.split('}')[-1].lower()
        if tag not in {'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'polygon', 'polyline', 'line', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'title', 'desc', 'style', 'use', 'symbol'}:
            raise ValueError(f'Unsupported SVG element: {tag}')
        for key, value in element.attrib.items():
            key = key.split('}')[-1].lower()
            if key.startswith('on') or (key == 'href' and not value.startswith('#')):
                raise ValueError('Active/external SVG attribute')
    text = data.decode('utf-8') + ' ' + ''.join(root.itertext()) + ' ' + ' '.join(value for element in root.iter() for value in element.attrib.values())
    if re.search(r'@import|javascript:|<!ENTITY|<!DOCTYPE|url\(\s*[\"\']?(?!#)', text, re.I):
        raise ValueError('External SVG content')
    return 'svg'


def fetch(entry: dict) -> tuple[dict | None, str]:
    try:
        if not re.fullmatch(r'[a-z0-9-]+', entry['id']) or not entry['source'].startswith('https://'):
            raise ValueError('Invalid source')
        request = urllib.request.Request(entry['source'], headers={'User-Agent': 'Mozilla/5.0 BookieBotLogoImport/1.0'})
        with urllib.request.urlopen(request, timeout=20) as response:
            if not response.url.startswith('https://'):
                raise ValueError('Non-HTTPS redirect')
            data = response.read(MAX_BYTES + 1)
        if not data or len(data) > MAX_BYTES:
            raise ValueError('Empty or oversized image')
        extension = validated_extension(data)
        digest = hashlib.sha256(data).hexdigest()
        name = f"company-logo-{entry['id']}-{digest[:16]}.{extension}"
        (ASSETS / name).write_bytes(data)
        return {**entry, 'asset': name, 'sha256': digest}, ''
    except Exception as exc:
        return None, f"{entry['id']}: {type(exc).__name__}: {exc}"


def main() -> None:
    sources = json.loads(SOURCES.read_text())['sources']
    # Preserve an already-reviewed local image if its remote source is temporarily
    # unavailable. Never replace a valid logo with an HTML challenge or a blank.
    previous = {item['id']: item for item in json.loads(CATALOG.read_text())} if CATALOG.exists() else {}
    catalog = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        for entry, (result, error) in zip(sources, executor.map(fetch, sources)):
            if result:
                catalog.append(result)
            elif entry['id'] in previous:
                catalog.append(previous[entry['id']])
                print(f'Kept local: {error}')
            else:
                print(f'Generic fallback: {error}')
    catalog.sort(key=lambda item: item['id'])
    CATALOG.write_text(json.dumps(catalog, indent=2) + '\n')
    print(f'{len(catalog)} verified local images from {len(sources)} reviewed sources')


if __name__ == '__main__':
    main()
