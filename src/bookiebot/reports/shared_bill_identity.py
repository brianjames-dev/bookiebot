"""Resolve bill sources from canonical split lineage without changing money.

Old income-row allocations predate bill IDs. Their trusted owner pair, original
action/month and exact budget source label can identify one plan. Display names
alone, ambiguous sources and an explicit different bill ID never qualify.
"""
from __future__ import annotations

import calendar
from collections.abc import Iterable
from typing import Any

from bookiebot.sheets.bills import bill_label_key


def source_index(sources: Iterable[tuple[str, str]]) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    for identity, label in sources:
        if identity and label:
            result.setdefault(bill_label_key(label), set()).add(identity)
    return result


def related_allocations(allocations: list[dict[str, Any]], *, plan_id: str,
                        payer: str, member: str, sources: dict[str, set[str]],
                        starts: dict[str, str] | None = None) -> list[dict[str, Any]]:
    def matches(value: dict[str, Any]) -> bool:
        if value.get('payerOwner') != payer or value.get('partnerOwner') != member:
            return False
        if value.get('billPlanId'):
            return value['billPlanId'] == plan_id
        if (value.get('sourceWorksheet') != 'income' or not value.get('sourceActionId')
                or not isinstance(value.get('sourceYear'), int)
                or value.get('sourceSheetTitle') not in calendar.month_name[1:]):
            return False
        label = value.get('sourceValues', {}).get('item') or value.get('item') or value.get('category', '')
        period = f"{value['sourceYear']:04d}-{list(calendar.month_name).index(value['sourceSheetTitle']):02d}"
        return sources.get(bill_label_key(label)) == {plan_id} and period >= (starts or {}).get(plan_id, '0001-01')
    return [a for a in allocations if matches(a)]


def member_source(related: list[dict[str, Any]], sources: dict[str, set[str]]) -> str:
    candidates: set[str] = set()
    for value in related:
        if value.get('lifecycle', 'active') != 'active':
            continue
        label = value.get('partnerSourceLabel') or value.get('category', '')
        matches = sources.get(bill_label_key(label), set())
        if len(matches) > 1:
            return ''
        candidates.update(matches)
    return next(iter(candidates)) if len(candidates) == 1 else ''
