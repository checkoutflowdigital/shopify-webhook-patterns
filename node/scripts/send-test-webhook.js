#!/usr/bin/env node
'use strict';

/**
 * Sign a sample payload the way Shopify does and post it to a local receiver.
 *
 *   SHOPIFY_WEBHOOK_SECRET=... node scripts/send-test-webhook.js [url] [topic] [payload.json]
 *
 * Send it twice to watch the second delivery be acknowledged as a duplicate.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { computeShopifyHmac } = require('../src/verify-hmac');

const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
if (!secret) {
  console.error('Set SHOPIFY_WEBHOOK_SECRET (any value works locally; use the same one for the server).');
  process.exit(1);
}

const url = new URL(process.argv[2] || 'http://127.0.0.1:3000/webhooks/shopify');
const topic = process.argv[3] || 'orders/paid';
const payloadPath = process.argv[4] || path.join(__dirname, '..', '..', 'examples', 'payloads', 'orders-paid.sample.json');
const body = fs.readFileSync(payloadPath);

const req = http.request({
  host: url.hostname,
  port: url.port,
  path: url.pathname,
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-shopify-topic': topic,
    'x-shopify-shop-domain': 'example.myshopify.com',
    'x-shopify-hmac-sha256': computeShopifyHmac(body, secret),
    'x-shopify-webhook-id': crypto.randomUUID(),
    'x-shopify-event-id': process.env.EVENT_ID || 'evt-sample-1',
    'x-shopify-api-version': '2025-10',
  },
}, (res) => {
  let data = '';
  res.on('data', (c) => { data += c; });
  res.on('end', () => console.log(`${res.statusCode} ${data}`));
});
req.on('error', (err) => { console.error(err.message); process.exit(1); });
req.end(body);
