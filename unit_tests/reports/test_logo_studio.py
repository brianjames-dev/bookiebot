"""Logo review is offline, intake-gated, and bound to exact artwork revisions."""
import importlib.util
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw
import pytest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('logo_studio', ROOT / 'skills/bookiebot-logo-studio/scripts/studio.py')
studio = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(studio)


def prepared(path, color='navy'):
    image = Image.new('RGBA', (1024, 1024))
    ImageDraw.Draw(image).ellipse((0, 0, 1023, 1023), fill=color)
    image.resize((256, 256), Image.Resampling.BOX).save(path)
    return path


@pytest.fixture
def project(tmp_path):
    repo = tmp_path / 'repo'
    assets = repo / 'src/bookiebot/reports/assets'
    assets.mkdir(parents=True)
    prepared(assets / 'company.png')
    (assets / 'merchant.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path fill="red" d="M0 0h20v20H0z"/></svg>')
    for kind, file in [('company', 'company.png'), ('merchant', 'merchant.svg')]:
        row = dict(id='same', name=kind.title(), aliases=[kind + ' alias'], asset=file)
        if kind == 'merchant':
            row.update(background='#123456', inset=3)
        studio.write(repo / f'web/expense-report/src/{kind}-logos.json', [row])
        provenance = dict(row, sha256=studio.digest((assets / file).read_bytes()), sourceUrl='https://example.com/brand')
        studio.write(repo / ('docs/logo-review/audit.json' if kind == 'company' else 'docs/merchant-logos/catalog.json'),
                     {'items' if kind == 'company' else 'logos': [provenance]})
    return repo


def feedback(snapshot, *, ready=False, new=None):
    return dict(kind='bookiebot-logo-feedback', version=1, snapshotId=snapshot['snapshotId'],
                items=[dict(key='merchant:same', notes='Center this mark', ready=ready,
                            referenceUrls=['https://example.com/better.svg'])], newRequests=new or [])


def batch(project, tmp_path, *, ready=True):
    snapshot = studio.inventory(project)
    path = tmp_path / 'review/batch.json'
    studio.write(path, studio.intake(project, snapshot, feedback(snapshot, ready=ready)))
    return path


def candidate(project, tmp_path, path):
    return studio.stage(project, path, 'merchant:same', prepared(tmp_path / 'candidate.png'),
                        project / 'src/bookiebot/reports/assets/merchant.svg', 'reframe')


def test_inventory_uses_actual_framing_and_namespaces(project):
    snapshot = studio.inventory(project)
    company, merchant = snapshot['items']
    assert company['key'] == 'company:same' and merchant['key'] == 'merchant:same'
    assert (merchant['background'], merchant['inset']) == ('#123456', 3)
    assert (company['background'], company['inset']) == ('transparent', 0)
    assert snapshot['snapshotId'] == studio.inventory(project)['snapshotId']
    assert merchant['sourceUrl'] == 'https://example.com/brand'


def test_intake_defaults_to_needing_input_and_keeps_notes(project, tmp_path):
    path = batch(project, tmp_path, ready=False)
    item = studio.read(path)['items'][0]
    assert item['status'] == 'needs-input' and item['notes'] == 'Center this mark'
    with pytest.raises(ValueError, match='Collect references'):
        candidate(project, tmp_path, path)


def test_attach_and_ready_cli_keep_reference_and_resolve_intake(project, tmp_path, monkeypatch):
    path = batch(project, tmp_path, ready=False)
    source = project / 'src/bookiebot/reports/assets/merchant.svg'
    args = ['studio', '--repo', str(project), 'attach', '--batch', str(path), '--key', 'merchant:same', '--image', str(source)]
    monkeypatch.setattr(sys, 'argv', args); studio.main()
    item = studio.read(path)['items'][0]
    assert item['status'] == 'needs-input'
    assert (path.parent / item['references'][0]['path']).read_bytes() == source.read_bytes()
    monkeypatch.setattr(sys, 'argv', ['studio', '--repo', str(project), 'ready', '--batch', str(path), '--key', 'merchant:same'])
    studio.main()
    assert studio.read(path)['items'][0]['status'] == 'ready'
    assert candidate(project, tmp_path, path)['sha256']


def test_intake_rejects_mismatched_or_modified_inventory(project):
    snapshot = studio.inventory(project)
    invalid = feedback(snapshot)
    invalid['snapshotId'] = 'old'
    with pytest.raises(ValueError, match='inventory'):
        studio.intake(project, snapshot, invalid)
    snapshot['items'][0]['name'] = 'Changed'
    with pytest.raises(ValueError, match='inventory'):
        studio.intake(project, snapshot, feedback(snapshot))


def test_active_framing_change_invalidates_intake_and_plan(project, tmp_path):
    snapshot = studio.inventory(project)
    path = batch(project, tmp_path)
    art = candidate(project, tmp_path, path)
    studio.approve(project, path, 'merchant:same', art['sha256'])
    catalog = project / 'web/expense-report/src/merchant-logos.json'
    rows = json.loads(catalog.read_text()); rows[0]['inset'] = 2; studio.write(catalog, rows)
    with pytest.raises(ValueError, match='Active artwork changed'):
        studio.intake(project, snapshot, feedback(snapshot))
    with pytest.raises(ValueError, match='Active artwork changed'):
        studio.promotion_plan(project, path)


