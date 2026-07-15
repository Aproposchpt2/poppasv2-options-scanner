// POPPA'S Option Scanner v3 — preview-safe live results endpoint.
// Band-aware contract: filter by Band Intake values first, then slice, then normalize.

import { getStore } from "@netlify/blobs";

const STORE = "poppas-scan";
const LATEST_KEY = "latest";

const num = (v, d) => {
  if (v === null || v === undefined || v === "") return d;
  const n = +v;
  return Number.isFinite(n) ? n : d;
};

const hasValue = v => v !== null && v !== undefined && Number.isFinite(+v);
const rocOf = r => (r.roc != null ? +r.roc : (r.credit && r.width && r.width - r.credit > 0 ? +r.credit / (+r.width - +r.credit) * 100 : 0));
const probOf = r => (r.prob != null ? +r.prob : Math.round((r.probOtm || 0) * 100));
const chainIVOf = r => num(r.monthlyChainIV ?? r.chainIV ?? r.iv, 0);
const spreadOf = r => hasValue(r.spreadMax) ? +r.spreadMax : (hasValue(r.spread) ? +r.spread : null);
const shortPutOIOf = r => num(r.shortPutOI ?? r.putShortOI ?? r.oiMin, 0);
const shortCallOIOf = r => num(r.shortCallOI ?? r.callShortOI ?? r.oiMin, 0);
const shortOIMinOf = r => Math.min(shortPutOIOf(r), shortCallOIOf(r));
const monthlyOIOf = r => num(r.openInterest ?? r.oi ?? r.monthlyOI, 0);
const widthOf = r => num(r.width, null);

function json(body, maxAge = 60) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=" + maxAge
    }
  });
}

function getFilters(q) {
  return {
    rocMin: num(q.get("rocMin"), 5),
    rocMax: num(q.get("rocMax"), 10),
    minProb: num(q.get("minProb"), 90),
    ivMin: num(q.get("ivMin"), 40),
    minOI: num(q.get("minOI"), 10000),
    minShortOI: num(q.get("minShortOI"), 500),
    maxSpread: num(q.get("maxSpread"), 0.05),
    dteMin: num(q.get("dteMin"), 15),
    dteMax: num(q.get("dteMax"), 45),
    excludeEarnings: (q.get("excludeEarnings") || "yes") !== "no",
    idx: q.get("idx") || "both",
    width: num(q.get("width"), 0),
    rankBy: q.get("rankBy") || "edge",
    passersTop: q.get("passersTop") === "yes" || q.get("passersTop") === "true"
  };
}

function passesBand(r, f) {
  const roc = rocOf(r);
  const prob = probOf(r);
  const iv = chainIVOf(r);
  const oi = monthlyOIOf(r);
  const shortOI = shortOIMinOf(r);
  const dte = num(r.dte, -999);
  const spread = spreadOf(r);
  const width = widthOf(r);
  const market = r.market || "both";

  if (roc < f.rocMin || roc > f.rocMax) return false;
  if (prob < f.minProb) return false;
  if (iv < f.ivMin) return false;
  if (oi < f.minOI) return false;
  if (shortOI < f.minShortOI) return false;
  if (dte < f.dteMin || dte > f.dteMax) return false;
  if (f.excludeEarnings && !!r.earnings) return false;
  if (spread !== null && spread > f.maxSpread) return false;
  if (f.idx !== "both" && market !== "both" && market !== f.idx) return false;
  if (f.width && width !== null && Math.abs(width - f.width) > 0.01) return false;
  return true;
}

function expectedMoveFor(r) {
  const spot = num(r.spot, null), iv = chainIVOf(r), dte = num(r.dte, null);
  if (!hasValue(spot) || !hasValue(iv) || !hasValue(dte) || spot <= 0 || iv <= 0 || dte <= 0) {
    return {
      expectedMove: r.expectedMove ?? null,
      expectedLow: r.expectedLow ?? null,
      expectedHigh: r.expectedHigh ?? null,
      expectedMoveStatus: r.expectedMoveStatus || "Verify"
    };
  }
  const move = hasValue(r.expectedMove) ? +r.expectedMove : +(spot * (iv / 100) * Math.sqrt(dte / 365)).toFixed(2);
  const low = hasValue(r.expectedLow) ? +r.expectedLow : +(spot - move).toFixed(2);
  const high = hasValue(r.expectedHigh) ? +r.expectedHigh : +(spot + move).toFixed(2);
  let status = r.expectedMoveStatus || "Review";
  const put = num(r.shortPut ?? r.putSell, null), call = num(r.shortCall ?? r.callSell, null);
  if (hasValue(put) && hasValue(call)) {
    const buffer = Math.max(move * 0.10, spot * 0.005);
    if (put < low && call > high) status = "Outside EM";
    else if (put >= low + buffer || call <= high - buffer) status = "Inside EM";
    else status = "Near EM";
  }
  return { expectedMove: move, expectedLow: low, expectedHigh: high, expectedMoveStatus: status };
}

