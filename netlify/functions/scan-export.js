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
const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
const mid = leg => {
  const bid = num(leg?.bidRaw), ask = num(leg?.askRaw);
  return bid !== null && ask !== null ? round((bid + ask) / 2, 4) : null;
};
const legProb = leg => {
  const raw = num(leg?.probabilityOTMRaw);
  if (raw !== null) return raw;
  return round(1 - Math.abs(num(leg?.deltaRaw, 0)), 3);
};

function exportRow(r) {
  const legs = r.rawLegs || {};
  const sp = legs.shortPut || {}, lp = legs.longPut || {}, sc = legs.shortCall || {}, lc = legs.longCall || {};
  const requestedWidth = num(r.requestedWidth ?? r.width);
  const actualPutWidth = round(num(r.shortPut) - num(r.longPut), 4);
  const actualCallWidth = round(num(r.longCall) - num(r.shortCall), 4);
  const symbolsPresent = Boolean(r.shortPutContractSymbol && r.longPutContractSymbol && r.shortCallContractSymbol && r.longCallContractSymbol);
  const exactPutWingFound = requestedWidth !== null && actualPutWidth === requestedWidth;
  const exactCallWingFound = requestedWidth !== null && actualCallWidth === requestedWidth;
  const equalWidthConfirmed = actualPutWidth !== null && actualPutWidth === actualCallWidth;
  const strikeValidationStatus = symbolsPresent && exactPutWingFound && exactCallWingFound && equalWidthConfirmed ? "PASS" : "REJECTED";
  const strikeValidationReason = !symbolsPresent ? "Missing Schwab contract symbol" : !exactPutWingFound ? "Exact put wing unavailable" : !exactCallWingFound ? "Exact call wing unavailable" : !equalWidthConfirmed ? "Unequal spread widths" : "Exact strikes confirmed";

  const naturalCredit = round((num(sc.bidRaw, 0) + num(sp.bidRaw, 0)) - (num(lc.askRaw, 0) + num(lp.askRaw, 0)), 4);
  const midpointCredit = round((mid(sc) + mid(sp)) - (mid(lc) + mid(lp)), 4);
  const displayedCredit = midpointCredit;
  const grossCreditDollars = displayedCredit !== null ? round(displayedCredit * 100, 2) : null;
  const netCreditAfterCosts = grossCreditDollars !== null ? round(grossCreditDollars - TOTAL_TRADING_COST_DOLLARS, 2) : null;
  const grossMaxRisk = requestedWidth !== null && grossCreditDollars !== null ? round(requestedWidth * 100 - grossCreditDollars, 2) : null;
  const netMaxRiskAfterCosts = requestedWidth !== null && netCreditAfterCosts !== null ? round(requestedWidth * 100 - netCreditAfterCosts, 2) : null;
  const grossROC = grossCreditDollars !== null && grossMaxRisk > 0 ? round(grossCreditDollars / grossMaxRisk * 100, 2) : null;
  const rocAfterCommissionAndFees = netCreditAfterCosts !== null && netMaxRiskAfterCosts > 0 ? round(netCreditAfterCosts / netMaxRiskAfterCosts * 100, 2) : null;
  const anchorPut = legProb(sp);
  const anchorCall = legProb(sc);
  const lowerAnchor = Math.min(num(anchorPut, 0), num(anchorCall, 0));

  return {
    Symbol: r.symbol,
    Expiration: r.expiry,
    DTE: r.dte,
    "Short Put": r.shortPut,
    "Long Put": r.longPut,
    "Short Call": r.shortCall,
    "Long Call": r.longCall,
    "Anchor P(OTM)": round(anchorPut * 100, 1),
    "Anchor C(OTM)": round(anchorCall * 100, 1),
    "Lower Anchor P(OTM)": round(lowerAnchor * 100, 1),
    "Natural Credit": naturalCredit,
    "Midpoint Credit": midpointCredit,
    "Displayed Credit": displayedCredit,
    "Credit Source": "POPPA calculated from Schwab bid/ask midpoint values",
    "Credit Method": "Short Put Mid + Short Call Mid - Long Put Mid - Long Call Mid",
    Commission: COMMISSION_DOLLARS,
    Fees: FEES_DOLLARS,
    "Total Trading Cost": TOTAL_TRADING_COST_DOLLARS,
    "Gross Credit Dollars": grossCreditDollars,
    "Net Credit After Costs": netCreditAfterCosts,
    "Gross Max Risk": grossMaxRisk,
    "Net Max Risk After Costs": netMaxRiskAfterCosts,
    "Gross ROC": grossROC,
    "ROC After Commission & Fees": rocAfterCommissionAndFees,
    "ROC Source": "POPPA calculated",
    "ROC Method": "Credit / Max Risk; costs included in after-cost calculation",
    "Requested Width": requestedWidth,
    "Actual Put Width": actualPutWidth,
    "Actual Call Width": actualCallWidth,
    "Exact Put Wing Found": exactPutWingFound,
    "Exact Call Wing Found": exactCallWingFound,
    "Equal Width Confirmed": equalWidthConfirmed,
    "Strike Validation Status": strikeValidationStatus,
    "Strike Validation Reason": strikeValidationReason,
    "Short Put Contract Symbol": r.shortPutContractSymbol,
    "Long Put Contract Symbol": r.longPutContractSymbol,
    "Short Call Contract Symbol": r.shortCallContractSymbol,
    "Long Call Contract Symbol": r.longCallContractSymbol,
    "Data Source": r.dataSource || "Schwab/TOS Market Data API",
    "Quote Time": r.quoteTimeRaw || r.asOf || "",
    "Trade Time": r.tradeTimeRaw || ""
  };
}

export default async function handler(req) {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const store = getStore("poppas-scan");
  const board = await store.get("latest", { type: "json" }).catch(() => null);
  if (!board || !Array.isArray(board.results)) return new Response("No scanner board available", { status: 404 });

  const url = new URL(req.url);
  const includeRejected = url.searchParams.get("includeRejected") === "true";
  const rows = board.results.map(exportRow).filter(r => includeRejected || r["Strike Validation Status"] === "PASS");
  const headers = rows.length ? Object.keys(rows[0]) : ["Symbol"];
  const csv = [headers.map(esc).join(","), ...rows.map(row => headers.map(h => esc(row[h])).join(","))].join("\r\n");

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="poppas-schwab-scan-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store"
    }
  });
}
