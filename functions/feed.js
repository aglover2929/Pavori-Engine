// Read-only data feed for the Payvori Sales Portal (server to server).
// Only answers requests carrying the secret in the "x-engine-key" header, which must match the ENGINE_FEED_KEY
// environment variable set on BOTH Netlify sites. Never called from a browser.
// Sends: organizations, processors, agent Schedule A's (never Payvori's cost schedules), customers, deals,
// and finalized residual runs with their merchant lines. The Portal filters everything down to each person.
const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');

const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

function keyOk(given) {
  const want = process.env.ENGINE_FEED_KEY || '';
  if (want.length < 24 || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

async function listCol(store, col) {
  const depth = col.split('/').length + 1;
  const { blobs } = await store.list({ prefix: col + '/' });
  const keys = blobs.map(b => b.key).filter(k => k.split('/').length === depth);
  const docs = await Promise.all(keys.map(async k => ({ id: k.slice(col.length + 1), ...(await store.get(k, { type: 'json' }) || {}) })));
  return docs;
}
const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  if (!process.env.ENGINE_FEED_KEY) return json(503, { error: 'ENGINE_FEED_KEY is not set on the Engine site' });
  if (!keyOk((event.headers || {})['x-engine-key'])) return json(401, { error: 'Wrong or missing feed key' });

  connectLambda(event);
  const store = getStore('payvori-engine');
  const months = Math.max(1, Math.min(36, parseInt((event.queryStringParameters || {}).months, 10) || 13));

  const [payees, processors, schedules, customers, deals, runs] = await Promise.all(
    ['payees', 'processors', 'schedules', 'customers', 'deals', 'runs'].map(c => listCol(store, c)));

  const finalRuns = runs.filter(r => r.status === 'approved' || r.status === 'paid')
    .sort((a, b) => String(b.month).localeCompare(String(a.month))).slice(0, months);
  const runOut = [];
  for (const r of finalRuns) {
    const lines = [];
    for (let i = 0; i < (r.lineChunks || 0); i++) {
      const c = await store.get(`runs/${r.id}/lines/c${i}`, { type: 'json' });
      for (const l of (c && c.items) || []) lines.push({ dealId: l.dealId, merchant: l.merchant, mid: l.mid, net: l.net, splits: (l.splits || []).map(s => ({ payeeId: s.payeeId, pct: s.pct, amount: s.amount })) });
    }
    const paid = {};
    for (const [id, p] of Object.entries(r.paid || {})) paid[id] = { date: p.date || '', amount: p.amount };
    const totals = {};
    for (const [id, t] of Object.entries(r.payeeTotals || {})) totals[id] = pick(t, ['earned', 'deals', 'carryIn', 'priorPaid', 'amount']);
    runOut.push({ month: r.month || r.id, status: r.status, approvedAt: r.approvedAt || '', payeeTotals: totals, paid, lines });
  }

  return json(200, {
    generatedAt: new Date().toISOString(),
    orgs: payees.map(p => pick(p, ['id', 'name', 'role', 'status', 'parentId', 'agentNo', 'email', 'payvoriEmail', 'prShare', 'contactName', 'phone', 'city', 'state'])),
    processors: processors.map(p => ({ id: p.id, name: p.name, platforms: (p.platforms || []).map(x => ({ id: x.id, name: x.name })) })),
    schedules: schedules.filter(s => s.kind === 'agent').map(s => pick(s, ['id', 'code', 'title', 'payeeId', 'processorId', 'platformIds', 'effectiveFrom', 'notes', 'sections', 'updatedAt'])),
    customers: customers.map(c => pick(c, ['id', 'cidNumber', 'dba', 'legalName', 'status', 'openedDate', 'closedDate', 'orgId', 'contactName', 'phone', 'email', 'city', 'state', 'platform', 'mids'])),
    deals: deals.map(d => pick(d, ['id', 'merchant', 'mid', 'processor', 'platform', 'versions', 'splits'])),
    runs: runOut
  });
};
