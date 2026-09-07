from pathlib import Path
import shutil
import subprocess

import pytest


def test_category_pie_survives_mode_and_filter_transitions():
    root = Path(__file__).resolve().parents[2]
    if not shutil.which("node") or not (root / "web/expense-report/node_modules/react-test-renderer").exists():
        pytest.skip("Install the report frontend dependencies for UI contracts")
    subprocess.run(
        ["node", str(Path(__file__).with_name("pie_mode_transition_test.cjs"))],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
