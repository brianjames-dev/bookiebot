"""Read-only app presentation of accepted, guarded background inverses.

Canonical writers and their versions never consume this display projection.
"""
from __future__ import annotations

from typing import Any


def display_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    result = snapshot
    for job in snapshot.get('undoJobs', []):
        display = job.get('display')
        if job['status'] != 'queued' or not display:
            continue
        by_id = {row['id']: row for row in result['allocations']}
        if any(row['id'] not in by_id or by_id[row['id']]['version'] != row['version'] or row['id'] in result.get('displayAllocationIds', []) for row in display['allocations']):
            continue
        updates = {row['id']: row for row in display['allocations']}
        event_ids = set(display['eventIds'])
        reset = display.get('reset', {})
        result = {**result, 'displayPending': True, 'displayAllocationIds': list(set(result.get('displayAllocationIds', [])) | set(updates)), 'projectionPending': True,
                  'allocations': [{**row, **updates[row['id']]} if row['id'] in updates else row for row in result['allocations']],
                  'events': [{**event, 'status': 'reversed'} if event['id'] in event_ids else event for event in result['events']],
                  'resets': [{**row, 'status': reset['status'], 'canUndo': False, 'canRedo': False} if row['id'] == reset.get('id') else row for row in result.get('resets', [])]}
    return result
