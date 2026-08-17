"""
Shared abstractions for talking to LLM providers plus lightweight doubles
used by the BookieBot testing sandbox.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol, Literal, ContextManager, cast, TYPE_CHECKING

try:  # Optional dependency for YAML fixtures.
    import yaml  # type: ignore
except ImportError:  # pragma: no cover - optional
    yaml = None

try:  # Optional dependency for cassette recording.
    import vcr  # type: ignore
except ImportError:  # pragma: no cover - optional
    vcr = None

if TYPE_CHECKING:
    from vcr.cassette import RecordMode as VcrRecordMode  # type: ignore
else:  # pragma: no cover - runtime fallback
    VcrRecordMode = str  # type: ignore[misc,assignment]

from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

_NON_RETRYABLE_QUOTA_CODES = {
    "credit_balance_exhausted",
    "insufficient_quota",
    "organization_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "project_spend_limit_exceeded",
}


def _positive_int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def _positive_float_env(name: str, default: float) -> float:
    try:
        return max(0.0, float(os.getenv(name, str(default))))
    except ValueError:
        return default


def _openai_error_status(exc: Exception) -> int | None:
    for candidate in (
        getattr(exc, "http_status", None),
        getattr(exc, "status_code", None),
        getattr(getattr(exc, "response", None), "status_code", None),
    ):
        if candidate is None:
            continue
        try:
            return int(candidate)
        except (TypeError, ValueError):
            continue
    return None


def _openai_error_code(exc: Exception) -> str:
    code = getattr(exc, "code", None) or getattr(exc, "error_code", None)
    if not code:
        error = getattr(exc, "error", None)
        if isinstance(error, dict):
            code = error.get("code") or error.get("type")
    return str(code or "").strip().lower()


def _openai_retry_after(exc: Exception) -> float | None:
    headers = getattr(exc, "headers", None) or getattr(getattr(exc, "response", None), "headers", None)
    if not headers:
        return None
    raw = headers.get("retry-after") or headers.get("Retry-After")
    try:
        return max(0.0, float(raw)) if raw is not None else None
    except (TypeError, ValueError):
        return None


def _is_retryable_openai_error(exc: Exception) -> bool:
    if _openai_error_code(exc) in _NON_RETRYABLE_QUOTA_CODES:
        return False
    status = _openai_error_status(exc)
    if status in {408, 409, 429, 500, 502, 503, 504}:
        return True
    return type(exc).__name__ in {
        "APIConnectionError",
        "APITimeoutError",
        "RateLimitError",
        "ServiceUnavailableError",
        "Timeout",
    }


class LLMClient(Protocol):
    """
    Minimal async protocol so production code and tests can swap different
    backing clients without touching the parser.
    """

    async def complete(
        self,
        *,
        messages: List[Dict[str, str]],
        temperature: float = 0.0,
        **kwargs: Any,
    ) -> Any:
        ...


@dataclass
class LLMMessage:
    """Helper dataclass for readability inside tests."""

    role: str
    content: str

    def as_dict(self) -> Dict[str, str]:
        return {"role": self.role, "content": self.content}


class OpenAIClient(LLMClient):
    """
    Thin wrapper around the modern OpenAI chat-completions client that executes requests
    in a worker thread so the Discord event loop stays responsive.
    """

    def __init__(self, *, model: Optional[str] = None, api_key: Optional[str] = None):
        import openai  # Imported lazily so tests without the SDK still run.

        self._model = model or os.getenv("BOOKIEBOT_INTENT_MODEL", "gpt-4.1-mini").strip() or "gpt-4.1-mini"
        self._api_key = api_key or os.getenv("OPENAI_API_KEY")
        if not self._api_key:
            raise RuntimeError("OPENAI_API_KEY must be set to use OpenAIClient.")
        self._client = openai.OpenAI(api_key=self._api_key, max_retries=0)
        self._max_attempts = _positive_int_env("BOOKIEBOT_OPENAI_MAX_ATTEMPTS", 3)
        self._base_retry_delay = _positive_float_env("BOOKIEBOT_OPENAI_RETRY_BASE_SECONDS", 0.75)
        self._max_retry_delay = _positive_float_env("BOOKIEBOT_OPENAI_RETRY_MAX_SECONDS", 8.0)

    async def complete(
        self,
        *,
        messages: List[Dict[str, str]],
        temperature: float = 0.0,
        **kwargs: Any,
    ) -> str:
        def _call():
            create = cast(Any, self._client.chat.completions.create)
            return create(
                model=self._model,
                messages=messages,
                temperature=temperature,
                **kwargs,
            )

        for attempt in range(1, self._max_attempts + 1):
            try:
                response = await asyncio.to_thread(_call)
                return response.choices[0].message.content  # type: ignore[index]
            except Exception as exc:
                if attempt >= self._max_attempts or not _is_retryable_openai_error(exc):
                    raise
                delay = _openai_retry_after(exc)
                if delay is None:
                    delay = min(self._base_retry_delay * (2 ** (attempt - 1)), self._max_retry_delay)
                logger.warning(
                    "Transient OpenAI request failed; retrying intent request",
                    extra={
                        "attempt": attempt,
                        "max_attempts": self._max_attempts,
                        "retry_delay_seconds": delay,
                        "status": _openai_error_status(exc),
                        "error_code": _openai_error_code(exc) or None,
                    },
                )
                await asyncio.sleep(delay)

        raise RuntimeError("OpenAI request retry loop ended unexpectedly.")


class FixtureLLMClient(LLMClient):
    """
    Deterministic client used inside tests. Payloads can be dictionaries
    or literal JSON strings.
    """

    def __init__(self, payload: Any):
        self._payload = payload

    @classmethod
    def from_file(cls, path: Path) -> "FixtureLLMClient":
        data = path.read_text()
        suffix = path.suffix.lower()

        if suffix in {".yaml", ".yml"}:
            if yaml is None:
                raise RuntimeError("PyYAML is required to load YAML fixtures.")
            payload = yaml.safe_load(data)
        else:
            payload = json.loads(data)

        return cls(payload)

    async def complete(
        self,
        *,
        messages: List[Dict[str, str]],
        temperature: float = 0.0,
        **kwargs: Any,
    ) -> Any:
        return deepcopy(self._payload)


class CassetteLLMClient(LLMClient):
    """
    Wrapper that records/replays HTTP calls through vcrpy while delegating to
    another LLMClient (typically OpenAIClient). Useful for refreshing cassettes
    manually while keeping day-to-day tests deterministic.
    """

    def __init__(
        self,
        cassette_path: Path,
        *,
        inner: Optional[LLMClient] = None,
        record_mode: "VcrRecordMode | Literal['once', 'all', 'new_episodes', 'none']" = "once",
    ):
        if vcr is None:
            raise RuntimeError("vcrpy is required for CassetteLLMClient.")
        self._cassette_path = cassette_path
        self._inner = inner or OpenAIClient()

        # Normalize to the VCR RecordMode enum for type checkers and runtime.
        try:
            from vcr.cassette import RecordMode as RuntimeRecordMode  # type: ignore

            if isinstance(record_mode, RuntimeRecordMode):
                record_mode_enum: RuntimeRecordMode = record_mode  # type: ignore[assignment]
            else:
                record_mode_enum = RuntimeRecordMode(record_mode)  # type: ignore[call-arg]
            record_mode_value: str = record_mode_enum.value  # type: ignore[assignment]
        except Exception:
            record_mode_enum = cast("VcrRecordMode", record_mode)
            record_mode_value = cast(str, getattr(record_mode, "value", record_mode))

        self._record_mode: "VcrRecordMode | Literal['once', 'all', 'new_episodes', 'none']" = record_mode_enum
        self._vcr = vcr.VCR(
            filter_headers=["authorization", "api-key"],
            record_mode=cast("VcrRecordMode", record_mode_enum),
        )

    async def complete(
        self,
        *,
        messages: List[Dict[str, str]],
        temperature: float = 0.0,
        **kwargs: Any,
    ) -> Any:
        cassette_ctx = self._vcr.use_cassette(str(self._cassette_path))
        with cast(ContextManager[Any], cassette_ctx):
            return await self._inner.complete(
                messages=messages,
                temperature=temperature,
                **kwargs,
            )
