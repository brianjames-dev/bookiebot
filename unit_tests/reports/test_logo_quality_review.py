"""Approved circle art stays pinned from review through production and imports."""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import pytest

ROOT = Path(__file__).resolve().parents[2]
REVIEW = ROOT / 'docs/logo-review'


def read(name):
    return json.loads((REVIEW / name).read_text())


def test_review_covers_every_logo_and_retains_its_original():
    original = json.loads((ROOT / 'web/expense-report/src/company-logos.json').read_text())
    recipes = read('recipes.json')
    audit = read('audit.json')
    expected = {item['id'] for item in original}
    assert len(recipes['items']) == len(expected) == 89
    assert {item['id'] for item in recipes['items']} == expected
    assert {item['id'] for item in audit['items']} == expected
    for item in recipes['items']:
        assert (ROOT / item['original']).is_file()
        assert item['review'] == 'approved'
        assert .5 <= item['fill'] <= 1
        assert len(item['background']) == 7
        data = (ROOT / item['source']).read_bytes()
        assert hashlib.sha256(data).hexdigest() == item['sourceSha256']


def importer_module():
    spec = importlib.util.spec_from_file_location('import_logos', ROOT / 'scripts/update_company_logos.py')
    importer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(importer)
    return importer


def test_production_uses_the_exact_approved_circles():
    catalog = json.loads((ROOT / 'web/expense-report/src/company-logos.json').read_text())
    audit = read('audit.json')
    assert audit['status'] == 'approved'
    by_id = {item['id']: item for item in audit['items']}
    for item in catalog:
        reviewed = by_id[item['id']]
        assert item['preparedCircle'] is True
        assert item['curation'] == 'docs/logo-review/audit.json'
        assert item['name'] == reviewed['name']
        assert item['sha256'] == reviewed['sha256']
        assert (ROOT / 'src/bookiebot/reports/assets' / item['asset']).read_bytes() == (REVIEW / reviewed['asset']).read_bytes()


def test_routine_import_keeps_curated_art_without_a_network_request(monkeypatch):
    importer = importer_module()
    monkeypatch.setattr(importer.urllib.request, 'urlopen', lambda *args, **kwargs: pytest.fail('Curated art must not be fetched again'))
    catalog = json.loads(importer.CATALOG.read_text())
    sources = {item['id']: item for item in json.loads(importer.SOURCES.read_text())['sources']}
    for item in catalog:
        entry = {**sources[item['id']], 'aliases': [*item['aliases'], 'Extra explicit alias']}
        result, error = importer.refresh(entry, item)
        assert error == '' and result['asset'] == item['asset']
        assert result['preparedCircle'] and result['sha256'] == item['sha256']
        assert result['aliases'] == entry['aliases']


def test_damaged_curated_image_fails_instead_of_fetching_a_raw_favicon(monkeypatch, tmp_path):
    importer = importer_module()
    monkeypatch.setattr(importer, 'ASSETS', tmp_path)
    item = json.loads(importer.CATALOG.read_text())[0]
    (tmp_path / item['asset']).write_bytes(b'broken image')
    monkeypatch.setattr(importer, 'fetch', lambda *args: pytest.fail('Do not undo the reviewed artwork'))
    with pytest.raises(ValueError, match='Invalid prepared circle'):
        importer.refresh(item, item)


def test_new_uncurated_entries_still_use_the_original_importer(monkeypatch):
    importer = importer_module()
    entry = {'id': 'new-logo', 'source': 'https://example.com/logo.png'}
    monkeypatch.setattr(importer, 'fetch', lambda value: (value, 'new image'))
    assert importer.refresh(entry, None) == (entry, 'new image')


def test_unapproved_or_tampered_review_cannot_publish_a_partial_catalog(monkeypatch, tmp_path):
    importer = importer_module()
    audit = read('audit.json')
    review = tmp_path / 'review'
    review.mkdir()
    monkeypatch.setattr(importer, 'REVIEW', review)
    catalog = tmp_path / 'catalog.json'
    catalog.write_text('unchanged')
    monkeypatch.setattr(importer, 'CATALOG', catalog)
    for status in ('review-candidates', 'approved'):
        audit['status'] = status
        audit['items'][0]['asset'] = '../not-a-reviewed-image.png'
        (review / 'audit.json').write_text(json.dumps(audit))
        with pytest.raises(ValueError):
            importer.promote_reviewed()
        assert catalog.read_text() == 'unchanged'


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
    for id in ['github', 'linkedin', 'railway', 'nordvpn', 'paramount-plus']:
        assert len(by_id[id]['edgeChecks']) >= 3
        for check in by_id[id]['edgeChecks']:
            expected = bytes.fromhex(check['color'][1:])
            assert check['actual'][3] == 255
            assert all(abs(a-b) <= 4 for a, b in zip(check['actual'], expected))


def test_flagged_revisions_keep_rendered_marks_visible_and_in_the_circle():
    revised = {item['id']: item for item in read('audit.json')['items'] if item.get('revision') == 2}
    assert set(revised) == {'github', 'liberty-mutual', 'disney-plus', 'nordvpn',
                            'paramount-plus', 'railway', 'sling', 'steam', 'todoist',
                            'xbox', 'waste-management', 'youtube', 'youtube-tv'}
    for item in revised.values():
        assert item['renderVersion'] == 2
        box = item['paintedBounds']
        assert box['count'] > 256 * 256 * .003
        assert abs((box['left'] + box['right']) / 2 - 128) <= 256 * .23
        assert abs((box['top'] + box['bottom']) / 2 - 128) <= 256 * .23
    assert revised['youtube']['name'] == 'YouTube Premium'
    assert revised['youtube-tv']['background'] == '#ffffff'
    assert revised['youtube-tv']['source'] == revised['youtube-tv']['original']
    assert revised['todoist']['background'] == '#e44332'
    assert revised['railway']['fill'] == 1
    assert all(check['color'] == '#ffffff' for check in revised['railway']['edgeChecks'][:3])
    assert revised['waste-management']['source'].endswith('waste-management-v2-mark.svg')
    # Their brand circles extend beyond the painted mountain silhouettes. Alpha
    # trimming would center the shorter silhouette and leave the mark too low.
    for id in ['nordvpn', 'paramount-plus']:
        assert revised[id]['trim'] is False
        assert revised[id]['offset'] == [0, 0]
    xbox = (ROOT / revised['xbox']['source']).read_bytes()
    assert struct.unpack('>II', xbox[16:24]) == (2000, 2000)
