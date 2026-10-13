// POST /api/chat  { messages: [{role, content}], from, to, geo }
// Env: ANTHROPIC_API_KEY (required), ANTHROPIC_MODEL (optional, default claude-sonnet-4-6)
const { getData } = require('./data.js');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const STORE = `Abed Tahan (abedtahan.com) is a Lebanese electronics and home-appliance retailer founded in 1930 with nine showrooms across Lebanon, running on Shopify Plus.
Payment gateway: Areeba (cards) plus Apple Pay, Whish and cash on delivery. Search: Algolia. Shoppable video: ReelUp (orders tagged REELUP).
Customers can self-cancel through the Yagi Order Cancellable app; those show as "Customer" in canceled_by. Staff orders are created via an internal form (tags created_by:internal_form, agent:<name>).`;

function slim(d) {
  // keep the payload small: top rows only
  return {
    period: { from: d.from, to: d.to, days: d.days, sessions_scope: d.geo === 'lb' ? 'Lebanon sessions only (foreign traffic is mostly bots)' : 'all countries' },
    kpi_sales: d.kpi_sales, kpi_sessions: d.kpi_sessions,
    daily: d.daily, sales_daily: d.sales_daily, by_source: d.by_source, orders_by_source: d.orders_by_source, devices: d.devices, ai_traffic: d.ai_traffic, fulfillment: d.fulfillment,
    top_collections: d.top_collections, top_products_by_units: d.top_products, top_products_by_sales: d.top_products_sales,
    reelup_kpi: d.reelup_kpi, reelup_weekly: d.reelup_weekly,
    canceled_count: d.canceled.length,
    canceled_value: d.canceled.reduce((a, r) => a + r.total, 0),
    canceled_by: count(d.canceled, 'canceled_by'), canceled_reasons: count(d.canceled, 'reason'),
    canceled_sample: d.canceled.slice(0, 40),
  };
}
function count(rows, key) { const m = {}; rows.forEach((r) => { const k = r[key] || 'NONE'; m[k] = (m[k] || 0) + 1; }); return m; }

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const messages = (body.messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-20);
    if (!messages.length) throw new Error('no messages');
    const data = await getData(body.from, body.to, body.geo, false);

    const system = `You are the analytics assistant inside the Abed Tahan store dashboard. Answer questions about the store's Shopify performance and give concrete, prioritized improvement advice (what to change, where in Shopify/theme/marketing, and the expected effect).
${STORE}
Rules: use ONLY the data below for numbers; say when something is not in the data. Be direct and concise, use short bullets for action lists, and quantify when possible. Money is USD. Rates are fractions (0.0045 = 0.45%). The data covers ${data.from} to ${data.to}; "previous period" = the same number of days before it. Session metrics (sessions, conversion rate, bounce rate, sources, AI traffic, collections) are ${data.geo === 'lb' ? 'Lebanon-only: foreign traffic is excluded because it is mostly bots and never converts' : 'for all countries, including bot-heavy foreign traffic'}. Orders and sales always cover all orders.

DASHBOARD DATA (JSON):
${JSON.stringify(slim(data))}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, messages }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    res.status(200).json({ reply: text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
