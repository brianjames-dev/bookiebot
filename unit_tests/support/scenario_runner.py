from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Optional, Union

from bookiebot.llm.client import FixtureLLMClient, LLMClient
from bookiebot.intents.parser import parse_message_llm


class FakeChannel:
    """Minimal channel stub that records outbound messages."""

    def __init__(self) -> None:
        self.sent_messages: list[str] = []

    async def send(self, content: str = "", **kwargs) -> None:
        # Capture text content; ignore other kwargs (files, views) to keep tests simple.
        self.sent_messages.append(content or "")
        file = kwargs.get("file")
        if file is not None:
            filename = getattr(file, "filename", "attachment")
            self.sent_messages.append(f"[file:{filename}]")


@dataclass
class FakeAuthor:
    name: str = "Hannerish"
    id: int = 123456789  # minimal stand-in for Discord user id


@dataclass
class FakeMessage:
    content: str
    author: FakeAuthor = field(default_factory=FakeAuthor)
    channel: FakeChannel = field(default_factory=FakeChannel)

    @property
    def mention(self) -> str:
        return f"@{self.author.name}"


@dataclass
class ScenarioResult:
    intent: str
    entities: Dict[str, Any]
    message: FakeMessage
    replies: list[str]


async def run_scenario(
    message_text: str,
    *,
    llm_fixture: Optional[Union[str, Path]] = None,
    llm_client: Optional[LLMClient] = None,
    handler: Optional[Callable[[str, Dict[str, Any], FakeMessage], Awaitable[None]]] = None,
    author_name: str = "Hannerish",
) -> ScenarioResult:
    """
    Glue that simulates the Discord event handler with a deterministic LLM result.
    Tests can optionally call into the real intent handler (after injecting their own
    sheet stubs/mocks) to validate reply text and sheet mutations.
    """

    if llm_client is None:
        if llm_fixture is None:
            raise ValueError("Either llm_client or llm_fixture must be provided.")
        llm_client = FixtureLLMClient.from_file(Path(llm_fixture))
    fake_message = FakeMessage(content=message_text, author=FakeAuthor(name=author_name))

    intent_data = await parse_message_llm(message_text, llm_client=llm_client)
    intent = intent_data.get("intent") or ""
    entities = intent_data.get("entities", {})

    if handler and intent:
        await handler(intent, entities, fake_message)

    return ScenarioResult(
        intent=intent,
        entities=entities,
        message=fake_message,
        replies=list(fake_message.channel.sent_messages),
    )
