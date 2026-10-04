# Shopify webhook patterns

Small, dependency-free examples of the four things a webhook receiver must get right before it can be trusted with orders, payments or stock:

1. **Verify the signature** (HMAC-SHA256 over the raw body, constant-time comparison).
2. **Process each delivery once** (idempotency ledger keyed on the webhook delivery id).
3. **Acknowledge fast, work later** (queue with retries, exponential backoff and jitter).
4. **Reconcile on a schedule** (ask the API what changed, so a missed webhook is never a lost order).

Examples are provided in **Node.js** (standard library only, Node 18+) and **Python** (standard library only, 3.10+). Each pattern is a single readable file. Signature verification, idempotency and retries have tests in both languages, and the Node.js receiver (`node/src/server.js`) has its own; the reconciliation job (`node/src/reconcile.js`, Node.js only) has no dedicated test. Nothing here needs `npm install` or `pip install`.

Maintained by **Checkout Flow — Commerce & Payment Integration** · [checkoutflowdigital.com](https://checkoutflowdigital.com)

---

## Why these four patterns

A webhook is the other platform telling you that something happened. It is fast, but it comes with three guarantees you have to design around:

| The platform guarantees… | …so your receiver must |
|---|---|
| Delivery **at least once**: retries after timeouts and 5xx responses produce duplicates, sometimes out of order | keep a ledger of processed delivery ids and skip repeats |
| A **retry window**, not forever: Shopify documents that failed deliveries are retried a limited number of times over a few hours, then dropped | run a scheduled reconciliation through the API to catch what was missed |
| **Public reachability**: anyone can POST to your endpoint | verify the HMAC signature before parsing anything |
| A **short timeout** for your 2xx | record the event and return immediately; do the slow work afterwards |

If you want the reasoning behind webhooks vs. API calls, with an e-commerce example (a paid order reaching an accounting tool), it is written up here: [Webhook vs API: what's the difference, with e-commerce examples](https://checkoutflowdigital.com/blogs/guides/webhook-vs-api). This repository is the code side of that guide.

## Layout

```
node/
  src/verify-hmac.js     HMAC-SHA256 verification, constant-time
  src/idempotency.js     idempotency key derivation + run-once ledger
  src/retry.js           backoff with full jitter, PermanentError, in-process queue
  src/server.js          complete receiver: raw body → verify → claim → enqueue → 200
  src/reconcile.js       scheduled catch-up through the Admin GraphQL API (pagination, throttling)
  scripts/send-test-webhook.js   signs a sample payload and posts it to your local receiver
  test/                  node --test, 20 tests
python/
  webhook_patterns/      same three patterns (verify_hmac, idempotency, retry)
  app.py                 complete receiver on http.server with a worker thread
  tests/                 unittest, 13 tests
examples/payloads/       synthetic orders/paid payload for local testing
.env.example             the only configuration; copy to .env, never commit it
```

## Quick start

```bash
# Node receiver
cd node
SHOPIFY_WEBHOOK_SECRET=local-dev-secret npm start
# in another terminal: send the same signed delivery twice (same X-Shopify-Webhook-Id, like a retry)
SHOPIFY_WEBHOOK_SECRET=local-dev-secret npm run send
SHOPIFY_WEBHOOK_SECRET=local-dev-secret npm run send
# → 200 {"received":true,"duplicate":false}
# → 200 {"received":true,"duplicate":true}

# Python receiver (same test script)
cd python
SHOPIFY_WEBHOOK_SECRET=local-dev-secret python app.py
SHOPIFY_WEBHOOK_SECRET=local-dev-secret node ../node/scripts/send-test-webhook.js http://127.0.0.1:8000/webhooks/shopify

# Tests
(cd node && npm test)
(cd python && python -m unittest discover -s tests -v)
```

To receive real deliveries, point a Shopify webhook subscription at your public URL (`https://…/webhooks/shopify`) and set `SHOPIFY_WEBHOOK_SECRET` to the signing secret Shopify shows for that subscription.

## The patterns, one by one

### 1. Signature verification

```js
const { verifyShopifyHmac } = require('./src/verify-hmac');
if (!verifyShopifyHmac(rawBodyBuffer, req.headers['x-shopify-hmac-sha256'], secret)) {
  return res.writeHead(401).end();
}
```

Two mistakes account for most "my HMAC never matches" issues:

- **Hashing a re-serialised body.** Frameworks that parse JSON before your code runs change whitespace and key order. Capture the raw bytes (the examples read the stream themselves).
- **Comparing with `===`.** Use `crypto.timingSafeEqual` / `hmac.compare_digest`. Length must be checked first in Node, since `timingSafeEqual` throws on unequal lengths.

The same shape (HMAC over the raw body, base64 or hex in a header) applies to most payment providers; only the header name and encoding change.

### 2. Idempotency

```js
const key = idempotencyKey(req.headers, payload, topic); // webhook:<X-Shopify-Webhook-Id>
const outcome = await runOnce(store, key, () => queue.enqueue(key, work));
// outcome.ran === false → duplicate, acknowledged and skipped
```

Key precedence: `X-Shopify-Webhook-Id` (the header Shopify documents for detecting duplicate deliveries; a retried delivery carries the same id) → `topic + resource id + updated_at` when that header is absent (the reconciliation job, which has no delivery headers, uses this form).

`X-Shopify-Event-Id` is deliberately not a key. When one merchant action triggers several subscriptions, Shopify sends one delivery per subscription: each has its own `X-Shopify-Webhook-Id`, and all of them share the same `X-Shopify-Event-Id`. Keying on the event id would acknowledge the second delivery as a duplicate and drop it. Use the event id to correlate those deliveries, for example in logs.

`InMemoryIdempotencyStore` is for tests and demos. In production the ledger must be shared by every worker: a table with a unique constraint on the key, or Redis `SET key NX EX <ttl>`. Keep webhook claims for at least the sender's retry window, and reconciliation claims for longer than the overlap between two runs.

### 3. Retries and the queue

```js
await retry(() => accounting.createSale(order), { maxAttempts: 5 });
// throw new PermanentError('…') from the work to stop retrying immediately
```

- Full-jitter exponential backoff (`random × min(cap, base × 2^(attempt−1))`) spreads retries after an outage.
- An error with `retryAfterMs` (set from a `Retry-After` header or a GraphQL `THROTTLED` extension) overrides the backoff.
- `PermanentError` separates "the other API is down" from "this request will never succeed"; the latter goes to `onFailed` for logging and alerting instead of looping.

`InProcessQueue` loses its jobs if the process dies. It exists to make the pattern runnable in one file; in production use a durable queue so that a 2xx never means "silently lost".

### 4. Scheduled reconciliation

`src/reconcile.js` pages through orders updated since the last run with the Admin GraphQL API (`sortKey: UPDATED_AT`, `query: "updated_at:>=…"`), handles `429` and `THROTTLED` with `retryAfterMs`, and calls your `handle` function for each order. Run it hourly or daily with an overlap (the example looks back two hours).

Its `runOnce` ledger, given a store that persists between runs, only stops overlapping runs from handling the same order version twice. It does not know which orders a webhook already processed: webhook deliveries are keyed `webhook:<X-Shopify-Webhook-Id>`, reconciled orders `payload:reconcile:orders:<id>:<updatedAt>`, and the two never match. So pass the same business handler your webhook worker uses, and make that handler prevent the business duplicate itself with an order-level check: for example, has a sale already been created for this order? (look it up by order id in your own records, or by external reference in the target system). Make it atomic, for example with a unique constraint on the order id, so a webhook and a reconciliation run handling the same order at the same moment can't both pass it. That check is what lets reconciliation fill the gaps without creating a second sale.

## Security notes

- **Secrets live in the environment only.** `.env` is git-ignored; `.env.example` has empty values. Nothing in this repository is a real credential, shop domain or customer record.
- **Never put an Admin API token or webhook secret in theme or browser code.** The reconciliation job runs on a server.
- **Verify before you parse.** Unsigned requests are rejected with 401 before `JSON.parse` runs, and bodies over 1 MiB are rejected with 413.
- **Request only the scopes the job needs** (`read_orders` for the reconciliation example).
- **Log the outcome of every delivery** (accepted, duplicate, rejected, failed-for-good); a webhook integration without logs cannot be debugged.

If you find a security issue in these examples, please open an issue; there is no bug bounty, but reports are read and fixed.

## What this repository is not

It is not a framework, an npm package or a drop-in integration. It is reference code to copy into your own service and adapt: swap the in-memory store for your database, the in-process queue for your queue, and `processEvent` for your real business logic.

## Contributing

Issues and pull requests are welcome, in English or French. Keep the zero-dependency constraint, add a test for any behaviour change, and run both suites before opening a PR.

## License

[MIT](LICENSE) © 2026 Checkout Flow — Commerce & Payment Integration.

Checkout Flow builds custom Shopify and e-commerce integrations: payment providers connected to Shopify, accounting/ERP/CRM connections through official APIs, and e-commerce automation. Independent provider, not affiliated with Shopify. [checkoutflowdigital.com](https://checkoutflowdigital.com) · [API integration services](https://checkoutflowdigital.com/pages/api-integrations-automation)
