'use strict';

/**
 * Retry with exponential backoff and jitter, plus a tiny in-process job queue.
 *
 * Why this exists: a webhook handler must answer 2xx within seconds, but the
 * work it triggers (call an accounting API, update an ERP, send an email) can
 * be slow or temporarily failing. So the handler only *records* the event and
 * returns; the actual work runs afterwards, with retries.
 *
 * Two kinds of failure need different handling:
 *   - Transient (network error, 429, 5xx from the other API): retry with
 *     backoff. Respect `Retry-After` when the API sends one.
 *   - Permanent (400 validation error, 404 resource gone, business rule):
 *     stop retrying, record the failure and alert someone.
 *
 * The in-process queue below loses its jobs if the process dies. It is enough
 * to understand the pattern and to run the tests. In production, use a durable
 * queue (a database table polled by a worker, BullMQ, SQS, Cloud Tasks…) so
 * that an event accepted with 2xx is never silently dropped.
 */

class PermanentError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PermanentError';
    this.cause = cause;
  }
}

/**
 * Compute the delay before attempt number `attempt` (1-based).
 * Full jitter: random between 0 and the exponential cap, which spreads retries
 * from many clients and avoids thundering-herd retries after an outage.
 */
function backoffDelayMs(attempt, { baseMs = 500, maxMs = 60_000, random = Math.random } = {}) {
  const cap = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * cap);
}

/**
 * Call `fn` until it succeeds, a PermanentError is thrown, or `maxAttempts`
 * is reached. `sleep` and `random` are injectable so tests run instantly.
 */
async function retry(fn, {
  maxAttempts = 5,
  baseMs = 500,
  maxMs = 60_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  onRetry = () => {},
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (err instanceof PermanentError) throw err;
      if (attempt === maxAttempts) break;
      const retryAfterMs = err && typeof err.retryAfterMs === 'number' ? err.retryAfterMs : null;
      const delay = retryAfterMs ?? backoffDelayMs(attempt, { baseMs, maxMs, random });
      onRetry({ attempt, delay, error: err });
      await sleep(delay);
    }
  }
  const error = new Error(`retry: gave up after ${maxAttempts} attempts`);
  error.cause = lastError;
  throw error;
}

/**
 * Minimal in-process queue: jobs run one at a time, each with `retry`.
 * `onFailed` receives jobs that exhausted their retries or hit a permanent
 * error, so you can log them and alert.
 */
class InProcessQueue {
  constructor({ retryOptions = {}, onFailed = () => {} } = {}) {
    this.retryOptions = retryOptions;
    this.onFailed = onFailed;
    this.jobs = [];
    this.running = false;
    this.idle = Promise.resolve();
  }

  enqueue(name, handler) {
    this.jobs.push({ name, handler });
    if (!this.running) this.idle = this._drain();
  }

  async _drain() {
    this.running = true;
    while (this.jobs.length > 0) {
      const job = this.jobs.shift();
      try {
        await retry(job.handler, this.retryOptions);
      } catch (err) {
        this.onFailed({ job: job.name, error: err });
      }
    }
    this.running = false;
  }
}

module.exports = { PermanentError, backoffDelayMs, retry, InProcessQueue };
