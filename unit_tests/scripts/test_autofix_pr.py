import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest

from scripts.build_autofix_pr import build_pr_metadata


@pytest.mark.parametrize("summary", [
    "Brian's rent wasn't logged",
    'One line\npr_title=another value\r\nLast line',
    '`touch SHOULD_NOT_EXIST` and $(touch SHOULD_NOT_EXIST)',
    'A $50 discrepancy with "quotes" and \\backslashes',
])
def test_metadata_preserves_incident_as_data_without_extra_output_lines(summary):
    title, body = build_pr_metadata({"client_payload": {"incident": {"summary": summary}}}, None)
    assert "\n" not in title
    assert "\r" not in title
    assert len(title) <= 120
    assert summary in body
    assert json.dumps({"summary": summary}, ensure_ascii=False, indent=2) in body


def test_codex_title_wins_and_backtick_fences_cannot_close_the_summary_block():
    title, body = build_pr_metadata(
        {"client_payload": {"incident": {"summary": "Incident's $100 estimate"}}},
        '\nPR Title: Preserve Brian\'s $100 `budget`\n\nHandle "quoted" text.\n```\n$(echo not-a-command)\n',
    )
    assert title == "Preserve Brian's $100 `budget`"
    assert "````\nHandle \"quoted\" text.\n```\n$(echo not-a-command)\n````" in body
    assert "PR Title:" not in body


def test_cli_reads_event_file_and_writes_literal_metadata(tmp_path):
    script = Path(__file__).resolve().parents[2] / "scripts/build_autofix_pr.py"
    summary = "Brian's $50\n`touch SHOULD_NOT_EXIST` $(touch SHOULD_NOT_EXIST)"
    event = tmp_path / "event.json"
    event.write_text(json.dumps({"client_payload": {"incident": {"summary": summary}}}))
    github_output = tmp_path / "github-output.txt"
    github_output.write_text("existing=value\n")
    env = {**os.environ, "GITHUB_EVENT_PATH": str(event), "GITHUB_OUTPUT": str(github_output)}
    subprocess.run([sys.executable, str(script)], cwd=tmp_path, env=env, check=True)
    assert github_output.read_text().splitlines() == ["existing=value", "pr_title=" + " ".join(summary.split())]
    assert summary in (tmp_path / "pr-body.md").read_text()
    assert not (tmp_path / "SHOULD_NOT_EXIST").exists()


def test_metadata_handles_missing_output_and_caps_fallback_title():
    title, body = build_pr_metadata({}, None)
    assert title == "Codex autofix updates"
    assert "No Codex output captured." in body
    long_title, _ = build_pr_metadata({"client_payload": {"incident": {"summary": "x" * 200}}}, None)
    assert long_title == "x" * 120


def test_workflow_uses_file_based_metadata_helper():
    workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/codex-autofix.yml").read_text()
    metadata_step = workflow.split("- name: Build PR title and body", 1)[1].split("- name: Check for changes", 1)[0]
    assert "run: python scripts/build_autofix_pr.py" in metadata_step
    assert "${{" not in metadata_step


def test_autofix_failure_log_stays_a_file_even_with_environment_delimiters(tmp_path):
    workflow = (Path(__file__).resolve().parents[2] / ".github/workflows/codex-autofix.yml").read_text()
    step = workflow.split("- name: Run unit tests (attempt 1)", 1)[1].split("- name: Run Codex Autofix (attempt 2", 1)[0]
    code = textwrap.dedent(step.split("run: |\n", 1)[1])
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_pytest = fake_bin / "pytest"
    fake_pytest.write_text('#!/bin/sh\ncat "$SYNTHETIC_FAILURE_LOG"\nexit 1\n')
    fake_pytest.chmod(0o755)
    failure = "Ordinary test failure\nEOF\n'EOF'\n`touch SHOULD_NOT_EXIST`\n$(touch SHOULD_NOT_EXIST)\nlast line\n"
    source = tmp_path / "synthetic-failure.txt"
    source.write_text(failure)
    output = tmp_path / "github-output.txt"
    env_file = tmp_path / "github-env.txt"
    env = {**os.environ, "PATH": str(fake_bin) + os.pathsep + os.environ.get("PATH", ""),
           "SYNTHETIC_FAILURE_LOG": str(source), "GITHUB_OUTPUT": str(output), "GITHUB_ENV": str(env_file)}
    subprocess.run(["/bin/bash", "-c", code], cwd=tmp_path, env=env, check=True, capture_output=True, text=True)
    assert (tmp_path / "pytest-fail.log").read_text() == failure
    assert output.read_text() == "status=fail\n"
    assert not env_file.exists()
    assert not (tmp_path / "SHOULD_NOT_EXIST").exists()
    assert "Read pytest-fail.log in the workspace" in workflow
    assert "env.FAIL_LOG" not in workflow
