"""A dependency-free webhook receiver (standard library ``http.server``).

    raw body -> verify HMAC -> claim idempotency key -> enqueue -> 200

Run:   SHOPIFY_WEBHOOK_SECRET=... python app.py
Test:  SHOPIFY_WEBHOOK_SECRET=... node ../node/scripts/send-test-webhook.js http://127.0.0.1:8000/webhooks/shopify

The in-process worker thread stands in for a durable queue. In production,
hand the event to a real queue so that a 2xx never means "silently lost".
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from webhook_patterns import (
    InMemoryIdempotencyStore,
    PermanentError,
    idempotency_key,
    retry,
    run_once,
    verify_shopify_hmac,
)

MAX_BODY_BYTES = 1024 * 1024
SECRET = os.environ.get("SHOPIFY_WEBHOOK_SECRET")
STORE = InMemoryIdempotencyStore()
JOBS: "queue.Queue[tuple[str, dict]]" = queue.Queue()


def process_event(topic: str, shop_domain: str, payload: dict) -> None:
    """Replace with your accounting / ERP / CRM call."""
    if topic == "orders/paid":
        print(f"[webhook] orders/paid from {shop_domain}: order {payload.get('id')} "
              f"({payload.get('total_price')} {payload.get('currency')})")
    elif topic == "refunds/create":
        print(f"[webhook] refunds/create from {shop_domain}: refund {payload.get('id')}")
    else:
        raise PermanentError(f"no handler for topic {topic}")


def worker() -> None:
    while True:
        key, job = JOBS.get()
        try:
            retry(lambda _attempt: process_event(**job), max_attempts=5)
        except Exception as err:  # noqa: BLE001
            print(f"[queue] job {key} failed for good: {err}", file=sys.stderr)
        finally:
            JOBS.task_done()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 - http.server naming
        if self.path != "/webhooks/shopify":
            self.send_response(404); self.end_headers(); return

        length = int(self.headers.get("content-length", "0"))
        if length > MAX_BODY_BYTES:
            self.send_response(413); self.end_headers(); return
        raw = self.rfile.read(length)

        if not verify_shopify_hmac(raw, self.headers.get("x-shopify-hmac-sha256"), SECRET):
            print("[webhook] rejected: invalid HMAC")
            self.send_response(401); self.end_headers(); return

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self.send_response(400); self.end_headers(); return

        topic = self.headers.get("x-shopify-topic", "")
        shop_domain = self.headers.get("x-shopify-shop-domain", "")
        key = idempotency_key(dict(self.headers), payload, topic)

        outcome = run_once(STORE, key, lambda: JOBS.put((key, {"topic": topic, "shop_domain": shop_domain, "payload": payload})))
        if not outcome["ran"]:
            print(f"[webhook] duplicate delivery ignored: {key}")

        body = json.dumps({"received": True, "duplicate": not outcome["ran"]}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:  # keep the console readable
        pass


if __name__ == "__main__":
    if not SECRET:
        sys.exit("SHOPIFY_WEBHOOK_SECRET is not set. Copy ../.env.example to .env and fill it in.")
    threading.Thread(target=worker, daemon=True).start()
    port = int(os.environ.get("PORT", "8000"))
    print(f"webhook receiver listening on http://127.0.0.1:{port}/webhooks/shopify")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
