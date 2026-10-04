'use strict';

/**
 * Scheduled reconciliation: the safety net that makes webhooks trustworthy.
 *
 * Webhooks will be missed: your endpoint was down during a deploy, a
 * certificate expired, the sender gave up after its retry window. Shopify
 * documents a retry schedule for failed deliveries, but after it ends the
 * event is gone unless you go and fetch it.
 *
 * So, on a schedule (hourly or daily), ask the API for everything that changed
 * since the last run and feed it through the *same* idempotent processing path
 * as the webhooks. Because the idempotency ledger is shared, resources already
 * handled by a webhook are skipped, and the ones that were missed get processed.
 *
 * This file shows the shape of that job against the Shopify Admin GraphQL API.
 * It needs an Admin API access token with `read_orders`, provided through the
 * environment. Never hard-code it, never ship it in theme or front-end code.
 */

const { idempotencyKey, runOnce } = require('./idempotency');

const ORDERS_UPDATED_SINCE = `
  query OrdersUpdatedSince($query: String!, $after: String) {
    orders(first: 50, query: $query, sortKey: UPDATED_AT, after: $after) {
      edges {
        cursor
        node {
          id
          legacyResourceId
          name
          updatedAt
          displayFinancialStatus
          totalPriceSet { shopMoney { amount currencyCode } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Minimal Admin GraphQL client using the global fetch available in Node 18+.
 * Handles the two things every client needs: pagination and throttling.
 */
async function adminGraphql({ shopDomain, accessToken, apiVersion }, query, variables, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://${shopDomain}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-access-token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (response.status === 429) {
    const err = new Error('throttled by Shopify Admin API');
    const retryAfter = Number(response.headers.get('retry-after') || 2);
    err.retryAfterMs = retryAfter * 1000;
    throw err;
  }
  if (!response.ok) throw new Error(`Admin API HTTP ${response.status}`);

  const body = await response.json();
  if (body.errors && body.errors.length) {
    const throttled = body.errors.some((e) => e.extensions && e.extensions.code === 'THROTTLED');
    const err = new Error(`GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`);
    if (throttled) err.retryAfterMs = 2000;
    throw err;
  }
  return body.data;
}

/**
 * Walk every order updated since `sinceIso` and run `handle` once per order.
 * Returns the number of orders that were actually processed (not duplicates).
 */
async function reconcileOrders({ config, store, sinceIso, handle, client = adminGraphql }) {
  const query = `updated_at:>='${sinceIso}'`;
  let after = null;
  let processed = 0;

  do {
    const data = await client(config, ORDERS_UPDATED_SINCE, { query, after });
    const { edges, pageInfo } = data.orders;

    for (const { node } of edges) {
      const payload = { id: node.legacyResourceId, admin_graphql_api_id: node.id, updated_at: node.updatedAt };
      // No X-Shopify-Event-Id here, so the key falls back to topic + id + updated_at.
      const key = idempotencyKey({}, payload, 'reconcile:orders');
      const outcome = await runOnce(store, key, () => handle(node));
      if (outcome.ran) processed += 1;
    }

    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);

  return processed;
}

/** Entry point for a cron job: `node src/reconcile.js` (every hour, for example). */
if (require.main === module) {
  const { InMemoryIdempotencyStore } = require('./idempotency');
  const config = {
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
    accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    apiVersion: process.env.SHOPIFY_API_VERSION || '2025-10',
  };
  if (!config.shopDomain || !config.accessToken) {
    console.error('Set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN in the environment.');
    process.exit(1);
  }
  const sinceIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // overlap the last run
  reconcileOrders({
    config,
    store: new InMemoryIdempotencyStore(), // use your shared store in production
    sinceIso,
    handle: (order) => console.log(`reconciled order ${order.name} (${order.displayFinancialStatus})`),
  })
    .then((n) => console.log(`reconciliation done: ${n} orders processed`))
    .catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { adminGraphql, reconcileOrders, ORDERS_UPDATED_SINCE };
