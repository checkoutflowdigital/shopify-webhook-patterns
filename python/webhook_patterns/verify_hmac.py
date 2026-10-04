"""Verify a Shopify webhook signature (HMAC-SHA256, base64, over the raw body).

The two rules that matter:

1. Hash the raw request bytes. Do not parse and re-serialise the JSON first:
   whitespace and key order change, and the signature will never match.
2. Compare with ``hmac.compare_digest``. A plain ``==`` leaks timing
   information that lets an attacker forge signatures byte by byte.

Most payment providers sign webhooks the same way; only the header name and
the encoding (hex vs base64) differ.
"""

from __future__ import annotations

import base64
import hashlib
import hmac


def compute_shopify_hmac(raw_body: bytes, secret: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).digest()
    return base64.b64encode(digest).decode("ascii")


def verify_shopify_hmac(raw_body: bytes, header_value: str | None, secret: str) -> bool:
    if not secret:
        raise ValueError("verify_shopify_hmac: secret is required")
    if not header_value:
        return False
    expected = compute_shopify_hmac(raw_body, secret)
    return hmac.compare_digest(expected, header_value)
