'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeShopifyHmac, verifyShopifyHmac } = require('../src/verify-hmac');

const SECRET = 'test-secret-not-a-real-credential';
const body = Buffer.from('{"id":1,"total_price":"10.00"}');

test('accepts a valid signature', () => {
  const sig = computeShopifyHmac(body, SECRET);
  assert.equal(verifyShopifyHmac(body, sig, SECRET), true);
});

test('rejects a tampered body', () => {
  const sig = computeShopifyHmac(body, SECRET);
  assert.equal(verifyShopifyHmac(Buffer.from('{"id":1,"total_price":"99.00"}'), sig, SECRET), false);
});

test('rejects a signature made with another secret', () => {
  const sig = computeShopifyHmac(body, 'another-secret');
  assert.equal(verifyShopifyHmac(body, sig, SECRET), false);
});

test('rejects a missing, empty or wrong-length header', () => {
  assert.equal(verifyShopifyHmac(body, undefined, SECRET), false);
  assert.equal(verifyShopifyHmac(body, '', SECRET), false);
  assert.equal(verifyShopifyHmac(body, 'abc', SECRET), false);
});

test('re-serialised JSON does not verify (raw body matters)', () => {
  const sig = computeShopifyHmac(body, SECRET);
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
  assert.equal(verifyShopifyHmac(reserialised, sig, SECRET), false);
});

test('throws without a secret', () => {
  assert.throws(() => verifyShopifyHmac(body, 'x', ''), /secret is required/);
});
