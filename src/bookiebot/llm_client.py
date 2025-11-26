"""
Shared abstractions for talking to LLM providers plus lightweight doubles
used by the BookieBot testing sandbox.
"""

from __future__ import annotations

import asyncio
import json
import os
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol

try:  # Optional dependency for YAML fixtures.
    import yaml  # type: ignore
except ImportError:  # pragma: no cover - optional
    yaml = None

try:  # Optional dependency for cassette recording.
    import vcr  # type: ignore
except ImportError:  # pragma: no cover - optional
    vcr = None

from dotenv import load_dotenv

load_dotenv()


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
    Thin wrapper around the OpenAI ChatCompletion API that executes requests
    in a worker thread so the Discord event loop stays responsive.
    """

    def __init__(self, *, model: str = "gpt-3.5-turbo", api_key: Optional[str] = None):
        import openai  # Imported lazily so tests without the SDK still run.

        self._openai = openai
        self._model = model
        self._api_key = api_key or os.getenv("OPENAI_API_KEY")
        if not self._api_key:
            raise RuntimeError("OPENAI_API_KEY must be set to use OpenAIClient.")
        self._openai.api_key = self._api_key

    async def complete(
        self,
        *,
        messages: List[Dict[str, str]],
        temperature: float = 0.0,
        **kwargs: Any,
    ) -> str:
        def _call():
            return self._openai.ChatCompletion.create(
                model=self._model,
                messages=messages,
                temperature=temperature,
                **kwargs,
            )

        response = await asyncio.to_thread(_call)
        return response.choices[0].message.content  # type: ignore[index]


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
        record_mode: str = "once",
    ):
        if vcr is None:
            raise RuntimeError("vcrpy is required for CassetteLLMClient.")
        self._cassette_path = cassette_path
        self._inner = inner or OpenAIClient()
        self._record_mode = record_mode
        self._vcr = vcr.VCR(
            filter_headers=["authorization", "api-key"],
            record_mode=record_mode,
        )

    async def complete(
        self,
        *,
        messages: List[Dict[str, str]],
        temperature: float = 0.0,
        **kwargs: Any,
    ) -> Any:
        with self._vcr.use_cassette(str(self._cassette_path)):
            return await self._inner.complete(
                messages=messages,
                temperature=temperature,
                **kwargs,
            )
