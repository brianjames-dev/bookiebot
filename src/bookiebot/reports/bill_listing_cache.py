"""Short-lived, authenticated read reuse; never used by a bill mutation/review."""
from __future__ import annotations

import asyncio
from copy import deepcopy
import time
from typing import Any, Callable


class BillListingCache:
    """Use the report/widget task lifecycle without retaining browser storage."""
    seconds = 30

    def __init__(self) -> None:
        self.saved: dict[tuple, tuple[float, dict[str, Any]]] = {}
        self.tasks: dict[tuple, asyncio.Task[dict[str, Any]]] = {}

    async def read(self, key: tuple, build: Callable[[], dict[str, Any]], *, fresh: bool = False) -> dict[str, Any]:
        self.saved = {scope:value for scope,value in self.saved.items() if time.monotonic()-value[0] < self.seconds}
        if fresh:
            self.saved.pop(key,None)
        if key in self.saved:
            return deepcopy(self.saved[key][1])
        if key not in self.tasks:
            if len(self.tasks) >= 8:
                raise RuntimeError('Bills refresh is busy. Try again shortly.')
            started = time.monotonic()
            task = asyncio.create_task(asyncio.to_thread(build))
            self.tasks[key] = task
            task.add_done_callback(lambda completed:self._finished(key,started,completed))
        # Disconnecting one client cannot cancel a read another app is using.
        return deepcopy(await asyncio.shield(self.tasks[key]))

    def _finished(self, key: tuple, started: float, task: asyncio.Task[dict[str, Any]]) -> None:
        self.tasks.pop(key,None)
        if not task.cancelled() and task.exception() is None and time.monotonic()-started < self.seconds:
            self.saved[key] = (started,task.result())
            while len(self.saved) > 32:
                self.saved.pop(next(iter(self.saved)))

    async def close(self) -> None:
        await asyncio.gather(*self.tasks.values(),return_exceptions=True)
        self.saved.clear()
