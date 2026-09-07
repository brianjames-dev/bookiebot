from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import os
from threading import Barrier
from uuid import uuid4

import pytest

from bookiebot.reports.app_access import AppAccessStore, PostgresAppAccessStore
from bookiebot.reports.goals_store import GoalsStore, GoalConflictError, GoalNotFoundError, GoalValidationError
from bookiebot.sheets.routing import now_pacific


@pytest.fixture(params=["sqlite", "postgres"])
def access(request, tmp_path):
    if request.param == "sqlite":
        yield AppAccessStore(tmp_path / "goals.sqlite3")
        return
    url = os.getenv("BOOKIEBOT_TEST_POSTGRES_URL", "")
    if not url:
        pytest.skip("Set BOOKIEBOT_TEST_POSTGRES_URL for isolated Postgres goals contracts")
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import make_conninfo
    schema = "bookiebot_goals_" + uuid4().hex
    with psycopg.connect(url, autocommit=True, connect_timeout=5) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        try:
            yield PostgresAppAccessStore(make_conninfo(url, options=f"-csearch_path={schema}", connect_timeout=5))
        finally:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


@pytest.fixture
def store(access):
    result = GoalsStore(access)
    result.initialize()
    return result


def test_concurrent_first_schema_initialization_is_safe(access):
    barrier = Barrier(4)

    def initialize(_):
        barrier.wait(timeout=10)
        GoalsStore(access).initialize()

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(initialize, range(4)))
    store = GoalsStore(access)
    goal = create(store)
    assert store.list_goals("brian")["goals"] == [goal]


def command(operation, **values):
    return {"operation": operation, "requestId": uuid4().hex, **values}


def create(store, owner="brian", **values):
    return store.command(owner, command("create", name="Emergency fund", targetCents=1_000_000,
                                       startingCents=100_000, targetDate="2028-01-01", **values))["goal"]


def contribute(store, goal, owner="brian", amount=25_000):
    return store.command(owner, command("contribute", goalId=goal["id"], version=goal["version"],
                                       amountCents=amount, date=now_pacific().date().isoformat(), note="Paycheck allocation"))["goal"]


def test_goal_balances_persist_and_are_separate_from_other_tables(store):
    goal = create(store)
    goal = contribute(store, goal)
    assert goal["balanceCents"] == 125_000
    assert goal["startingCents"] == 100_000
    assert goal["contributionCents"] == 25_000
    assert GoalsStore(store.access).list_goals("brian")["goals"] == [goal]
    assert store.list_goals("hannah")["goals"] == []


@pytest.mark.parametrize("action", ["edit", "archive", "restore", "contribute", "reverse", "history"])
def test_goal_ownership_is_checked_on_every_read_and_write(store, action):
    goal = create(store)
    with pytest.raises(GoalNotFoundError):
        if action == "history":
            store.history("hannah", goal["id"])
        else:
            store.command("hannah", command(action, goalId=goal["id"], version=goal["version"]))
    assert store.list_goals("brian")["goals"] == [goal]


def test_same_request_is_replayed_once_and_payload_change_is_refused(store):
    body = command("create", name="Trip", targetCents=50_000, startingCents=0)
    first = store.command("brian", body)
    assert store.command("brian", body) == first
    assert len(store.list_goals("brian")["goals"]) == 1
    with pytest.raises(GoalConflictError):
        store.command("brian", {**body, "targetCents": 60_000})
    assert store.command("hannah", body)["goal"]["id"] != first["goal"]["id"]


def test_concurrent_duplicate_contribution_counts_once(store):
    goal = create(store)
    body = command("contribute", goalId=goal["id"], version=goal["version"], amountCents=1000,
                   date=now_pacific().date().isoformat())
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: store.command("brian", body), range(4)))
    assert results == [results[0]] * 4
    assert store.list_goals("brian")["goals"][0]["balanceCents"] == 101_000
    assert len(store.history("brian", goal["id"])["contributions"]) == 1


