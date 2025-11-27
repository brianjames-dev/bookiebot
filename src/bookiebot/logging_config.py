import json
import logging
import os
import re
import sys
import time
from collections import deque
from typing import Deque, Iterable, List, Optional

# In-memory ring buffer for recent logs (process-local).
RING_BUFFER: Deque[str] = deque(maxlen=2000)
START_TIME = time.time()


def _redact(line: str) -> str:
    """
    Very lightweight redaction for obvious secrets (API keys, tokens).
    Not exhaustive; extend as needed.
    """
    patterns = [
        r"sk-[A-Za-z0-9]{10,}",  # OpenAI-style
        r"[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}",  # JWT-like
    ]
    redacted = line
    for pat in patterns:
        redacted = re.sub(pat, "[redacted]", redacted)
    return redacted


class RingBufferHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            msg = _redact(msg)
            RING_BUFFER.append(msg)
        except Exception:
            # Never allow logging to crash the app.
            self.handleError(record)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, datefmt="%Y-%m-%dT%H:%M:%S.%fZ"),
            "level": record.levelname,
            "msg": record.getMessage(),
        }
        # Optional context injected via `extra=`
        for key in ("user", "user_id", "channel", "intent", "entities", "exception"):
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def init_logging() -> None:
    """
    Configure root logger for JSON output to stdout and ring buffer copy.
    Safe to call multiple times.
    """
    if getattr(init_logging, "_configured", False):
        return

    root = logging.getLogger()
    root.setLevel(logging.INFO)

    formatter = JsonFormatter()

    stream_handler = logging.StreamHandler(stream=sys.stdout)
    stream_handler.setFormatter(formatter)

    ring_handler = RingBufferHandler()
    ring_handler.setFormatter(formatter)

    root.handlers.clear()
    root.addHandler(stream_handler)
    root.addHandler(ring_handler)

    init_logging._configured = True  # type: ignore[attr-defined]


def get_recent_logs(limit: int = 200, level: Optional[str] = None, contains: Optional[str] = None) -> List[str]:
    lines: Iterable[str] = list(RING_BUFFER)
    if level:
        level = level.upper()
        lines = [ln for ln in lines if f'"level": "{level}"' in ln]
    if contains:
        lines = [ln for ln in lines if contains.lower() in ln.lower()]
    return list(lines)[-limit:]


def uptime_seconds() -> float:
    return time.time() - START_TIME
