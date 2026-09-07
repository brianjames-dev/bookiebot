from typing import Any


def default_expense_report_persons(
    owner_name: str,
    persons: list[str],
    requested_person: Any = None,
) -> list[str]:
    """Keep the ordinary personal report scope consistent across entry points."""
    requested = str(requested_person or "").strip().lower()
    brian_cards = {"Brian (BofA)", "Brian (AL)"}
    if owner_name == "Brian" and set(persons) == brian_cards and requested in {"", "brian"}:
        return ["Brian (BofA)"]
    return persons
