// Vercel serverless function: GET /api/data?from=YYYY-MM-DD&to=YYYY-MM-DD  (&refresh=1 bypasses the 10-minute cache)
// Env vars (Vercel → Settings → Environment Variables):
//   SHOPIFY_STORE          = jad-b-2.myshopify.com
//   SHOPIFY_CLIENT_ID      = Dev Dashboard app → Credentials → Client ID
//   SHOPIFY_CLIENT_SECRET  = Dev Dashboard app → Credentials → Client secret
//   (or SHOPIFY_TOKEN = a permanent shpat_ token, if you have one instead)
// App scopes needed: read_orders, read_products, read_reports

const API_VERSION = '2026-01';
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // key = from|to

const AI_REFERRERS = ['chatgpt', 'openai', 'perplexity', 'gemini', 'claude', 'copilot', 'grok', 'mistral', 'deepseek'];

let tokenCache = { token: null, exp: 0 };
async function accessToken() {
  if (process.env.SHOPIFY_TOKEN) return process.env.SHOPIFY_TOKEN;
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const r = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.SHOPIFY_CLIENT_ID, client_secret: process.env.SHOPIFY_CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Shopify token error: ' + JSON.stringify(j));
  tokenCache = { token: j.access_token, exp: Date.now() + ((j.expires_in || 86400) - 300) * 1000 };
  return j.access_token;
}

async function gql(query, variables) {
  const r = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await accessToken() },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map((e) => e.message).join('; '));
  return j.data;
}

async function ql(q) {
  const d = await gql(`query($q: String!) { shopifyqlQuery(query: $q) { parseErrors tableData { columns { name dataType } rows } } }`, { q });
  const res = d.shopifyqlQuery;
  if (res.parseErrors && res.parseErrors.length) throw new Error(res.parseErrors.join('; '));
  const num = new Set(res.tableData.columns.filter((c) => /INTEGER|MONEY|PERCENT|DECIMAL|FLOAT/.test(c.dataType)).map((c) => c.name));
  return res.tableData.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num.has(k) ? Number(v) : v])));
}

async function canceledOrders(from, to) {
  const q = `query($q: String, $after: String) { orders(first: 50, after: $after, query: $q, sortKey: UPDATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes { name createdAt cancelledAt cancelReason cancellation { staffNote } totalPriceSet { shopMoney { amount } }
      lineItems(first: 3) { nodes { title quantity } }
      events(first: 5, query: "action:cancelled", sortKey: CREATED_AT, reverse: true) { nodes { message attributeToUser appTitle } } } } }`;
  const rows = [];
  let after = null, pages = 0;
  do {
    const d = await gql(q, { q: `status:cancelled created_at:>='${from}' created_at:<='${to}T23:59:59Z'`, after });
    d.orders.nodes.forEach((n) => {
      const ev = (n.events && n.events.nodes[0]) || {};
      rows.push({
        name: n.name, created_at: n.createdAt, cancelled_at: n.cancelledAt, reason: n.cancelReason || '',
        staff_note: (n.cancellation && n.cancellation.staffNote) || '', total: Number(n.totalPriceSet.shopMoney.amount),
        items: n.lineItems.nodes.map((l) => (l.quantity > 1 ? l.quantity + '× ' : '') + l.title).join('; '),
        canceled_by: ev.appTitle === 'Yagi Order Cancellable' ? 'Customer' : ev.attributeToUser ? (ev.message || '').replace(/ canceled this order\.?$/i, '') : (ev.appTitle || 'Unknown'),
      });
    });
    after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
    pages++;
  } while (after && pages < 4);
  return rows;
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const iso = (d) => d.toISOString().slice(0, 10);

async function build(from, to) {
  const range = `SINCE ${from} UNTIL ${to}`;
  const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  const aiList = AI_REFERRERS.map((s) => `'${s}'`).join(', ');
  const [kpi_sessions, kpi_sales, daily, by_source, ai_traffic, top_collections, top_products, reelup_kpi, reelup_weekly, canceled] = await Promise.all([
    ql(`FROM sessions SHOW sessions, bounce_rate, conversion_rate, sessions_that_completed_checkout ${range} COMPARE TO previous_period`),
    ql(`FROM sales SHOW orders, net_sales, average_order_value ${range} COMPARE TO previous_period`),
    ql(`FROM sessions SHOW sessions, bounce_rate, conversion_rate, sessions_that_completed_checkout TIMESERIES ${days > 120 ? 'week' : 'day'} ${range}`),
    ql(`FROM sessions SHOW sessions, sessions_that_completed_checkout, conversion_rate GROUP BY referrer_source ${range} ORDER BY sessions DESC`),
    ql(`FROM sessions SHOW sessions, sessions_that_completed_checkout, conversion_rate WHERE referrer_name IN (${aiList}) GROUP BY referrer_name ${range} ORDER BY sessions DESC`),
    ql(`FROM sessions SHOW sessions, conversion_rate WHERE landing_page_type = 'collection' GROUP BY landing_page_path ${range} ORDER BY sessions DESC LIMIT 5`),
    ql(`FROM sales SHOW net_items_sold, orders, net_sales GROUP BY product_title ${range} ORDER BY net_items_sold DESC LIMIT 11`),
    ql(`FROM sales SHOW orders, net_sales WHERE order_tags CONTAINS 'REELUP' ${range} COMPARE TO previous_period`),
    ql(`FROM sales SHOW orders, net_sales WHERE order_tags CONTAINS 'REELUP' TIMESERIES ${days > 60 ? 'week' : 'day'} ${range}`),
    canceledOrders(from, to),
  ]);
  return {
    generated_at: new Date().toISOString(), from, to, days,
    kpi_sessions: kpi_sessions[0], kpi_sales: kpi_sales[0], daily, by_source, ai_traffic, top_collections,
    top_products: top_products.filter((r) => r.product_title).slice(0, 10),
    reelup_kpi: reelup_kpi[0], reelup_weekly, canceled,
  };
}

async function getData(from, to, force) {
  const today = iso(new Date());
  if (!isDate(to) || to > today) to = today;
  if (!isDate(from) || from > to) from = iso(new Date(new Date(to) - 29 * 86400000));
  const key = from + '|' + to;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await build(from, to);
  cache.set(key, { at: Date.now(), data });
  return data;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.query || {};
    res.status(200).json(await getData(q.from, q.to, !!q.refresh));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
module.exports.getData = getData;
