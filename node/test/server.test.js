'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/server');
const { computeShopifyHmac } = require('../src/verify-hmac');
const { InMemoryIdempotencyStore } = require('../src/idempotency');
const { InProcessQueue } = require('../src/retry');

const SECRET = 'test-secret-not-a-real-credential';

function post(server, body, headers) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/webhooks/shopify', method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer(fn) {
  const logs = [];
  const queue = new InProcessQueue({ retryOptions: { maxAttempts: 1 }, onFailed: (f) => logs.push(`failed:${f.job}`) });
  const server = createApp({ secret: SECRET, store: new InMemoryIdempotencyStore(), queue, log: (m) => logs.push(m) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(server, logs, queue); } finally { server.close(); }
}

test('rejects an unsigned delivery with 401 and never parses it', () => withServer(async (server, logs) => {
  const res = await post(server, 'not even json', { 'content-type': 'application/json' });
  assert.equal(res.status, 401);
  assert.ok(logs.some((l) => l.includes('invalid HMAC')));
}));

test('accepts a signed delivery and processes it once', () => withServer(async (server, logs, queue) => {
  const body = JSON.stringify({ id: 1001, total_price: '42.00', currency: 'EUR' });
  const headers = {
    'content-type': 'application/json',
    'x-shopify-hmac-sha256': computeShopifyHmac(body, SECRET),
    'x-shopify-topic': 'orders/paid',
    'x-shopify-shop-domain': 'example.myshopify.com',
    'x-shopify-webhook-id': 'whk-1',
    'x-shopify-event-id': 'evt-1',
  };
  const first = await post(server, body, headers);
  const second = await post(server, body, headers); // the retry: same webhook id
  await queue.idle;

  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.body).duplicate, false);
  assert.equal(second.status, 200);
  assert.equal(JSON.parse(second.body).duplicate, true);
  assert.equal(logs.filter((l) => l.startsWith('orders/paid')).length, 1);
}));

test('two subscriptions sharing an event id are both processed', () => withServer(async (server, logs, queue) => {
  // One merchant action, two subscriptions: Shopify sends one delivery per
  // subscription, each with its own X-Shopify-Webhook-Id and the same X-Shopify-Event-Id.
  const body = JSON.stringify({ id: 1002, total_price: '10.00', currency: 'EUR' });
  const headers = (webhookId) => ({
    'x-shopify-hmac-sha256': computeShopifyHmac(body, SECRET),
    'x-shopify-topic': 'orders/paid',
    'x-shopify-shop-domain': 'example.myshopify.com',
    'x-shopify-webhook-id': webhookId,
    'x-shopify-event-id': 'evt-shared',
  });
  const first = await post(server, body, headers('whk-sub-a'));
  const second = await post(server, body, headers('whk-sub-b'));
  await queue.idle;

  assert.equal(JSON.parse(first.body).duplicate, false);
  assert.equal(JSON.parse(second.body).duplicate, false);
  assert.equal(logs.filter((l) => l.startsWith('orders/paid')).length, 2);
}));

test('unknown topic is a permanent failure, not a retry loop', () => withServer(async (server, logs, queue) => {
  const body = JSON.stringify({ id: 7 });
  const res = await post(server, body, {
    'x-shopify-hmac-sha256': computeShopifyHmac(body, SECRET),
    'x-shopify-topic': 'carts/update',
    'x-shopify-webhook-id': 'whk-2',
  });
  await queue.idle;
  assert.equal(res.status, 200);
  assert.ok(logs.includes('failed:webhook:whk-2'));
}));
