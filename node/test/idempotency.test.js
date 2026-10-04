'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { InMemoryIdempotencyStore, idempotencyKey, runOnce } = require('../src/idempotency');

test('keys on the webhook id, never on the event id, then on a payload-derived key', () => {
  assert.equal(idempotencyKey({ 'x-shopify-event-id': 'e1', 'x-shopify-webhook-id': 'w1' }, {}, 't'), 'webhook:w1');
  // Same event id, two subscriptions: two distinct deliveries, two distinct keys.
  assert.notEqual(idempotencyKey({ 'x-shopify-event-id': 'e1', 'x-shopify-webhook-id': 'w2' }, {}, 't'), 'webhook:w1');
  assert.equal(idempotencyKey({ 'x-shopify-event-id': 'e1' }, { id: 42, updated_at: '2026-10-04T00:00:00Z' }, 'orders/paid'),
    'payload:orders/paid:42:2026-10-04T00:00:00Z');
  assert.equal(idempotencyKey({}, { id: 42, updated_at: '2026-10-04T00:00:00Z' }, 'orders/paid'),
    'payload:orders/paid:42:2026-10-04T00:00:00Z');
});

test('runs the work exactly once for the same key', async () => {
  const store = new InMemoryIdempotencyStore();
  let runs = 0;
  const work = async () => { runs += 1; return 'ok'; };

  const first = await runOnce(store, 'event:1', work);
  const second = await runOnce(store, 'event:1', work);

  assert.deepEqual(first, { ran: true, result: 'ok' });
  assert.deepEqual(second, { ran: false, reason: 'duplicate' });
  assert.equal(runs, 1);
});

test('releases the claim when the work fails, so a retry can run', async () => {
  const store = new InMemoryIdempotencyStore();
  let runs = 0;
  const flaky = async () => { runs += 1; if (runs === 1) throw new Error('boom'); return 'ok'; };

  await assert.rejects(runOnce(store, 'event:2', flaky), /boom/);
  const retry = await runOnce(store, 'event:2', flaky);
  assert.equal(retry.ran, true);
  assert.equal(runs, 2);
});

test('expires claims after the TTL', () => {
  let t = 1_000;
  const store = new InMemoryIdempotencyStore({ ttlMs: 100, now: () => t });
  assert.equal(store.claim('k'), true);
  assert.equal(store.claim('k'), false);
  t = 1_201;
  assert.equal(store.claim('k'), true);
});
