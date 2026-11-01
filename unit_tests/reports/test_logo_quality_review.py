"""Integrity of curated candidates, without changing the production logo catalog."""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[2]
REVIEW = ROOT / 'docs/logo-review'


def read(name):
    return json.loads((REVIEW / name).read_text())


def test_review_covers_every_logo_and_retains_the_production_original():
    original = json.loads((ROOT / 'web/expense-report/src/company-logos.json').read_text())
    recipes = read('recipes.json')
    audit = read('audit.json')
    expected = {item['id'] for item in original}
    assert len(recipes['items']) == len(expected) == 89
    assert {item['id'] for item in recipes['items']} == expected
    assert {item['id'] for item in audit['items']} == expected
    by_id = {item['id']: item for item in original}
    for item in recipes['items']:
        assert item['original'] == 'src/bookiebot/reports/assets/' + by_id[item['id']]['asset']
        assert item['review'] == 'pending'
        assert .5 <= item['fill'] <= 1
        assert len(item['background']) == 7
        data = (ROOT / item['source']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == item['sourceSha256']


def test_every_candidate_is_a_small_content_addressed_256px_png():
    assets = set()
    for item in read('audit.json')['items']:
        path = REVIEW / item['asset']
        assets.add(path)
        data = path.read_bytes()
        assert data.startswith(b'\x89PNG\r\n\x1a\n')
        assert struct.unpack('>II', data[16:24]) == (256, 256)
        digest = hashlib.sha256(data).hexdigest()
        assert digest == item['sha256']
        assert digest[:16] in path.name
        assert len(data) < 100_000
        assert item['crop'][2] > 0 and item['crop'][3] > 0
    assert assets <= set((REVIEW / 'assets').glob('*.png'))


def test_ai_candidates_have_complete_versioned_provenance():
    ai = read('ai-restorations.json')
    candidates = {item['id']: item for item in read('recipes.json')['items'] if item['ai']}
    assert {item['id'] for item in ai['items']} == set(candidates)
    assert ai['tool'] == 'built-in image_gen.imagegen'
    for item in ai['items']:
        assert item['output'] == candidates[item['id']]['source']
        assert item['prompt'] and item['references']
        assert item['outputSha256'] == candidates[item['id']]['sourceSha256']
        assert len(item['originalOutputSha256']) == 64
        for reference in item['references']:
            assert (ROOT / reference).is_file()


def test_native_sources_remain_inert_images_and_density_flags_are_honest():
    spec = importlib.util.spec_from_file_location('import_logos', ROOT / 'scripts/update_company_logos.py')
    importer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(importer)
    for path in (REVIEW / 'sources').glob('*.svg'):
        assert importer.validated_extension(path.read_bytes()) == 'svg'
    for item in read('audit.json')['items']:
        assert item['rasterBelow2x'] == (not item['source'].endswith('.svg') and min(item['sourceSize']) < 52)
    by_id = {item['id']: item for item in read('recipes.json')['items']}
    assert by_id['github']['fill'] == 1
    assert by_id['linkedin']['background'] == '#007ebb'
    assert by_id['railway']['source'].endswith('railway-mark.svg')
    assert by_id['railway']['background'] == '#13121c'
    assert by_id['chatgpt']['source'].endswith('chatgpt-mark.svg')
    assert by_id['brianjames']['method'] == 'Exact portfolio asset'


def test_exported_brand_edges_have_no_added_white_mat():
    by_id = {item['id']: item for item in read('audit.json')['items']}
    for id in ['github', 'linkedin', 'railway']:
        assert len(by_id[id]['edgeChecks']) >= 3
        for check in by_id[id]['edgeChecks']:
            expected = bytes.fromhex(check['color'][1:])
            assert check['actual'][3] == 255
            assert all(abs(a-b) <= 4 for a, b in zip(check['actual'], expected))
