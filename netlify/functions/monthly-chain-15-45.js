// POPPA'S RAW MONTHLY CHAIN EXTRACTOR
// Purpose: return unfiltered CBOE option-chain records for monthly expirations whose DTE falls within 15-45 days.
// This endpoint does NOT filter by ROC, probability, delta band, IV, OI, bid/ask spread, credit, or Iron Condor structure.
// It only filters by: valid OCC option record, third-Friday monthly expiration, and DTE window.

const CBOE = s => `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(s)}.json`;
const MAX_SYMBOLS = 25;

const parseOcc = s => {
  const m = String(s || '').match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  return m ? {
    root: m[1],
    y: 2000 + +m[2],
    mo: +m[3],
    d: +m[4],
    type: m[5],
    strike: +m[6] / 1000
  } : null;
};

const dteOf = (y, mo, d, now) => Math.round((Date.UTC(y, mo - 1, d) - now) / 864e5);
const isThirdFriday = (y, mo, d) => {
  const x = new Date(Date.UTC(y, mo - 1, d));
  return x.getUTCDay() === 5 && d >= 15 && d <= 21;
};
const expiryKey = p => `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
const n = v => Number.isFinite(+v) ? +v : null;
const mid = (bid, ask) => n(bid) != null && n(ask) != null ? +((+bid + +ask) / 2).toFixed(4) : null;
const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

async function fetchSymbol(symbol, now, dteMin, dteMax) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(CBOE(symbol), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
    if (!r.ok) return { symbol, ok: false, status: r.status, records: [], expirations: [] };
    const j = await r.json();
    const ch = j.data || j;
    const spot = n(ch.current_price);
    const records = [];
    for (const o of (Array.isArray(ch.options) ? ch.options : [])) {
      const p = parseOcc(o.option);
      if (!p) continue;
      const dte = dteOf(p.y, p.mo, p.d, now);
      if (dte < dteMin || dte > dteMax) continue;
      if (!isThirdFriday(p.y, p.mo, p.d)) continue;
      records.push({
        symbol,
        spot,
        option: o.option,
        expiration: expiryKey(p),
        dte,
        monthly: true,
        type: p.type === 'C' ? 'call' : 'put',
        strike: p.strike,
        bid: n(o.bid),
        ask: n(o.ask),
        mid: mid(o.bid, o.ask),
        last: n(o.last_trade_price ?? o.last),
        change: n(o.change),
        volume: n(o.volume),
        openInterest: n(o.open_interest),
        iv: n(o.iv),
        delta: n(o.delta),
        gamma: n(o.gamma),
        theta: n(o.theta),
        vega: n(o.vega),
        rho: n(o.rho)
      });
    }
    const expirations = [...new Set(records.map(r => r.expiration))].map(exp => ({
      expiration: exp,
      dte: records.find(r => r.expiration === exp)?.dte,
      calls: records.filter(r => r.expiration === exp && r.type === 'call').length,
      puts: records.filter(r => r.expiration === exp && r.type === 'put').length,
      total: records.filter(r => r.expiration === exp).length
    }));
    return { symbol, ok: true, spot, recordCount: records.length, expirations, records };
  } catch (e) {
    return { symbol, ok: false, error: String(e && e.message ? e.message : e), records: [], expirations: [] };
  } finally {
    clearTimeout(t);
  }
}

export default async (req) => {
  const q = (() => { try { return new URL(req.url).searchParams; } catch { return new URLSearchParams(); } })();
  const dteMin = Number.isFinite(+q.get('dteMin')) ? +q.get('dteMin') : 15;
  const dteMax = Number.isFinite(+q.get('dteMax')) ? +q.get('dteMax') : 45;
  const symbolsRaw = q.get('symbols') || q.get('symbol') || 'TSLA';
  const symbols = [...new Set(symbolsRaw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean))].slice(0, MAX_SYMBOLS);
  const today = new Date();
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const results = [];
  for (const s of symbols) results.push(await fetchSymbol(s, now, dteMin, dteMax));
  return json({
    mode: 'Raw monthly chain extractor',
    filterApplied: 'monthly third-Friday expirations only, DTE window only',
    notFilteredBy: ['ROC', 'probability', 'delta band', 'IV', 'open interest', 'bid/ask spread', 'positive credit', 'Iron Condor structure'],
    dteMin,
    dteMax,
    symbolLimit: MAX_SYMBOLS,
    symbolsRequested: symbols.length,
    recordCount: results.reduce((s, r) => s + (r.recordCount || 0), 0),
    results
  });
};
