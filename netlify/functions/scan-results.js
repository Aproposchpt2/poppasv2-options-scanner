// POPPAS PRO — fast server-side filter over the cached full-board scan.
// Revised version: supports leg-level liquidity, max all-leg bid/ask spread, selected width,
// safer review-status wording, and explicit earnings/data-source metadata.
import { getStore } from "@netlify/blobs";

const num = (v, d) => {
  if (v === null || v === undefined || v === "") return d;
  const n = +v;
  return Number.isFinite(n) ? n : d;
};
const json = (o, maxAge) => new Response(JSON.stringify(o), {
  status: 200,
  headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=" + (maxAge || 600) }
});
const rocOf = r => (r.roc != null ? r.roc : (r.credit && r.width && r.width - r.credit > 0 ? r.credit / (r.width - r.credit) * 100 : 0));
const probOf = r => (r.prob != null ? r.prob : Math.round((r.probOtm || 0) * 100));
const shortPutOI = r => num(r.shortPutOI ?? r.putShortOI ?? r.oiMin, null);
const shortCallOI = r => num(r.shortCallOI ?? r.callShortOI ?? r.oiMin, null);
const longPutOI = r => num(r.longPutOI, null);
const longCallOI = r => num(r.longCallOI, null);
const hasValue = v => v !== null && v !== undefined && Number.isFinite(+v);
const minKnownShortOI = r => {
  const vals = [shortPutOI(r), shortCallOI(r)].filter(hasValue);
  if (vals.length) return Math.min(...vals);
  return num(r.openInterest ?? r.oi, 0); // backwards-compatible fallback for old stored boards
};
const minKnownLongOI = r => {
  const vals = [longPutOI(r), longCallOI(r)].filter(hasValue);
  return vals.length ? Math.min(...vals) : null;
};
const spreadOf = r => hasValue(r.spreadMax) ? +r.spreadMax : (hasValue(r.spread) ? +r.spread : null);

export default async (req) => {
  const store = getStore("poppas-scan");
  let board = null;
  try { board = await store.get("latest", { type: "json" }); } catch (_) {}

  if (!board || !Array.isArray(board.results)) {
    try {
      const base = process.env.URL || process.env.DEPLOY_URL;
      if (base) fetch(`${base}/.netlify/functions/scan-build-background`, { method: "POST" });
    } catch (_) {}
    return json({
      building: true,
      scanMode: "Building full scan…",
      earningsShield: "verify before trade",
      probabilityDisclosure: "Anchor-leg probability only; not guaranteed whole-condor probability.",
      results: []
    }, 30);
  }

  if (board.building) {
    const stale = Date.now() - new Date(board.generatedAt || 0).getTime() > 3 * 60 * 1000;
    if (stale) {
      try {
        const base = process.env.URL || process.env.DEPLOY_URL;
        if (base) fetch(`${base}/.netlify/functions/scan-build-background?continue=1`, { method: "POST" });
      } catch (_) {}
    }
  }

  const q = (() => { try { return new URL(req.url).searchParams; } catch (_) { return new URLSearchParams(); } })();
  const hasFilters = [...q.keys()].length > 0;
  const selectedWidth = q.get("width") === "auto" ? 0 : num(q.get("width"), 0);

  let baseRows = board.results.filter(r => {
    if (!(r.width === 5 || r.width === 10)) return false;
    if (selectedWidth && Math.abs((r.width || 0) - selectedWidth) > 0.01) return false;
    return true;
  });

  const meta = {
    strategy: board.strategy || "SP500_Tight_Condor_Scan",
    scanMode: board.scanMode || "Cached delayed/EOD scan",
    dataSource: board.dataSource || "Stored scan board",
    generatedAt: board.generatedAt,
    universeCount: board.universeCount,
    scanned: board.scanned,
    withCondor: board.withCondor,
    passCount: board.passCount,
    earningsShield: board.earningsShield || "verify before trade",
    earningsFlagged: board.earningsFlagged,
    probabilityDisclosure: "Anchor-leg probability only; not guaranteed whole-condor probability.",
    building: !!board.building,
    progress: board.progress || null,
    total: board.withCondor
  };

  if (!hasFilters) return json({ ...meta, matched: baseRows.length, results: baseRows }, board.building ? 60 : 600);

  const rocMin = num(q.get("rocMin"), 0), rocMax = num(q.get("rocMax"), 1e9);
  const minProb = num(q.get("minProb"), 0), minIV = num(q.get("ivMin"), 0), minMonthlyOI = num(q.get("minOI"), 0);
  const minShortOI = num(q.get("minShortOI"), 0), minLongOI = num(q.get("minLongOI"), 0);
  const maxSpread = num(q.get("maxSpread"), 1e9);
  const dmin = num(q.get("dteMin"), 0), dmax = num(q.get("dteMax"), 1e9);
  const exEarn = q.get("excludeEarnings") === "yes";
  const idx = q.get("idx") || "both";
  const rankBy = q.get("rankBy") || "roc";
  const passersTop = q.get("passersTop") === "yes";
  const max = num(q.get("max"), 12);

  let rows = baseRows.filter(r => {
    const roc = rocOf(r), prob = probOf(r), iv = r.iv || 0, monthlyOI = r.openInterest || r.oi || 0, dte = r.dte || 0;
    if (roc < rocMin || roc > rocMax) return false;
    if (prob < minProb) return false;
    if (iv < minIV) return false;
    if (monthlyOI < minMonthlyOI) return false;
    if (minKnownShortOI(r) < minShortOI) return false;
    const minLong = minKnownLongOI(r);
    if (minLong !== null && minLong < minLongOI) return false;
    const spr = spreadOf(r);
    if (spr !== null && spr > maxSpread) return false;
    if (dte < dmin || dte > dmax) return false;
    if (exEarn && r.earnings) return false;
    if (!(idx === "both" || r.market === "both" || r.market === idx)) return false;
    return true;
  }).map(r => ({
    ...r,
    roc: +rocOf(r).toFixed(2),
    prob: probOf(r),
    shortPutOI: shortPutOI(r),
    shortCallOI: shortCallOI(r),
    longPutOI: longPutOI(r),
    longCallOI: longCallOI(r),
    spreadMax: spreadOf(r),
    reviewStatus: r.passed ? "Matches primary filters ✓" : (r.note || "Candidate for manual review")
  }));

  rows.sort((a, b) => {
    if (passersTop && (b.passed ? 1 : 0) - (a.passed ? 1 : 0)) return (b.passed ? 1 : 0) - (a.passed ? 1 : 0);
    if (rankBy === "edge") return (b.edge || b.score || 0) - (a.edge || a.score || 0) || rocOf(b) - rocOf(a);
    return rocOf(b) - rocOf(a);
  });

  const matched = rows.length;
  rows = rows.slice(0, max);
  return json({ ...meta, matched, returned: rows.length, results: rows }, board.building ? 60 : 600);
};
