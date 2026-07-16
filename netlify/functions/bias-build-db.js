// POPPA'S Option Scanner v3 — Directional Bias builder (Hybrid Price-Action Bias, client-approved Mock 3).
// Source: Schwab/TOS daily price-history market data (see schwab-price-history.js).
// Writes one row per symbol per day to Supabase symbol_bias, upserted on (symbol, as_of_date).
// Idempotent by design: progress is derived by diffing the universe against symbols already
// written for today, not by a separate persisted "run" row — so there's nothing for the daily
// cleanup job to race or a stalled row to leave behind.
'use strict';

import { loadUniverse } from "../shared/universe.js";

const CHUNK = 20;
const CONCURRENCY = 4;
const MAX_RUN_MS = 50 * 1000;
const MIN_CANDLES = 35;
const EMA_SHORT = 20;
const EMA_LONG = 50;
const SLOPE_LOOKBACK_DAYS = 5;
const RANGE_LOOKBACK_DAYS = 20;
const PIVOT_WING = 2;
const METHOD = "Hybrid Price-Action Bias";

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function baseUrl(req) {
  try { const u = new URL(req.url); return process.env.URL || process.env.DEPLOY_URL || `${u.protocol}//${u.host}`; }
  catch (_) { return process.env.URL || process.env.DEPLOY_URL || ""; }
}

function ymdFromDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function pacificDateString(addDays = 0, baseMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(baseMs));
  const y = Number(parts.find(p => p.type === "year")?.value);
  const m = Number(parts.find(p => p.type === "month")?.value);
  const d = Number(parts.find(p => p.type === "day")?.value);
  const utc = new Date(Date.UTC(y, m - 1, d + Number(addDays || 0)));
  return ymdFromDate(utc);
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
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(opts.headers || {}) }
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} failed ${res.status}: ${text}`);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json") && text) return JSON.parse(text);
  return text;
}

// ── Price-history fetch ─────────────────────────────────────────────────────

async function fetchCandles(req, symbol) {
  const base = baseUrl(req);
  const u = new URL(`${base}/.netlify/functions/schwab-price-history`);
  u.searchParams.set("symbol", symbol);
  const r = await fetch(u.toString(), { method: "GET", headers: { accept: "application/json" } });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body?.ok || !Array.isArray(body.candles)) return [];
  return body.candles;
}

// ── Indicators ───────────────────────────────────────────────────────────────

function emaSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  seed /= period;
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function findPivots(candles) {
  const highs = [], lows = [];
  for (let i = PIVOT_WING; i < candles.length - PIVOT_WING; i++) {
    const h = candles[i].high, l = candles[i].low;
    let isHigh = true, isLow = true;
    for (let w = 1; w <= PIVOT_WING; w++) {
      if (!(h > candles[i - w].high && h > candles[i + w].high)) isHigh = false;
      if (!(l < candles[i - w].low && l < candles[i + w].low)) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: h });
    if (isLow) lows.push({ index: i, price: l });
  }
  return { highs, lows };
}

// ── Scoring components ──────────────────────────────────────────────────────

function trendComponent(closes, ema20, ema50) {
  const n = closes.length;
  const close = closes[n - 1], e20 = ema20[n - 1], e50 = ema50[n - 1], e20Prev = ema20[n - 1 - SLOPE_LOOKBACK_DAYS];
  if (e20 == null || e50 == null || e20Prev == null) return { score: 0, desc: "not yet computable (insufficient EMA history)" };
  const rising = e20 > e20Prev, falling = e20 < e20Prev;
  if (close > e20 && e20 > e50 && rising) return { score: 1, desc: "trending higher — price is above a rising 20-day EMA, which is above the 50-day EMA" };
  if (close < e20 && e20 < e50 && falling) return { score: -1, desc: "trending lower — price is below a falling 20-day EMA, which is below the 50-day EMA" };
  return { score: 0, desc: "mixed, with price and moving averages not clearly aligned" };
}

function pivotComponent(pivots) {
  const { highs, lows } = pivots;
  if (highs.length < 2 || lows.length < 2) return { score: 0, pattern: "Not enough confirmed pivots", desc: "not yet confirmed — too little pivot history" };
  const lastH = highs[highs.length - 1].price, prevH = highs[highs.length - 2].price;
  const lastL = lows[lows.length - 1].price, prevL = lows[lows.length - 2].price;
  if (lastH > prevH && lastL > prevL) return { score: 1, pattern: "Higher High / Higher Low", desc: "showing higher highs and higher lows" };
  if (lastH < prevH && lastL < prevL) return { score: -1, pattern: "Lower High / Lower Low", desc: "showing lower highs and lower lows" };
  return { score: 0, pattern: "Mixed Pivots", desc: "mixed, without a clear swing pattern" };
}

function rangeComponent(candles, pivots) {
  const window = candles.slice(-RANGE_LOOKBACK_DAYS);
  const hi = Math.max(...window.map(c => c.high));
  const lo = Math.min(...window.map(c => c.low));
  const close = candles[candles.length - 1].close;
  const range = hi - lo;
  const pos = range > 0 ? (close - lo) / range : 0.5;
  const latestPivotHigh = pivots.highs.length ? pivots.highs[pivots.highs.length - 1].price : null;
  const latestPivotLow = pivots.lows.length ? pivots.lows[pivots.lows.length - 1].price : null;
  const breakoutUp = latestPivotHigh != null && close > latestPivotHigh;
  const breakoutDown = latestPivotLow != null && close < latestPivotLow;
  if (pos >= 0.6 || breakoutUp) return { score: 1, desc: "in the upper part of its 20-day range" + (breakoutUp ? ", breaking above the latest pivot high" : "") };
  if (pos <= 0.4 || breakoutDown) return { score: -1, desc: "in the lower part of its 20-day range" + (breakoutDown ? ", breaking below the latest pivot low" : "") };
  return { score: 0, desc: "in the middle of its 20-day range" };
}

function computeBias(candles) {
  if (candles.length < MIN_CANDLES) return null;
  const closes = candles.map(c => c.close);
  const ema20 = emaSeries(closes, EMA_SHORT);
  const ema50 = emaSeries(closes, EMA_LONG);
  const pivots = findPivots(candles);

  const trend = trendComponent(closes, ema20, ema50);
  const pivot = pivotComponent(pivots);
  const range = rangeComponent(candles, pivots);

  const score = trend.score + pivot.score + range.score;
  const label = score >= 2 ? "Bullish" : score <= -2 ? "Bearish" : "Neutral";
  const reason = `Trend is ${trend.desc}. Pivot structure is ${pivot.desc}. Price is ${range.desc}.`;

  return {
    bias_label: label,
    bias_score: score,
    bias_method: METHOD,
    bias_reason: reason,
    trend_score: trend.score,
    pivot_score: pivot.score,
    range_score: range.score,
    close: closes[closes.length - 1],
    ema20: ema20[ema20.length - 1],
    ema50: ema50[ema50.length - 1]
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

async function alreadyDoneToday(today) {
  const rows = await sbFetch(`symbol_bias?select=symbol&as_of_date=eq.${encodeURIComponent(today)}`);
  return new Set(Array.isArray(rows) ? rows.map(r => r.symbol) : []);
}

async function upsertBiasRows(today, rows) {
  if (!rows.length) return;
  const body = rows.map(r => ({ ...r, as_of_date: today }));
  await sbFetch("symbol_bias?on_conflict=symbol,as_of_date", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body)
  });
}

export default async (req) => {
  const t0 = Date.now();
  const today = pacificDateString(0);

  let universe, done;
  try {
    universe = await loadUniverse();
    done = await alreadyDoneToday(today);
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }

  const pending = universe.filter(([sym]) => !done.has(sym));
  let attempted = 0, written = 0, skippedInsufficientData = 0, fetchFailed = 0;

  try {
    while (pending.length && (Date.now() - t0) < MAX_RUN_MS) {
      const batch = pending.splice(0, CHUNK);
      const queue = [...batch];
      const rowsOut = [];

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, async () => {
        while (queue.length) {
          const [sym] = queue.shift();
          attempted++;
          const candles = await fetchCandles(req, sym);
          if (!candles.length) { fetchFailed++; continue; }
          const bias = computeBias(candles);
          if (!bias) { skippedInsufficientData++; continue; }
          rowsOut.push({ symbol: sym, ...bias });
        }
      }));

      if (rowsOut.length) { await upsertBiasRows(today, rowsOut); written += rowsOut.length; }
    }
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err), attempted, written }, 500);
  }

  const complete = pending.length === 0;
  return json({
    ok: true,
    asOfDate: today,
    total: universe.length,
    alreadyDoneBeforeThisRun: done.size,
    attemptedThisRun: attempted,
    writtenThisRun: written,
    fetchFailedThisRun: fetchFailed,
    skippedInsufficientDataThisRun: skippedInsufficientData,
    remaining: pending.length,
    complete,
    method: METHOD
  });
};
