// POPPA'S Option Scanner v3 — Supabase REST results endpoint.
// Applies user Band Intake values server-side, then returns one page of rows.
// Page size UX standard: 50 records at a time. CTA: Scan Next 50.

const DEFAULT_STRATEGY = "SP500_Tight_Condor_Scan_v3_RawMonthlyFirst";
const DEFAULT_SCAN_MODE = "CBOE EOD · Monthly option chain only · 15-45 DTE · Supabase persistence";
const DEFAULT_DATA_SOURCE = "CBOE EOD/delayed quotes; Band Intake values are applied in the Supabase REST read endpoint";

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function sbConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return { url: url.replace(/\/$/, ""), key };
}

async function sbFetch(path, opts = {}) {
  const { url, key } = sbConfig();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(opts.headers || {})
    }
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} failed ${res.status}: ${text}`);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json") && text) return { data: JSON.parse(text), headers: res.headers };
  return { data: text, headers: res.headers };
}

function n(v, fallback) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function pct(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return null;
  return x > 1 ? x / 100 : x;
}

function enc(v) { return encodeURIComponent(String(v)); }

async function latestRun() {
  const { data } = await sbFetch("scan_runs?select=*&order=started_at.desc&limit=1");
  return Array.isArray(data) ? data[0] : null;
}

function readFilters(url) {
  const q = url.searchParams;
  const rawLimit = n(q.get("limit"), 50);
  const limit = Math.max(1, Math.min(50, Math.floor(rawLimit || 50)));
  return {
    limit,
    offset: Math.max(0, Math.floor(n(q.get("offset"), 0))),
    rocMin: n(q.get("rocMin"), 5),
    rocMax: n(q.get("rocMax"), 10),
    minProb: pct(q.get("minProb") ?? 90) ?? 0.90,
    ivMin: n(q.get("ivMin"), 30),
    minOI: n(q.get("minOI"), 10000),
    minShortOI: n(q.get("minShortOI"), 1),
    maxSpread: n(q.get("maxSpread"), 0.25),
    dteMin: n(q.get("dteMin"), 15),
    dteMax: n(q.get("dteMax"), 45),
    excludeEarnings: String(q.get("excludeEarnings") || "yes").toLowerCase(),
    idx: String(q.get("idx") || "both").toLowerCase(),
    width: n(q.get("width"), 5),
    emStatus: String(q.get("emStatus") || "Outside Expected Move"),
    ivStatus: String(q.get("ivStatus") || "All"),
    rankBy: String(q.get("rankBy") || "edge").toLowerCase()
  };
}

function orderFor(rankBy) {
  if (rankBy === "roc") return "roc.desc";
  if (rankBy === "prob") return "prob_otm.desc";
  if (rankBy === "iv") return "iv.desc";
  if (rankBy === "credit") return "credit.desc";
  return "score.desc,roc.desc,prob_otm.desc";
}

function addBandFilters(params, f) {
  params.push(`roc=gte.${enc(f.rocMin)}`);
  params.push(`roc=lte.${enc(f.rocMax)}`);
  params.push(`prob_otm=gte.${enc(f.minProb)}`);
  params.push(`iv=gte.${enc(f.ivMin)}`);
  params.push(`open_interest=gte.${enc(f.minOI)}`);
  params.push(`short_put_oi=gte.${enc(f.minShortOI)}`);
  params.push(`short_call_oi=gte.${enc(f.minShortOI)}`);
  params.push(`spread_max=lte.${enc(f.maxSpread)}`);
  params.push(`dte=gte.${enc(f.dteMin)}`);
  params.push(`dte=lte.${enc(f.dteMax)}`);

  if (f.excludeEarnings === "yes" || f.excludeEarnings === "true") params.push("earnings=eq.false");
  if (f.idx && f.idx !== "both" && f.idx !== "all") params.push(`market=in.(${enc(f.idx)},both)`);
  if (Number.isFinite(f.width) && f.width > 0) {
    params.push(`width=gte.${enc((f.width - 0.01).toFixed(2))}`);
    params.push(`width=lte.${enc((f.width + 0.01).toFixed(2))}`);
  }

  const ivs = f.ivStatus.toLowerCase();
  if (ivs === "inflated") params.push("iv=gte.40");
  else if (ivs === "deflated") params.push("iv=lt.30");
  else if (ivs === "fair") {
    params.push("iv=gte.30");
    params.push("iv=lt.40");
  }

  const em = f.emStatus.toLowerCase();
  if (em && em !== "all") {
    if (em.includes("outside")) params.push("or=(expected_move_status.eq.Outside%20EM,expected_move_status.eq.Outside%20Expected%20Move)");
    else if (em.includes("inside")) params.push("expected_move_status=eq.Inside%20EM");
    else if (em.includes("near")) params.push("expected_move_status=eq.Near%20EM");
  }
}

function contentRangeCount(headers, fallback = 0) {
  const cr = headers.get("content-range") || "";
  const m = cr.match(/\/(\d+)$/);
  return m ? Number(m[1]) : fallback;
}

function mapRow(r) {
  return {
    id: r.id,
    scanRunId: r.scan_run_id,
    symbol: r.symbol,
    name: r.name,
    sector: r.sector,
    market: r.market,
    spot: r.spot,
    iv: r.iv,
    hv: r.hv,
    dte: r.dte,
    expiry: r.expiry,
    earnings: r.earnings,
    earningsDate: r.earnings_date,
    nextEarnings: r.next_earnings,
    shortPut: r.short_put,
    longPut: r.long_put,
    shortCall: r.short_call,
    longCall: r.long_call,
    credit: r.credit,
    midCredit: r.mid_credit,
    width: r.width,
    maxRisk: r.max_risk,
    roc: r.roc,
    prob: Number.isFinite(Number(r.prob_otm)) ? Math.round(Number(r.prob_otm) * 100) : null,
    probOtm: r.prob_otm,
    putProbOtm: r.put_prob_otm,
    callProbOtm: r.call_prob_otm,
    shortDelta: r.short_delta,
    openInterest: r.open_interest,
    monthlyOI: r.open_interest,
    shortPutOI: r.short_put_oi,
    shortCallOI: r.short_call_oi,
    longPutOI: r.long_put_oi,
    longCallOI: r.long_call_oi,
    spreadMax: r.spread_max,
    expectedMove: r.expected_move,
    expectedLow: r.expected_low,
    expectedHigh: r.expected_high,
    expectedMoveStatus: r.expected_move_status,
    score: r.score,
    passed: r.passed,
    reviewStatus: r.review_status,
    note: r.note,
    rawChainEligible: r.raw_chain_eligible,
    rawChainRule: r.raw_chain_rule
  };
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const f = readFilters(url);
    const run = await latestRun();

    if (!run) {
      return json({
        ok: true,
        noScan: true,
        strategy: DEFAULT_STRATEGY,
        scanMode: DEFAULT_SCAN_MODE,
        dataSource: DEFAULT_DATA_SOURCE,
        generatedAt: new Date().toISOString(),
        status: "empty",
        building: false,
        universeCount: 0,
        scanned: 0,
        total: 0,
        withCondor: 0,
        passCount: 0,
        matched: 0,
        returned: 0,
        offset: f.offset,
        limit: f.limit,
        hasRows: false,
        hasMore: false,
        nextOffset: null,
        filterMode: "supabase-band-aware-page",
        processingMode: "supabase-rest-filter-page",
        serverFiltersApplied: true,
        backendFiltersRemoved: true,
        pageCta: "Scan Next 50",
        results: []
      });
    }

    const params = [`select=*`, `scan_run_id=eq.${enc(run.id)}`];
    addBandFilters(params, f);
    params.push(`order=${orderFor(f.rankBy)}`);
    const path = `scan_candidates?${params.join("&")}`;
    const rangeEnd = f.offset + f.limit - 1;
    const { data, headers } = await sbFetch(path, {
      method: "GET",
      headers: {
        Prefer: "count=exact",
        Range: `${f.offset}-${rangeEnd}`,
        "Range-Unit": "items"
      }
    });

    const rows = Array.isArray(data) ? data.map(mapRow) : [];
    const matched = contentRangeCount(headers, rows.length);
    const nextOffset = f.offset + rows.length < matched ? f.offset + rows.length : null;
    const building = ["running", "stale"].includes(String(run.status || "").toLowerCase());

    return json({
      ok: true,
      strategy: run.strategy || DEFAULT_STRATEGY,
      scanMode: run.scan_mode || DEFAULT_SCAN_MODE,
      dataSource: run.data_source || DEFAULT_DATA_SOURCE,
      generatedAt: run.updated_at || run.started_at || new Date().toISOString(),
      scanRunId: run.id,
      status: run.status,
      building,
      progress: { scanned: run.scanned_count || 0, total: run.universe_count || 0 },
      universeCount: run.universe_count || 0,
      scanned: run.scanned_count || 0,
      total: run.candidate_count || matched,
      withCondor: run.candidate_count || matched,
      passCount: matched,
      matched,
      returned: rows.length,
      offset: f.offset,
      limit: f.limit,
      hasRows: rows.length > 0,
      hasMore: nextOffset !== null,
      nextOffset,
      filterMode: "supabase-band-aware-page",
      processingMode: "supabase-rest-filter-page",
      serverFiltersApplied: true,
      backendFiltersRemoved: true,
      pageCta: "Scan Next 50",
      filters: f,
      results: rows
    });
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
};
