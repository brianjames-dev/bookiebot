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
        self.active: set[asyncio.Task[dict[str, Any]]] = set()
        self.started: dict[asyncio.Task[Any], float] = {}

    async def read(self, key: tuple, build: Callable[[], dict[str, Any]], *, fresh: bool = False) -> dict[str, Any]:
        self.saved = {scope:value for scope,value in self.saved.items() if time.monotonic()-value[0] < self.seconds}
        if fresh:
            self.saved.pop(key,None)
        if key in self.saved:
            return deepcopy(self.saved[key][1])
        previous = self.tasks.get(key)
        if previous is None or fresh and previous in self.started:
            if len(self.active) >= 8:
                raise RuntimeError('Bills refresh is busy. Try again shortly.')
            # A refresh must read after its request, even if a direct workbook
            # edit has no SQL cursor. Queue behind the old reader, preserving
            # its clients; other requests can join this not-yet-started build.
            task = asyncio.create_task(self._build(build,previous))
            self.tasks[key] = task
            self.active.add(task)
            task.add_done_callback(lambda completed:self._finished(key,completed))
        # Disconnecting one client cannot cancel a read another app is using.
        return deepcopy(await asyncio.shield(self.tasks[key]))

    async def _build(self, build: Callable[[], dict[str, Any]], previous: asyncio.Task[dict[str, Any]] | None) -> dict[str, Any]:
        if previous is not None:
            try:
                await asyncio.shield(previous)
            except Exception:
                pass  # An explicit refresh retries the source, not its old error.
        task = asyncio.current_task()
        if task is not None:
            self.started[task] = time.monotonic()
        return await asyncio.to_thread(build)

    def _finished(self, key: tuple, task: asyncio.Task[dict[str, Any]]) -> None:
        current = self.tasks.get(key) is task
        if current:
            self.tasks.pop(key,None)
        self.active.discard(task)
        started = self.started.pop(task,None)
        if not task.cancelled() and task.exception() is None and current and started is not None and time.monotonic()-started < self.seconds:
            self.saved[key] = (started,task.result())
            while len(self.saved) > 32:
                self.saved.pop(next(iter(self.saved)))

    async def close(self) -> None:
        await asyncio.gather(*self.active,return_exceptions=True)
        self.saved.clear()
