"""A per-provider request limiter shared by every task in the process.

Requests are spaced at least 60/rpm seconds apart per provider, so a burst of
parallel evaluations cannot trip the free tier's limit. The wait is returned so
each attempt can report how long it queued.
"""

from __future__ import annotations

import asyncio
import time


class RateLimiter:
    def __init__(self, rpm: int) -> None:
        self.interval = 60.0 / max(rpm, 1)
        self._next_slot = 0.0
        self._lock = asyncio.Lock()

    async def acquire(self) -> int:
        """Wait for the next free slot; return the wait in milliseconds."""
        started = time.monotonic()
        async with self._lock:
            now = time.monotonic()
            slot = max(now, self._next_slot)
            self._next_slot = slot + self.interval
        delay = slot - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)
        return int((time.monotonic() - started) * 1000)


_limiters: dict[tuple[str, int], RateLimiter] = {}


def limiter_for(provider: str, rpm: int) -> RateLimiter:
    # Keyed with the event loop id: asyncio locks are bound to one loop, and
    # tests and CLI runs each start their own.
    key = (provider, id(asyncio.get_running_loop()))
    limiter = _limiters.get(key)
    if limiter is None:
        limiter = _limiters[key] = RateLimiter(rpm)
    return limiter
