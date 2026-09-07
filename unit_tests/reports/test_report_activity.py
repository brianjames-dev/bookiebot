from pathlib import Path
import subprocess
import pytest


def test_report_activity_drilldowns_and_source_distinctions():
    root = Path(__file__).resolve().parents[2]
    if not (root / 'web/expense-report/node_modules/typescript').exists():
        pytest.skip('Install frontend dependencies for executed UI checks')
    subprocess.run(['node', 'unit_tests/reports/report_activity_test.cjs'], cwd=root, check=True, capture_output=True, text=True)