def test_optimistic_version_prevents_lost_updates(store):
    goal = create(store)
    changed = contribute(store, goal)
    with pytest.raises(GoalConflictError):
        store.command("brian", command("edit", goalId=goal["id"], version=goal["version"], name="Stale edit",
                                        targetCents=500_000, startingCents=0))
    assert store.list_goals("brian")["goals"] == [changed]


def test_reversal_preserves_ledger_and_cannot_reduce_twice(store):
    goal = contribute(store, create(store))
    entry = store.history("brian", goal["id"])["contributions"][0]
    body = command("reverse", goalId=goal["id"], version=goal["version"], contributionId=entry["id"])
    result = store.command("brian", body)
    assert result["goal"]["balanceCents"] == 100_000
    assert result["goal"]["contributionCount"] == 1
    assert store.command("brian", body) == result
    with pytest.raises(GoalConflictError, match="already reversed"):
        store.command("brian", {**body, "requestId": uuid4().hex, "version": result["goal"]["version"]})
    saved = store.history("brian", goal["id"])["contributions"][0]
    assert saved["reversedAt"] and saved["amountCents"] == 25_000
    assert saved["date"] == entry["date"] and saved["note"] == entry["note"]


def test_cross_goal_contribution_reversal_refused(store):
    first = contribute(store, create(store))
    second = create(store)
    entry = store.history("brian", first["id"])["contributions"][0]
    with pytest.raises(GoalNotFoundError):
        store.command("brian", command("reverse", goalId=second["id"], version=second["version"], contributionId=entry["id"]))
    assert store.list_goals("brian")["goals"][1]["balanceCents"] == 125_000


def test_edit_starting_balance_archive_restore_keep_history(store):
    goal = contribute(store, create(store))
    goal = store.command("brian", command("edit", goalId=goal["id"], version=goal["version"], name="Safety fund",
                                         targetCents=2_000_000, startingCents=200_000, targetDate=""))["goal"]
    assert goal["balanceCents"] == 225_000 and goal["contributionCount"] == 1
    goal = store.command("brian", command("archive", goalId=goal["id"], version=goal["version"]))["goal"]
    with pytest.raises(GoalConflictError, match="Restore"):
        contribute(store, goal)
    assert len(store.history("brian", goal["id"])["contributions"]) == 1
    goal = store.command("brian", command("restore", goalId=goal["id"], version=goal["version"]))["goal"]
    assert not goal["archived"] and goal["balanceCents"] == 225_000


@pytest.mark.parametrize("field,value", [("targetCents", 0), ("targetCents", 1.5), ("targetCents", True),
    ("targetCents", -1), ("targetCents", 10_000_000_001), ("startingCents", -1), ("name", " "),
    ("name", "a" * 81), ("name", "line\nbreak"), ("targetDate", "2027-02-30"), ("owner", "hannah")])
def test_invalid_creation_rolls_back_without_a_goal(store, field, value):
    body = command("create", name="Goal", targetCents=1000, startingCents=0)
    with pytest.raises(GoalValidationError):
        store.command("brian", {**body, field: value})
    assert store.list_goals("brian")["goals"] == []


def test_future_contribution_is_not_counted_as_money_already_saved(store):
    goal = create(store)
    with pytest.raises(GoalValidationError):
        store.command("brian", command("contribute", goalId=goal["id"], version=goal["version"], amountCents=100,
                                        date=(now_pacific().date() + timedelta(days=1)).isoformat()))
    assert store.list_goals("brian")["goals"] == [goal]


def test_history_pages_do_not_truncate_balance(store):
    goal = create(store)
    for _ in range(27):
        goal = contribute(store, goal, amount=100)
    first = store.history("brian", goal["id"])
    second = store.history("brian", goal["id"], offset=first["nextOffset"])
    assert len(first["contributions"]) == 25 and len(second["contributions"]) == 2
    assert second["nextOffset"] is None
    assert len({item["id"] for item in first["contributions"] + second["contributions"]}) == 27
    assert goal["balanceCents"] == 102_700
