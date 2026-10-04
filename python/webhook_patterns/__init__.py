"""Webhook integration patterns: HMAC verification, idempotency, retries.

Standard library only. See the repository README for the full walkthrough.
"""

from .verify_hmac import compute_shopify_hmac, verify_shopify_hmac
from .idempotency import InMemoryIdempotencyStore, idempotency_key, run_once
from .retry import PermanentError, backoff_delay, retry

__all__ = [
    "compute_shopify_hmac",
    "verify_shopify_hmac",
    "InMemoryIdempotencyStore",
    "idempotency_key",
    "run_once",
    "PermanentError",
    "backoff_delay",
    "retry",
]
