'use strict';

/**
 * Verify a Shopify webhook signature.
 *
 * Shopify signs each webhook delivery with HMAC-SHA256 over the *raw* request
 * body, using your app's webhook signing secret, and sends the result
 * base64-encoded in the `X-Shopify-Hmac-Sha256` header.
 *
 * Two rules that are easy to get wrong:
 *   1. Hash the raw bytes exactly as received. Parsing the JSON and
 *      re-serialising it changes whitespace and key order, and the signature
 *      will never match.
 *   2. Compare with a constant-time function. A plain `===` leaks timing
 *      information that lets an attacker forge signatures byte by byte.
 *
 * The same approach (HMAC over the raw body, constant-time comparison) applies
 * to most payment providers; only the header name and encoding differ.
 *
 * @param {Buffer|string} rawBody   The request body exactly as received.
 * @param {string|undefined} headerValue  Value of `X-Shopify-Hmac-Sha256`.
 * @param {string} secret           Webhook signing secret (from the environment).
 * @returns {boolean} true when the signature is valid.
 */
const crypto = require('node:crypto');

function computeShopifyHmac(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
}

function verifyShopifyHmac(rawBody, headerValue, secret) {
  if (!secret) throw new Error('verifyShopifyHmac: secret is required');
  if (typeof headerValue !== 'string' || headerValue.length === 0) return false;

  const expected = Buffer.from(computeShopifyHmac(rawBody, secret), 'utf8');
  const received = Buffer.from(headerValue, 'utf8');

  // timingSafeEqual throws when lengths differ; a length mismatch is simply
  // an invalid signature, so handle it before the comparison.
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

module.exports = { computeShopifyHmac, verifyShopifyHmac };