def test_intake_rejects_duplicate_alias_and_allows_new_explicit_merchant(project):
    snapshot = studio.inventory(project)
    with pytest.raises(ValueError, match='already exists'):
        studio.intake(project, snapshot, feedback(snapshot, new=['MERCHANT alias']))
    result = studio.intake(project, snapshot, feedback(snapshot, new=['New Shop']))
    new = result['items'][-1]
    assert new['key'] == 'merchant:new-shop' and new['expectedRevision'] is None
    assert new['status'] == 'needs-input'


@pytest.mark.parametrize('url', ['http://example.com', 'javascript:alert(1)', 'https://user:pass@example.com'])
def test_references_must_be_https_without_credentials(project, url):
    snapshot = studio.inventory(project)
    choice = feedback(snapshot); choice['items'][0]['referenceUrls'] = [url]
    with pytest.raises(ValueError, match='HTTPS'):
        studio.intake(project, snapshot, choice)


def test_source_validation_rejects_active_svg_and_missing_hash(project, tmp_path):
    unsafe = tmp_path / 'unsafe.svg'
    unsafe.write_text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    with pytest.raises(ValueError, match='Active'):
        studio.checked_image(unsafe)
    (project / 'src/bookiebot/reports/assets/merchant.svg').write_text('<svg/>')
    with pytest.raises(ValueError, match='hash mismatch'):
        studio.inventory(project)


def test_candidate_requires_full_circle_and_preserves_app_bytes(project, tmp_path):
    path = batch(project, tmp_path)
    catalog = project / 'web/expense-report/src/merchant-logos.json'
    before = catalog.read_bytes()
    square = tmp_path / 'square.png'; Image.new('RGBA', (256, 256), 'red').save(square)
    with pytest.raises(ValueError, match='opaque square'):
        studio.stage(project, path, 'merchant:same', square, square, 'reframe')
    art = candidate(project, tmp_path, path)
    assert catalog.read_bytes() == before
    assert (path.parent / art['source']['path']).read_bytes() == (project / 'src/bookiebot/reports/assets/merchant.svg').read_bytes()
    assert studio.read(path)['items'][0]['status'] == 'candidate-review'
    assert art['sha256'] == studio.digest((path.parent / art['asset']).read_bytes())


def test_ai_requires_prompt_and_retains_unmodified_generated_output(project, tmp_path):
    path = batch(project, tmp_path)
    image = prepared(tmp_path / 'candidate.png')
    source = project / 'src/bookiebot/reports/assets/merchant.svg'
    with pytest.raises(ValueError, match='prompt and original generated output'):
        studio.stage(project, path, 'merchant:same', image, source, 'ai', prompt='Restore')
    raw = tmp_path / 'raw.png'; Image.new('RGB', (512, 512), 'orange').save(raw)
    art = studio.stage(project, path, 'merchant:same', image, source, 'ai', prompt='Exact full prompt', generated=raw)
    assert art['prompt'] == 'Exact full prompt' and art['tool'] == 'built-in image_gen.imagegen'
    assert (path.parent / art['generatedOutput']['path']).read_bytes() == raw.read_bytes()
    studio.approve(project, path, 'merchant:same', art['sha256'])
    (path.parent / art['generatedOutput']['path']).write_bytes(image.read_bytes())
    with pytest.raises(ValueError, match='Generated output changed'):
        studio.promotion_plan(project, path)


def test_approval_is_exact_and_new_candidate_revokes_it(project, tmp_path):
    path = batch(project, tmp_path)
    art = candidate(project, tmp_path, path)
    with pytest.raises(ValueError, match='exact latest candidate'):
        studio.approve(project, path, 'merchant:same', 'not-the-hash')
    with pytest.raises(ValueError, match='No exact candidates'):
        studio.promotion_plan(project, path)
    studio.approve(project, path, 'merchant:same', art['sha256'])
    prepared(tmp_path / 'next.png', 'orange')
    studio.stage(project, path, 'merchant:same', tmp_path / 'next.png', tmp_path / 'next.png', 'original')
    item = studio.read(path)['items'][0]
    assert 'approvedSha256' not in item and len(item['candidates']) == 2
    with pytest.raises(ValueError, match='No exact candidates'):
        studio.promotion_plan(project, path)


@pytest.mark.parametrize('tamper', ['asset', 'source'])
def test_changed_candidate_or_reference_cannot_be_planned(project, tmp_path, tamper):
    path = batch(project, tmp_path)
    art = candidate(project, tmp_path, path)
    studio.approve(project, path, 'merchant:same', art['sha256'])
    target = path.parent / (art['asset'] if tamper == 'asset' else art['source']['path'])
    if tamper == 'asset':
        prepared(target, 'orange')
    else:
        target.write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
    with pytest.raises(ValueError, match='changed'):
        studio.promotion_plan(project, path)


def test_publication_plan_only_contains_approved_items_and_never_writes_catalog(project, tmp_path):
    snapshot = studio.inventory(project)
    before = {str(file): file.read_bytes() for file in project.rglob('*') if file.is_file()}
    path = tmp_path / 'review/batch.json'
    choice = feedback(snapshot, ready=True, new=['Future Store'])
    studio.write(path, studio.intake(project, snapshot, choice))
    art = candidate(project, tmp_path, path)
    studio.approve(project, path, 'merchant:same', art['sha256'])
    changes = studio.promotion_plan(project, path)['changes']
    assert len(changes) == 1 and changes[0]['key'] == 'merchant:same'
    assert changes[0]['destination'].endswith(art['sha256'][:16] + '.png')
    assert before == {str(file): file.read_bytes() for file in project.rglob('*') if file.is_file()}
