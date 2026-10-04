import unittest

from webhook_patterns import (
    InMemoryIdempotencyStore,
    PermanentError,
    backoff_delay,
    compute_shopify_hmac,
    idempotency_key,
    retry,
    run_once,
    verify_shopify_hmac,
)
from webhook_patterns.retry import TransientError

SECRET = "test-secret-not-a-real-credential"
BODY = b'{"id":1,"total_price":"10.00"}'


class VerifyHmacTests(unittest.TestCase):
    def test_valid_signature(self):
        self.assertTrue(verify_shopify_hmac(BODY, compute_shopify_hmac(BODY, SECRET), SECRET))

    def test_tampered_body(self):
        sig = compute_shopify_hmac(BODY, SECRET)
        self.assertFalse(verify_shopify_hmac(b'{"id":1,"total_price":"99.00"}', sig, SECRET))

    def test_wrong_secret_missing_header(self):
        self.assertFalse(verify_shopify_hmac(BODY, compute_shopify_hmac(BODY, "other"), SECRET))
        self.assertFalse(verify_shopify_hmac(BODY, None, SECRET))
        self.assertFalse(verify_shopify_hmac(BODY, "", SECRET))

    def test_requires_secret(self):
        with self.assertRaises(ValueError):
            verify_shopify_hmac(BODY, "x", "")


class IdempotencyTests(unittest.TestCase):
    def test_key_precedence(self):
        self.assertEqual(idempotency_key({"X-Shopify-Event-Id": "e1", "X-Shopify-Webhook-Id": "w1"}, {}, "t"), "event:e1")
        self.assertEqual(idempotency_key({"X-Shopify-Webhook-Id": "w1"}, {}, "t"), "webhook:w1")
        self.assertEqual(idempotency_key({}, {"id": 42, "updated_at": "2026-10-04T00:00:00Z"}, "orders/paid"),
                         "payload:orders/paid:42:2026-10-04T00:00:00Z")

    def test_runs_once(self):
        store = InMemoryIdempotencyStore()
        runs = []
        self.assertEqual(run_once(store, "k", lambda: runs.append(1))["ran"], True)
        self.assertEqual(run_once(store, "k", lambda: runs.append(1)), {"ran": False, "reason": "duplicate"})
        self.assertEqual(len(runs), 1)

    def test_release_on_failure(self):
        store = InMemoryIdempotencyStore()
        calls = {"n": 0}

        def flaky():
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("boom")
            return "ok"

        with self.assertRaises(RuntimeError):
            run_once(store, "k", flaky)
        self.assertTrue(run_once(store, "k", flaky)["ran"])

    def test_ttl(self):
        clock = {"t": 1000.0}
        store = InMemoryIdempotencyStore(ttl_seconds=10, now=lambda: clock["t"])
        self.assertTrue(store.claim("k"))
        self.assertFalse(store.claim("k"))
        clock["t"] = 1011.0
        self.assertTrue(store.claim("k"))


class RetryTests(unittest.TestCase):
    def test_backoff(self):
        one = lambda: 1.0  # noqa: E731
        self.assertEqual(backoff_delay(1, base=1, cap=8, rand=one), 1)
        self.assertEqual(backoff_delay(3, base=1, cap=8, rand=one), 4)
        self.assertEqual(backoff_delay(9, base=1, cap=8, rand=one), 8)

    def test_retries_then_succeeds(self):
        calls = {"n": 0}

        def fn(_attempt):
            calls["n"] += 1
            if calls["n"] < 3:
                raise TransientError("503")
            return "done"

        self.assertEqual(retry(fn, max_attempts=5, sleep=lambda _s: None), "done")
        self.assertEqual(calls["n"], 3)

    def test_permanent_stops(self):
        calls = {"n": 0}

        def fn(_attempt):
            calls["n"] += 1
            raise PermanentError("400")

        with self.assertRaises(PermanentError):
            retry(fn, max_attempts=5, sleep=lambda _s: None)
        self.assertEqual(calls["n"], 1)

    def test_retry_after_honoured(self):
        delays = []
        calls = {"n": 0}

        def fn(_attempt):
            calls["n"] += 1
            if calls["n"] == 1:
                raise TransientError("429", retry_after=1.5)
            return "ok"

        retry(fn, max_attempts=3, sleep=delays.append)
        self.assertEqual(delays, [1.5])

    def test_gives_up(self):
        with self.assertRaises(RuntimeError):
            retry(lambda _a: (_ for _ in ()).throw(TransientError("down")), max_attempts=2, sleep=lambda _s: None)


if __name__ == "__main__":
    unittest.main()
