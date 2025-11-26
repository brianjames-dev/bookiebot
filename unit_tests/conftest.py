import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from bookiebot.llm_client import CassetteLLMClient, FixtureLLMClient, OpenAIClient


def _ensure_gspread_stub():
    try:
        import gspread  # type: ignore  # noqa: F401
        return
    except ModuleNotFoundError:
        pass

    def rowcol_to_a1(row: int, col: int) -> str:
        label = ""
        while col > 0:
            col, rem = divmod(col - 1, 26)
            label = chr(65 + rem) + label
        return f"{label}{row}"

    utils = types.SimpleNamespace(rowcol_to_a1=rowcol_to_a1)

    class Client:
        def open_by_key(self, key):
            raise RuntimeError("gspread stub cannot open real sheets.")

    def authorize(_creds):
        return Client()

    sys.modules["gspread"] = types.SimpleNamespace(authorize=authorize, utils=utils)


_ensure_gspread_stub()


def _ensure_openai_stub():
    try:
        import openai  # type: ignore  # noqa: F401
        return
    except ModuleNotFoundError:
        pass

    class ChatCompletion:
        @staticmethod
        def create(*args, **kwargs):
            raise RuntimeError("openai stub cannot make real API calls.")

    sys.modules["openai"] = types.SimpleNamespace(ChatCompletion=ChatCompletion)


_ensure_openai_stub()


def pytest_addoption(parser):
    parser.addoption(
        "--llm-live",
        action="store_true",
        default=False,
        help="Refresh cassette fixtures by calling the real OpenAI API.",
    )


@pytest.fixture
def llm_client_factory(request):
    live = request.config.getoption("--llm-live")
    cassette_dir = ROOT / "unit_tests" / "cassettes"

    def _factory(fixture_path):
        path = Path(fixture_path)
        if not path.is_absolute():
            path = ROOT / path
        if live:
            cassette_dir.mkdir(parents=True, exist_ok=True)
            cassette_path = cassette_dir / f"{path.stem}.yaml"
            return CassetteLLMClient(
                cassette_path,
                inner=OpenAIClient(),
                record_mode="once",
            )
        return FixtureLLMClient.from_file(path)

    return _factory
