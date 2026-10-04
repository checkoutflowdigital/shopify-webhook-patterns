"""Retry with exponential backoff and full jitter.

Transient failures (network errors, 429, 5xx) are retried; permanent failures
(validation errors, business rules) raise ``PermanentError`` and stop at once.
``sleep`` and ``random`` are injectable so tests run instantly.
"""

from __future__ import annotations

import random as _random
import time
from typing import Any, Callable


class PermanentError(Exception):
    """A failure that a retry cannot fix."""


class TransientError(Exception):
    """A failure worth retrying; ``retry_after`` (seconds) overrides the backoff."""

    def __init__(self, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after


def backoff_delay(attempt: int, base: float = 0.5, cap: float = 60.0, rand: Callable[[], float] = _random.random) -> float:
    """Delay before attempt ``attempt`` (1-based): random in [0, min(cap, base * 2**(attempt-1))]."""
    return rand() * min(cap, base * 2 ** (attempt - 1))


def retry(
    fn: Callable[[int], Any],
    max_attempts: int = 5,
    base: float = 0.5,
    cap: float = 60.0,
    sleep: Callable[[float], None] = time.sleep,
    rand: Callable[[], float] = _random.random,
    on_retry: Callable[[int, float, Exception], None] = lambda *_: None,
) -> Any:
    last: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return fn(attempt)
        except PermanentError:
            raise
        except Exception as err:  # noqa: BLE001 - we deliberately retry any transient error
            last = err
            if attempt == max_attempts:
                break
            retry_after = getattr(err, "retry_after", None)
            delay = retry_after if retry_after is not None else backoff_delay(attempt, base, cap, rand)
            on_retry(attempt, delay, err)
            sleep(delay)
    raise RuntimeError(f"retry: gave up after {max_attempts} attempts") from last
