"""A per-provider request limiter shared by every task in the process.

- RPM: requests are spaced at least 60/rpm seconds apart.
- TPM: the estimated tokens sent in the last 60 seconds stay under the limit.
- RPD: past the daily request limit the provider is reported as exhausted, so the
  pipeline moves to the fallback model instead of queueing for hours.

The wait is returned so each attempt can report how long it queued.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from datetime import date


class DailyLimitExhausted(RuntimeError):
    """The provider's requests-per-day budget is spent for today."""


class RateLimiter:
    def __init__(self, rpm: int, tpm: int | None = None, rpd: int | None = None) -> None:
        self.interval = 60.0 / max(rpm, 1)
        self.tpm = tpm
        self.rpd = rpd
        self._next_slot = 0.0
        self._lock = asyncio.Lock()
        self._tokens: deque[tuple[float, int]] = deque()
        self._day = date.today()
        self._today = 0

    def _tokens_in_window(self, now: float) -> int:
        while self._tokens and now - self._tokens[0][0] >= 60:
            self._tokens.popleft()
        return sum(n for _, n in self._tokens)

    async def acquire(self, tokens: int = 0) -> int:
        """Wait for the next free slot; return the wait in milliseconds."""
        started = time.monotonic()
        async with self._lock:
            if self.rpd is not None:
                if date.today() != self._day:
                    self._day, self._today = date.today(), 0
                if self._today >= self.rpd:
                    raise DailyLimitExhausted(f"daily limit of {self.rpd} requests reached")
                self._today += 1
            now = time.monotonic()
            slot = max(now, self._next_slot)
            if self.tpm is not None and tokens:
                need = min(tokens, self.tpm)
                while self._tokens_in_window(slot) + need > self.tpm and self._tokens:
                    # Wait until the oldest request leaves the 60-second window.
                    slot = max(slot, self._tokens[0][0] + 60)
                self._tokens.append((slot, need))
            self._next_slot = slot + self.interval
        delay = slot - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)
        return int((time.monotonic() - started) * 1000)


_limiters: dict[tuple[str, int], RateLimiter] = {}


def limiter_for(
    provider: str, rpm: int, tpm: int | None = None, rpd: int | None = None
) -> RateLimiter:
    # Keyed with the event loop id: asyncio locks are bound to one loop, and
    # tests and CLI runs each start their own.
    key = (provider, id(asyncio.get_running_loop()))
    limiter = _limiters.get(key)
    if limiter is None:
        limiter = _limiters[key] = RateLimiter(rpm, tpm, rpd)
    return limiter
