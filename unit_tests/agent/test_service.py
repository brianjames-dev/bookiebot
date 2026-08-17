from unittest.mock import AsyncMock

from langchain.agents import create_agent
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
import pytest

from bookiebot.agent.context import ConversationContext
from bookiebot.agent import tools as agent_tools
from bookiebot.agent.service import LangGraphConversationService


class _Graph:
    def __init__(self, response):
        self.response = response
        self.calls = []

    async def ainvoke(self, payload, *, config, context):
        self.calls.append((payload, config, context))
        return {"messages": [self.response]}


class _ToolCallingModel(FakeMessagesListChatModel):
    def bind_tools(self, tools, *, tool_choice=None, **kwargs):
        return self


def _context() -> ConversationContext:
    return ConversationContext(
        actor_key="676638528590970917",
        discord_user_id="676638528590970917",
        display_name="Brian",
        channel_id="200",
        guild_id="300",
        thread_id="discord:300:200:676638528590970917",
    )


@pytest.mark.asyncio
async def test_service_invokes_graph_with_thread_and_runtime_context():
    graph = _Graph(AIMessage(content="You are on track."))
    service = LangGraphConversationService(graph=graph)
    context = _context()

    reply = await service.respond("Can I afford dinner?", context=context)

    assert reply == "You are on track."
    payload, config, runtime_context = graph.calls[0]
    assert payload == {"messages": [{"role": "user", "content": "Can I afford dinner?"}]}
    assert config["configurable"]["thread_id"] == context.thread_id
    assert runtime_context is context


@pytest.mark.asyncio
async def test_service_extracts_text_from_structured_content_blocks():
    graph = _Graph(
        AIMessage(
            content=[
                {"type": "text", "text": "First paragraph."},
                {"type": "text", "text": "Second paragraph."},
            ]
        )
    )
    service = LangGraphConversationService(graph=graph)

    reply = await service.respond("Explain this", context=_context())

    assert reply == "First paragraph.\nSecond paragraph."


@pytest.mark.asyncio
async def test_service_rejects_an_empty_agent_response():
    service = LangGraphConversationService(graph=_Graph(AIMessage(content="")))

    with pytest.raises(RuntimeError, match="empty response"):
        await service.respond("Explain this", context=_context())


@pytest.mark.asyncio
async def test_langgraph_memory_is_reused_only_for_the_same_discord_thread():
    async def count_messages(state: MessagesState):
        return {"messages": [AIMessage(content=f"history:{len(state['messages'])}")]}

    builder = StateGraph(MessagesState, context_schema=ConversationContext)
    builder.add_node("count", count_messages)
    builder.add_edge(START, "count")
    builder.add_edge("count", END)
    service = LangGraphConversationService(graph=builder.compile(checkpointer=InMemorySaver()))
    brian = _context()
    hannah = ConversationContext(
        actor_key="830984827904851969",
        discord_user_id="830984827904851969",
        display_name="Hannah",
        channel_id="200",
        guild_id="300",
        thread_id="discord:300:200:830984827904851969",
    )

    assert await service.respond("First", context=brian) == "history:1"
    assert await service.respond("Second", context=brian) == "history:3"
    assert await service.respond("First", context=hannah) == "history:1"


@pytest.mark.asyncio
async def test_graph_tool_loop_injects_trusted_context_without_model_owner_args(monkeypatch):
    loader = AsyncMock(return_value={"owner": "Brian", "category": "food", "total": 42.0})
    monkeypatch.setattr(agent_tools, "load_spending_by_category", loader)
    model = _ToolCallingModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "get_spending_by_category",
                        "args": {"category": "food"},
                        "id": "tool-call-1",
                    }
                ],
            ),
            AIMessage(content="You spent $42 on food."),
        ]
    )
    graph = create_agent(
        model=model,
        tools=agent_tools.read_only_tools(),
        context_schema=ConversationContext,
        checkpointer=InMemorySaver(),
    )
    context = _context()

    reply = await LangGraphConversationService(graph=graph).respond(
        "What have I spent on food?",
        context=context,
    )

    assert reply == "You spent $42 on food."
    loader.assert_awaited_once_with(context, "food")
