from pathlib import Path
import hashlib
import json
import re
import subprocess
from xml.etree import ElementTree as ET

import pytest


def test_daily_spending_details_and_type_filter_runtime():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to execute presentation checks")
    subprocess.run(
        ["node", "unit_tests/reports/daily_spending_details_test.cjs"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )


def test_daily_transaction_identity_runtime():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to execute presentation checks")
    subprocess.run(["node", "unit_tests/reports/transaction_identity_test.cjs"], cwd=root,
                   check=True, capture_output=True, text=True)


def test_day_icon_previews_and_retained_disclosures_runtime():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to execute presentation checks")
    subprocess.run(["node", "unit_tests/reports/daily_transaction_preview_test.cjs"], cwd=root,
                   check=True, capture_output=True, text=True)


def test_approved_merchant_art_is_local_content_addressed_and_inert():
    root = Path(__file__).resolve().parents[2]
    catalog = json.loads((root / "web/expense-report/src/merchant-logos.json").read_text())
    provenance = json.loads((root / "docs/merchant-logos/catalog.json").read_text())["logos"]
    assert catalog == [{key: item[key] for key in catalog[0]} for item in provenance]
    catalog = provenance
    assert len(catalog) == len({item['id'] for item in catalog}) == 158
    aliases = {}
    for item in catalog:
        assert re.fullmatch(r'company-logo-merchant-[a-z0-9-]+-[a-f0-9]{16}\.(svg|png)', item['asset'])
        data = (root / 'src/bookiebot/reports/assets' / item['asset']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == item['sha256']
        assert item['sha256'][:16] in item['asset']
        if item['asset'].endswith('.png'):
            assert data.startswith(b'\x89PNG\r\n\x1a\n')
        else:
            tree = ET.fromstring(data)
            assert tree.tag.split('}')[-1] == 'svg'
            for node in tree.iter():
                assert node.tag.split('}')[-1].lower() in {'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'polygon', 'polyline', 'line', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'title', 'desc', 'style', 'use', 'symbol', 'text'}
                for key, value in node.attrib.items():
                    assert not key.lower().startswith('on')
                    if key.split('}')[-1].lower() == 'href':
                        assert value.startswith('#')
                    assert not re.search(r'url\(\s*[\"\']?(?!#)', value, re.I)
                if node.tag.split('}')[-1].lower() == 'style':
                    assert not re.search(r'@import|url\(\s*[\"\']?(?!#)', node.text or '', re.I)
        reviewed = {'amazon', 'usps', 'walmart', 'trader-joes', 'whole-foods', 'safeway', 'panda-express'}
        assert item['source'] and item['review'] == ('approved-2026-11-02' if item['id'] in reviewed else 'approved-2026-11-01')
        assert re.fullmatch(r'#[a-fA-F0-9]{6}', item['background'])
        assert 0 <= item['inset'] <= 10
        for alias in item['aliases']:
            key = re.sub(r'[^\w]+', ' ', alias.lower().replace('&', ' and ')).strip()
            assert key not in aliases or aliases[key] == item["id"], alias
            aliases[key] = item["id"]