function normalizedRow(r) {
  const monthlyChainIV = chainIVOf(r);
  const em = expectedMoveFor(r);
  return {
    ...r,
    iv: Number.isFinite(monthlyChainIV) ? +monthlyChainIV.toFixed(1) : 0,
    monthlyChainIV: Number.isFinite(monthlyChainIV) ? +monthlyChainIV.toFixed(1) : 0,
    roc: +rocOf(r).toFixed(2),
    prob: probOf(r),
    shortPutOI: shortPutOIOf(r),
    shortCallOI: shortCallOIOf(r),
    longPutOI: num(r.longPutOI, null),
    longCallOI: num(r.longCallOI, null),
    spreadMax: spreadOf(r),
    expectedMove: em.expectedMove,
    expectedLow: em.expectedLow,
    expectedHigh: em.expectedHigh,
    expectedMoveStatus: em.expectedMoveStatus,
    reviewStatus: r.passed ? "Matches primary filters ✓" : (r.note || "Candidate for manual review")
  };
}

function sortRows(rows, f) {
  return rows.sort((a, b) => {
    if (f.passersTop && (b.passed ? 1 : 0) - (a.passed ? 1 : 0)) return (b.passed ? 1 : 0) - (a.passed ? 1 : 0);
    if (f.rankBy === "roc") return rocOf(b) - rocOf(a);
    if (f.rankBy === "prob") return probOf(b) - probOf(a);
    if (f.rankBy === "iv") return chainIVOf(b) - chainIVOf(a);
    return (b.edge || b.score || 0) - (a.edge || a.score || 0) || rocOf(b) - rocOf(a);
  });
}

export default async (req) => {
  const q = (() => { try { return new URL(req.url).searchParams; } catch (_) { return new URLSearchParams(); } })();
  const limit = Math.min(Math.max(parseInt(q.get("limit") || "25", 10) || 25, 1), 1000);
  const offset = Math.max(parseInt(q.get("offset") || "0", 10) || 0, 0);
  const filters = getFilters(q);

  const store = getStore(STORE);
  const board = await store.get(LATEST_KEY, { type: "json" }).catch(() => null);

  if (!board || !Array.isArray(board.results)) {
    try {
      const base = process.env.URL || process.env.DEPLOY_URL;
      if (base) fetch(`${base}/.netlify/functions/scan-build-background`, { method: "POST" });
    } catch (_) {}
    return json({
      ok: true,
      building: true,
      hasRows: false,
      total: 0,
      matched: 0,
      returned: 0,
      offset,
      limit,
      hasMore: false,
      nextOffset: null,
      filters,
      processingMode: "filter-first-slice-second",
      filterMode: "band-aware-preview-slice",
      serverFiltersApplied: true,
      userMessage: "Scanner board is not available yet. A build was requested.",
      results: []
    }, 30);
  }

  const totalRows = board.results.length;
  const matchedRaw = [];
  for (const r of board.results) {
    if (passesBand(r, filters)) matchedRaw.push(r);
  }
  const matchedRows = sortRows(matchedRaw, filters);
  const pageRows = matchedRows.slice(offset, offset + limit).map(normalizedRow);
  const hasMore = offset + limit < matchedRows.length;

  return json({
    ok: true,
    strategy: board.strategy || "SP500_Tight_Condor_Scan",
    scanMode: board.scanMode || "Cached delayed/EOD scan",
    dataSource: board.dataSource || "Stored scan board",
    generatedAt: board.generatedAt,
    universeCount: board.universeCount,
    scanned: board.scanned,
    withCondor: board.withCondor ?? totalRows,
    passCount: board.passCount,
    building: !!board.building,
    progress: board.progress || null,
    total: totalRows,
    matched: matchedRows.length,
    returned: pageRows.length,
    offset,
    limit,
    hasRows: pageRows.length > 0,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
    filters,
    previewSlice: true,
    processingMode: "filter-first-slice-second",
    filterMode: "band-aware-preview-slice",
    serverFiltersApplied: true,
    serverFiltersRemoved: false,
    userMessage: board.building
      ? "Live board rows are available while the scan is still finalizing. Displaying band-filtered preview rows."
      : "Live board is ready. Displaying band-filtered preview rows.",
    results: pageRows
  }, board.building ? 30 : 300);
};
