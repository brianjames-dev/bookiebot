import json
import logging

from bookiebot.logging_config import JsonFormatter


def test_json_formatter_emits_microsecond_timestamps_and_retry_context():
    record = logging.LogRecord(
        name="bookiebot.test",
        level=logging.WARNING,
        pathname=__file__,
        lineno=1,
        msg="retrying",
        args=(),
        exc_info=None,
    )
    record.created = 1783420002.123456
    record.login_attempt = 2  # type: ignore[attr-defined]
    record.retry_seconds = 300  # type: ignore[attr-defined]
    record.retry_after_seconds = 120  # type: ignore[attr-defined]
    record.retry_at = "2026-07-07T09:31:42+00:00"  # type: ignore[attr-defined]

    payload = json.loads(JsonFormatter().format(record))

    assert "%f" not in payload["ts"]
    assert payload["ts"].endswith("Z")
    assert ".123456" in payload["ts"]
    assert payload["login_attempt"] == 2
    assert payload["retry_seconds"] == 300
    assert payload["retry_after_seconds"] == 120
    assert payload["retry_at"] == "2026-07-07T09:31:42+00:00"
