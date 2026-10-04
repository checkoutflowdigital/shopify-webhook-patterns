'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PermanentError, backoffDelayMs, retry, InProcessQueue } = require('../src/retry');

const instant = { sleep: async () => {}, random: () => 0.5 };

test('backoff grows exponentially and is capped', () => {
  const opts = { baseMs: 100, maxMs: 1000, random: () => 1 };
  assert.equal(backoffDelayMs(1, opts), 100);
  assert.equal(backoffDelayMs(2, opts), 200);
  assert.equal(backoffDelayMs(3, opts), 400);
  assert.equal(backoffDelayMs(5, opts), 1000);
  assert.equal(backoffDelayMs(9, opts), 1000);
});

test('retries transient errors and succeeds', async () => {
  let calls = 0;
  const result = await retry(async () => {
    calls += 1;
    if (calls < 3) throw new Error('503');
    return 'done';
  }, { maxAttempts: 5, ...instant });
  assert.equal(result, 'done');
  assert.equal(calls, 3);
});

test('stops immediately on a permanent error', async () => {
  let calls = 0;
  await assert.rejects(retry(async () => { calls += 1; throw new PermanentError('400'); }, { maxAttempts: 5, ...instant }),
    PermanentError);
  assert.equal(calls, 1);
});

test('gives up after maxAttempts and keeps the last cause', async () => {
  await assert.rejects(
    retry(async () => { throw new Error('still down'); }, { maxAttempts: 3, ...instant }),
    (err) => err.message.includes('gave up after 3') && err.cause.message === 'still down',
  );
});

test('honours retryAfterMs from the error', async () => {
  const delays = [];
  let calls = 0;
  await retry(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('429'), { retryAfterMs: 1234 });
    return 'ok';
  }, { maxAttempts: 3, sleep: async (ms) => delays.push(ms), random: () => 0 });
  assert.deepEqual(delays, [1234]);
});

test('queue processes jobs in order and reports permanent failures', async () => {
  const order = [];
  const failed = [];
  const queue = new InProcessQueue({ retryOptions: { maxAttempts: 2, ...instant }, onFailed: (f) => failed.push(f.job) });
  queue.enqueue('a', async () => { order.push('a'); });
  queue.enqueue('b', async () => { throw new PermanentError('nope'); });
  queue.enqueue('c', async () => { order.push('c'); });
  await queue.idle;
  assert.deepEqual(order, ['a', 'c']);
  assert.deepEqual(failed, ['b']);
});
