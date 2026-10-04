'use strict';

/**
 * A complete webhook receiver, dependency-free, that applies the four patterns
 * in the right order:
 *
 *   raw body  →  verify HMAC  →  claim idempotency key  →  enqueue  →  200
 *
 * Everything slow happens after the response, in the queue. The sender sees a
 * fast 2xx, which is what stops it from retrying.
 *
 * Configuration comes from the environment only (see ../.env.example). There
 * is no secret in this file and there must never be one in any committed file.
 *
 * Run:   SHOPIFY_WEBHOOK_SECRET=... node src/server.js
 * Test:  node scripts/send-test-webhook.js  (signs a sample payload and posts it)
 */

const http = require('node:http');
const { verifyShopifyHmac } = require('./verify-hmac');
const { InMemoryIdempotencyStore, idempotencyKey, runOnce } = require('./idempotency');
const { InProcessQueue, PermanentError } = require('./retry');

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB: well above any Shopify webhook payload

/** Read the raw body without parsing it; reject oversized requests early. */
function readRawBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * The business handler. Replace with a call to your accounting/ERP/CRM API.
 * Throw PermanentError for failures a retry cannot fix.
 */
async function processEvent({ topic, shopDomain, payload, log }) {
  switch (topic) {
    case 'orders/paid':
      log(`orders/paid from ${shopDomain}: order ${payload.id} (${payload.total_price} ${payload.currency})`);
      // await accounting.createSale(payload)
      return;
    case 'refunds/create':
      log(`refunds/create from ${shopDomain}: refund ${payload.id} on order ${payload.order_id}`);
      return;
    default:
      // An unknown topic is a configuration problem, not a transient failure.
      throw new PermanentError(`no handler for topic ${topic}`);
  }
}

function createApp({
  secret = process.env.SHOPIFY_WEBHOOK_SECRET,
  store = new InMemoryIdempotencyStore(),
  queue = new InProcessQueue({
    retryOptions: { maxAttempts: 5 },
    onFailed: ({ job, error }) => console.error(`[queue] job ${job} failed for good:`, error.message),
  }),
  log = (msg) => console.log(`[webhook] ${msg}`),
} = {}) {
  if (!secret) {
    throw new Error('SHOPIFY_WEBHOOK_SECRET is not set. Copy .env.example to .env and fill it in.');
  }

  return http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhooks/shopify') {
      res.writeHead(404).end();
      return;
    }

    let raw;
    try {
      raw = await readRawBody(req);
    } catch (err) {
      res.writeHead(err.statusCode || 400).end();
      return;
    }

    // 1. Authenticate the delivery before touching the body.
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    if (!verifyShopifyHmac(raw, hmacHeader, secret)) {
      log('rejected: invalid HMAC');
      res.writeHead(401).end();
      return;
    }

    // 2. Only now parse the JSON.
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      res.writeHead(400).end();
      return;
    }

    const topic = req.headers['x-shopify-topic'];
    const shopDomain = req.headers['x-shopify-shop-domain'];
    const key = idempotencyKey(req.headers, payload, topic);

    // 3. Claim the key; a duplicate is acknowledged, never reprocessed.
    const outcome = await runOnce(store, key, async () => {
      // 4. Hand the work to the queue and return immediately.
      queue.enqueue(key, () => processEvent({ topic, shopDomain, payload, log }));
    });

    if (!outcome.ran) log(`duplicate delivery ignored: ${key}`);

    // 5. Fast acknowledgement. The sender's job is done; ours continues in the queue.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ received: true, duplicate: !outcome.ran }));
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => {
    console.log(`webhook receiver listening on http://127.0.0.1:${port}/webhooks/shopify`);
  });
}

module.exports = { createApp, readRawBody, processEvent };
