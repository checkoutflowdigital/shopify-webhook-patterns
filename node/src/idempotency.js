'use strict';

/**
 * Idempotent webhook processing.
 *
 * Webhooks are delivered *at least once*. A delivery that times out, or a
 * retry after a 5xx from your side, means the same event can arrive twice,
 * sometimes minutes apart and sometimes out of order. If your handler creates
 * an invoice, sends an email or adjusts stock, running it twice is a bug a
 * customer will notice.
 *
 * The fix is a small ledger of delivery identifiers you have already processed:
 *
 *   1. Derive a stable key for the delivery. Shopify documents
 *      `X-Shopify-Webhook-Id` as the header to detect duplicate deliveries
 *      (a retried delivery carries the same id). Do not key on
 *      `X-Shopify-Event-Id`: every subscription triggered by the same merchant
 *      action receives its own delivery with the same event id, so keying on it
 *      would drop legitimate deliveries. The event id is for correlating those
 *      deliveries, not for deduplicating them. If the webhook id is missing,
 *      fall back to topic + resource id + updated_at.
 *   2. Before doing any work, try to *claim* the key. If it is already claimed,
 *      acknowledge the delivery (2xx) and stop.
 *   3. If the work fails, release the claim so a retry can try again.
 *
 * The ledger must be shared by every process that handles webhooks: in
 * production that means a database table with a unique constraint, or a Redis
 * `SET key NX EX ttl`. The in-memory store below is for tests and single-process
 * demos only; it is reset every time the process restarts.
 */

class InMemoryIdempotencyStore {
  constructor({ ttlMs = 7 * 24 * 60 * 60 * 1000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.claims = new Map(); // key -> { state: 'processing' | 'done', at }
  }

  /** @returns {boolean} true if the key was free and is now claimed. */
  claim(key) {
    this._evictExpired();
    if (this.claims.has(key)) return false;
    this.claims.set(key, { state: 'processing', at: this.now() });
    return true;
  }

  markDone(key) {
    const entry = this.claims.get(key);
    if (entry) entry.state = 'done';
  }

  release(key) {
    const entry = this.claims.get(key);
    if (entry && entry.state === 'processing') this.claims.delete(key);
  }

  has(key) {
    this._evictExpired();
    return this.claims.has(key);
  }

  _evictExpired() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.claims) {
      if (entry.at < cutoff) this.claims.delete(key);
    }
  }
}

/**
 * Build a stable idempotency key for a webhook delivery.
 * @param {Record<string, string|undefined>} headers lower-cased header names
 * @param {object} payload parsed JSON body
 */
function idempotencyKey(headers, payload, topic) {
  const webhookId = headers['x-shopify-webhook-id'];
  if (webhookId) return `webhook:${webhookId}`;

  // Last resort: a deterministic key built from the payload itself. This
  // deduplicates the same version of a resource, but not two distinct updates.
  const id = payload && (payload.id ?? payload.admin_graphql_api_id ?? 'unknown');
  const version = payload && (payload.updated_at ?? payload.created_at ?? '');
  return `payload:${topic}:${id}:${version}`;
}

/**
 * Run `work` at most once for `key`.
 * Returns { ran: true } when the work ran, { ran: false, reason: 'duplicate' }
 * when the key had already been claimed. Rethrows errors from `work` after
 * releasing the claim, so the caller can return a 5xx and let the sender retry.
 */
async function runOnce(store, key, work) {
  if (!store.claim(key)) return { ran: false, reason: 'duplicate' };
  try {
    const result = await work();
    store.markDone(key);
    return { ran: true, result };
  } catch (err) {
    store.release(key);
    throw err;
  }
}

module.exports = { InMemoryIdempotencyStore, idempotencyKey, runOnce };
