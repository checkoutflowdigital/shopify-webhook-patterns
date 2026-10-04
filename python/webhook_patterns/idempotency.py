"""Idempotent webhook processing.

Webhooks are delivered at least once. The same event can arrive twice, minutes
apart, sometimes out of order. A ledger of processed event identifiers makes
the second delivery harmless:

1. Derive a stable key (``X-Shopify-Event-Id`` is stable across retries;
   ``X-Shopify-Webhook-Id`` is per delivery; last resort: topic + id + updated_at).
2. Claim the key *before* doing any work. Already claimed: acknowledge and stop.
3. If the work fails, release the claim so a retry can run.

The in-memory store is for tests and single-process demos. In production the
ledger must be shared by every worker: a table with a unique constraint, or
Redis ``SET key value NX EX ttl``.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping


@dataclass
class _Claim:
    state: str  # "processing" | "done"
    at: float


@dataclass
class InMemoryIdempotencyStore:
    ttl_seconds: float = 7 * 24 * 3600
    now: Callable[[], float] = time.time
    _claims: dict[str, _Claim] = field(default_factory=dict)

    def claim(self, key: str) -> bool:
        self._evict_expired()
        if key in self._claims:
            return False
        self._claims[key] = _Claim("processing", self.now())
        return True

    def mark_done(self, key: str) -> None:
        if key in self._claims:
            self._claims[key].state = "done"

    def release(self, key: str) -> None:
        claim = self._claims.get(key)
        if claim and claim.state == "processing":
            del self._claims[key]

    def __contains__(self, key: str) -> bool:
        self._evict_expired()
        return key in self._claims

    def _evict_expired(self) -> None:
        cutoff = self.now() - self.ttl_seconds
        for key in [k for k, c in self._claims.items() if c.at < cutoff]:
            del self._claims[key]


def idempotency_key(headers: Mapping[str, str], payload: Mapping[str, Any], topic: str) -> str:
    """Build a stable key from headers (lower-cased names) or, failing that, the payload."""
    lowered = {k.lower(): v for k, v in headers.items()}
    if lowered.get("x-shopify-event-id"):
        return f"event:{lowered['x-shopify-event-id']}"
    if lowered.get("x-shopify-webhook-id"):
        return f"webhook:{lowered['x-shopify-webhook-id']}"
    resource_id = payload.get("id", payload.get("admin_graphql_api_id", "unknown"))
    version = payload.get("updated_at", payload.get("created_at", ""))
    return f"payload:{topic}:{resource_id}:{version}"


def run_once(store: InMemoryIdempotencyStore, key: str, work: Callable[[], Any]) -> dict[str, Any]:
    """Run ``work`` at most once for ``key``.

    Returns ``{"ran": True, "result": ...}`` or ``{"ran": False, "reason": "duplicate"}``.
    Re-raises errors from ``work`` after releasing the claim.
    """
    if not store.claim(key):
        return {"ran": False, "reason": "duplicate"}
    try:
        result = work()
    except Exception:
        store.release(key)
        raise
    store.mark_done(key)
    return {"ran": True, "result": result}
