// POPPA'S Option Scanner — unfiltered cached-board results endpoint.
// Punch-list rule: midpoint credit, after-cost ROC, separate put/call anchors,
// Lower Anchor P(OTM), and exact-width validation before a row can render.

import { getStore } from "@netlify/blobs";

const COMMISSION_DOLLARS = 2.40;
const FEES_DOLLARS = 0.04;
const TOTAL_TRADING_COST_DOLLARS = COMMISSION_DOLLARS + FEES_DOLLARS;

const num = (v, d = null) => {
  if (v === null || v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const round = (v, p = 2) => Number.isFinite(Number(v)) ? +Number(v).toFixed(p) : null;
const has = v => Number.isFinite(Number(v));
const json = (o, maxAge = 600) => new Response(JSON.stringify(o), {
  status: 200,
  headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${maxAge}` }
});

const legMid = leg => {
  const bid = num(leg?.bidRaw);
  const ask = num(leg?.askRaw);
  return bid !== null && ask !== null ? round((bid + ask) / 2, 4) : null;
};

const probabilityFromLeg = leg => {
  const raw = num(leg?.probabilityOTMRaw);
  if (raw !== null) return { value: raw, source: "Schwab raw", method: "Schwab/TOS API-provided Probability OTM", fallbackReason: null };
  const delta = Math.abs(num(leg?.deltaRaw, 0));
  return { value: round(1 - delta, 3), source: "POPPA calculated", method: "Delta approximation: 1 - abs(delta)", fallbackReason: "Schwab Probability OTM field unavailable" };
};

function validateStrikes(r) {
  const requestedWidth = num(r.requestedWidth ?? r.width);
  const shortPut = num(r.shortPut);
  const longPut = num(r.longPut);
  const shortCall = num(r.shortCall);
  const longCall = num(r.longCall);
  const actualPutWidth = shortPut !== null && longPut !== null ? round(shortPut - longPut, 4) : null;
  const actualCallWidth = shortCall !== null && longCall !== null ? round(longCall - shortCall, 4) : null;
  const symbolsPresent = Boolean(r.shortPutContractSymbol && r.longPutContractSymbol && r.shortCallContractSymbol && r.longCallContractSymbol);
  const exactPutWingFound = requestedWidth !== null && actualPutWidth === requestedWidth;
  const exactCallWingFound = requestedWidth !== null && actualCallWidth === requestedWidth;
  const equalWidthConfirmed = actualPutWidth !== null && actualPutWidth === actualCallWidth;
  const sameExpiration = !r.rawLegs || [r.rawLegs.shortPut, r.rawLegs.longPut, r.rawLegs.shortCall, r.rawLegs.longCall]
    .filter(Boolean).every(leg => !leg.expirationDate || leg.expirationDate === r.expiry);

  let strikeValidationStatus = "PASS";
  let strikeValidationReason = "Exact strikes confirmed";
  if (!symbolsPresent) { strikeValidationStatus = "REJECTED"; strikeValidationReason = "One or more Schwab contract symbols are missing"; }
  else if (!sameExpiration) { strikeValidationStatus = "REJECTED"; strikeValidationReason = "Expiration mismatch"; }
  else if (!exactPutWingFound) { strikeValidationStatus = "REJECTED"; strikeValidationReason = `Exact $${requestedWidth} put wing unavailable`; }
  else if (!exactCallWingFound) { strikeValidationStatus = "REJECTED"; strikeValidationReason = `Exact $${requestedWidth} call wing unavailable`; }
  else if (!equalWidthConfirmed) { strikeValidationStatus = "REJECTED"; strikeValidationReason = "Put and call spread widths are unequal"; }

  return {
    requestedWidth,
    actualPutWidth,
    actualCallWidth,
    exactPutWingFound,
    exactCallWingFound,
    equalWidthConfirmed,
    sameExpiration,
    symbolsPresent,
    strikeValidationStatus,
    strikeValidationReason
  };
}

function pricing(r) {
  const legs = r.rawLegs || {};
  const sp = legs.shortPut, lp = legs.longPut, sc = legs.shortCall, lc = legs.longCall;
  const allLegsPresent = Boolean(sp && lp && sc && lc);

  const naturalCredit = allLegsPresent
    ? round((num(sc.bidRaw, 0) + num(sp.bidRaw, 0)) - (num(lc.askRaw, 0) + num(lp.askRaw, 0)), 4)
    : round(r.naturalCredit ?? r.credit, 4);

  const midpointCredit = allLegsPresent
    ? round((legMid(sc) + legMid(sp)) - (legMid(lc) + legMid(lp)), 4)
    : round(r.midpointCredit ?? r.midCredit ?? r.credit, 4);

  const displayedCredit = midpointCredit;
  const width = num(r.requestedWidth ?? r.width);
  const grossCreditDollars = displayedCredit !== null ? round(displayedCredit * 100, 2) : null;
  const netCreditAfterCosts = grossCreditDollars !== null ? round(grossCreditDollars - TOTAL_TRADING_COST_DOLLARS, 2) : null;
  const grossMaxRisk = width !== null && grossCreditDollars !== null ? round(width * 100 - grossCreditDollars, 2) : null;
  const netMaxRiskAfterCosts = width !== null && netCreditAfterCosts !== null ? round(width * 100 - netCreditAfterCosts, 2) : null;
  const grossROC = grossCreditDollars !== null && grossMaxRisk > 0 ? round(grossCreditDollars / grossMaxRisk * 100, 2) : null;
  const rocAfterCommissionAndFees = netCreditAfterCosts !== null && netMaxRiskAfterCosts > 0 ? round(netCreditAfterCosts / netMaxRiskAfterCosts * 100, 2) : null;

  return {
    naturalCredit,
    midpointCredit,
    displayedCredit,
    credit: displayedCredit,
    creditSource: "POPPA calculated from Schwab bid/ask midpoint values",
    creditMethod: "Short Put Mid + Short Call Mid - Long Put Mid - Long Call Mid; each Mid = (Bid + Ask) / 2",
    commission: COMMISSION_DOLLARS,
    fees: FEES_DOLLARS,
    totalTradingCost: TOTAL_TRADING_COST_DOLLARS,
    grossCreditDollars,
    netCreditAfterCosts,
    grossMaxRisk,
    netMaxRiskAfterCosts,
    grossROC,
    roc: grossROC,
    rocAfterCommissionAndFees,
    rocAfterCosts: rocAfterCommissionAndFees,
    rocSource: "POPPA calculated",
    rocMethod: "Gross ROC = Gross Credit / Gross Max Risk; After-cost ROC = Net Credit After Costs / Net Max Risk After Costs"
  };
}

function anchors(r) {
  const put = probabilityFromLeg(r.rawLegs?.shortPut || { probabilityOTMRaw: r.putProbOtm, deltaRaw: r.rawLegs?.shortPut?.deltaRaw });
  const call = probabilityFromLeg(r.rawLegs?.shortCall || { probabilityOTMRaw: r.callProbOtm, deltaRaw: r.rawLegs?.shortCall?.deltaRaw });
  const lower = Math.min(num(put.value, 0), num(call.value, 0));
  return {
    anchorPutOTM: round(put.value, 3),
    anchorCallOTM: round(call.value, 3),
    putProbOtm: round(put.value, 3),
    callProbOtm: round(call.value, 3),
    lowerAnchorPOTM: round(lower, 3),
    lowerAnchorPOTMPercent: round(lower * 100, 1),
    probOtm: round(lower, 3),
    prob: round(lower * 100, 1),
    lowerAnchorLabel: "Lower Anchor P(OTM)",
    lowerAnchorDisclosure: "Lower of the short-put and short-call Probability OTM values; not a whole-condor probability.",
    anchorPutSource: put.source,
    anchorCallSource: call.source,
    anchorPutMethod: put.method,
    anchorCallMethod: call.method,
    anchorPutFallbackReason: put.fallbackReason,
    anchorCallFallbackReason: call.fallbackReason
  };
}

function normalizedRow(r) {
  const strike = validateStrikes(r);
  const price = pricing({ ...r, requestedWidth: strike.requestedWidth });
  const anchor = anchors(r);
  const reviewStatus = strike.strikeValidationStatus === "PASS"
    ? (r.reviewStatus || (r.passed ? "Matches primary filters ✓" : (r.note || "Candidate for manual review")))
    : `REJECTED — ${strike.strikeValidationReason}`;

  return {
    ...r,
    ...strike,
    ...price,
    ...anchor,
    width: strike.requestedWidth,
    reviewStatus,
    reviewStatusSource: "POPPA calculated",
    sourceAuditEnabled: true,
    pricingAuditEnabled: true,
    exactWidthValidationEnabled: true,
    sourceLabels: {
      ...(r.sourceLabels || {}),
      anchorPutOTM: anchor.anchorPutSource,
      anchorCallOTM: anchor.anchorCallSource,
      lowerAnchorPOTM: "POPPA calculated",
      naturalCredit: "POPPA calculated from Schwab natural bid/ask values",
      midpointCredit: "POPPA calculated from Schwab bid/ask midpoint values",
      displayedCredit: "POPPA calculated from Schwab bid/ask midpoint values",
      grossROC: "POPPA calculated",
      rocAfterCommissionAndFees: "POPPA calculated",
      strikeValidation: "POPPA calculated from Schwab contract strikes and symbols"
    },
    fieldLineage: {
      ...(r.fieldLineage || {}),
      anchorPutOTM: { rawValue: r.rawLegs?.shortPut?.probabilityOTMRaw ?? null, displayValue: anchor.anchorPutOTM, source: anchor.anchorPutSource, method: anchor.anchorPutMethod, fallbackReason: anchor.anchorPutFallbackReason },
      anchorCallOTM: { rawValue: r.rawLegs?.shortCall?.probabilityOTMRaw ?? null, displayValue: anchor.anchorCallOTM, source: anchor.anchorCallSource, method: anchor.anchorCallMethod, fallbackReason: anchor.anchorCallFallbackReason },
      lowerAnchorPOTM: { rawValue: null, displayValue: anchor.lowerAnchorPOTM, source: "POPPA calculated", method: "Minimum of Anchor P(OTM) and Anchor C(OTM)" },
      displayedCredit: { rawValue: null, displayValue: price.displayedCredit, source: price.creditSource, method: price.creditMethod },
      rocAfterCommissionAndFees: { rawValue: null, displayValue: price.rocAfterCommissionAndFees, source: "POPPA calculated", method: price.rocMethod },
      strikeValidation: { rawValue: null, displayValue: strike.strikeValidationStatus, source: "POPPA calculated", method: "Exact requested width on both sides; same expiration; all Schwab contract symbols present" }
    }
  };
}

function sortRows(rows, rankBy, passersTop) {
  return rows.sort((a, b) => {
    if (passersTop && (b.passed ? 1 : 0) !== (a.passed ? 1 : 0)) return (b.passed ? 1 : 0) - (a.passed ? 1 : 0);
    if (rankBy === "roc") return num(b.roc, -999) - num(a.roc, -999);
    return num(b.edge ?? b.score, 0) - num(a.edge ?? a.score, 0) || num(b.roc, -999) - num(a.roc, -999);
  });
}

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
      dataSource: "Schwab/TOS Market Data API",
      scanMode: "Building Schwab/TOS market-data scan…",
      lowerAnchorLabel: "Lower Anchor P(OTM)",
      pricingMethod: "Bid/ask midpoint",
      totalTradingCost: TOTAL_TRADING_COST_DOLLARS,
      results: []
    }, 30);
  }

  const q = (() => { try { return new URL(req.url).searchParams; } catch (_) { return new URLSearchParams(); } })();
  const includeRejected = q.get("includeRejected") === "true";
  const rankBy = q.get("rankBy") || "edge";
  const passersTop = ["yes", "true"].includes(q.get("passersTop"));

  const normalized = board.results.map(normalizedRow);
  const rejectedCount = normalized.filter(r => r.strikeValidationStatus !== "PASS").length;
  const rows = sortRows(includeRejected ? normalized : normalized.filter(r => r.strikeValidationStatus === "PASS"), rankBy, passersTop);

  return json({
    strategy: board.strategy || "SP500_Tight_Condor_Scan_v3_Schwab_Lineage",
    scanMode: board.scanMode || "Schwab/TOS market-data EOD snapshot · source audit enabled",
    dataSource: board.dataSource || "Schwab/TOS Market Data API",
    dataMode: board.dataMode || "Schwab market-data EOD snapshot",
    generatedAt: board.generatedAt,
    universeCount: board.universeCount,
    scanned: board.scanned,
    withCondor: rows.length,
    passCount: rows.filter(r => r.passed).length,
    rejectedInvalidStrikeCount: rejectedCount,
    includeRejected,
    lowerAnchorLabel: "Lower Anchor P(OTM)",
    lowerAnchorDisclosure: "The lower of Anchor P(OTM) and Anchor C(OTM); not a guaranteed whole-condor probability.",
    pricingMethod: "Bid/ask midpoint",
    creditDisclosure: "Displayed Credit is POPPA calculated from Schwab leg midpoints.",
    commission: COMMISSION_DOLLARS,
    fees: FEES_DOLLARS,
    totalTradingCost: TOTAL_TRADING_COST_DOLLARS,
    exactWidthValidationEnabled: true,
    exportEndpoint: "/.netlify/functions/scan-export",
    returned: rows.length,
    results: rows
  }, board.building ? 60 : 600);
};