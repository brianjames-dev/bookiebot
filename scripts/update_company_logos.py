"""Import reviewed public logo URLs. No merchant or account data is accepted.

Run from the repository root. Add explicit aliases/URLs to company-logo-sources.json,
then run this importer and review the contact sheet/assets before committing.
Prepared circles are pinned: ordinary imports never replace approved artwork.
Use --promote-reviewed only after approving the offline review audit.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import struct
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'web/expense-report/company-logo-sources.json'
CATALOG = ROOT / 'web/expense-report/src/company-logos.json'
ASSETS = ROOT / 'src/bookiebot/reports/assets'
MAX_BYTES = 250_000
REVIEW = ROOT / 'docs/logo-review'


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


def circle_bytes(path: Path, digest: str) -> bytes:
    data = path.read_bytes()
    if (not re.fullmatch(r'[0-9a-f]{64}', digest)
            or hashlib.sha256(data).hexdigest() != digest
            or len(data) > MAX_BYTES
            or not data.startswith(b'\x89PNG\r\n\x1a\n')
            or len(data) < 24 or struct.unpack('>II', data[16:24]) != (256, 256)):
        raise ValueError(f'Invalid prepared circle: {path.name}')
    return data


def refresh(entry: dict, previous: dict | None) -> tuple[dict | None, str]:
    if previous and previous.get('preparedCircle'):
        # Fail visibly if a pinned file is damaged; fetching the raw favicon would
        # silently undo the approved background, optical framing or restoration.
        name = f"company-logo-{entry['id']}-{previous['sha256'][:16]}.png"
        if previous['asset'] != name:
            raise ValueError('Invalid prepared circle filename')
        circle_bytes(ASSETS / name, previous['sha256'])
        return {**entry, 'asset': name, 'sha256': previous['sha256'],
                'preparedCircle': True, 'curation': previous['curation']}, ''
    return fetch(entry)


def promote_reviewed() -> None:
    audit = json.loads((REVIEW / 'audit.json').read_text())
    sources = json.loads(SOURCES.read_text())
    by_id = {item['id']: item for item in sources['sources']}
    items = audit['items']
    if (audit['status'] != 'approved' or any(item['review'] != 'approved' for item in items)
            or len(items) != len(by_id) or {item['id'] for item in items} != set(by_id)):
        raise ValueError('Approve and audit the complete source catalog before promotion')
    prepared = []
    for item in items:
        expected = f"assets/{item['id']}-{item['sha256'][:16]}.png"
        if item['asset'] != expected:
            raise ValueError('Invalid review asset filename')
        data = circle_bytes(REVIEW / expected, item['sha256'])
        name = f"company-logo-{item['id']}-{item['sha256'][:16]}.png"
        by_id[item['id']]['name'] = item['name']
        prepared.append(({**by_id[item['id']], 'asset': name, 'sha256': item['sha256'],
                          'preparedCircle': True, 'curation': 'docs/logo-review/audit.json'}, data))
    # Validate every image before publishing any catalog change. Originals and
    # previous candidates remain available for provenance and explicit rollback.
    for entry, data in prepared:
        (ASSETS / entry['asset']).write_bytes(data)
    CATALOG.write_text(json.dumps(sorted((entry for entry, _ in prepared), key=lambda item: item['id']), indent=2) + '\n')
    SOURCES.write_text(json.dumps(sources, indent=2) + '\n')
    print(f'Promoted {len(prepared)} approved circle images')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--promote-reviewed', action='store_true', help='Publish the approved offline audit without network access')
    if parser.parse_args().promote_reviewed:
        promote_reviewed()
        return
    sources = json.loads(SOURCES.read_text())['sources']
    # Preserve an already-reviewed local image if its remote source is temporarily
    # unavailable. Never replace a valid logo with an HTML challenge or a blank.
    previous = {item['id']: item for item in json.loads(CATALOG.read_text())} if CATALOG.exists() else {}
    catalog = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        for entry, (result, error) in zip(sources, executor.map(refresh, sources, (previous.get(item['id']) for item in sources))):
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
