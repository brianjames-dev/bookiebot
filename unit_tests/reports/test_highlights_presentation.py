from pathlib import Path
import subprocess

import pytest


def test_approved_highlights_renderers_and_thumbnail_bounds():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to execute Highlights presentation checks")
    subprocess.run(
        ["node", "unit_tests/reports/highlights_presentation_test.cjs"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
