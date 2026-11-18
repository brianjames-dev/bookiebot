from pathlib import Path
import subprocess


def test_scroll_ownership_across_fold_resume_and_late_layout():
    subprocess.run(['node', str(Path(__file__).with_name('duo_list_scroll_test.cjs'))],
        cwd=Path(__file__).resolve().parents[2], check=True, capture_output=True, text=True)
