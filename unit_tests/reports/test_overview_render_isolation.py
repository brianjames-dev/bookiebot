from pathlib import Path
import subprocess

import pytest


def test_overview_filters_do_not_rebuild_unrelated_sections():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to execute render isolation checks")
    subprocess.run(
        ["node", "unit_tests/reports/overview_render_isolation_test.cjs"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
