// POPPA'S Option Scanner v3 — shared scan universe.
// Single source of truth for which symbols get scanned, so the Schwab condor
// pull and the daily Directional Bias refresh always agree on the same set.

export const SP500_CSV = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";

export const CURATED = [
  ["SPY","SPDR S&P 500 ETF","ETF","both"], ["QQQ","Invesco QQQ Trust","ETF","both"],
  ["NVDA","NVIDIA","Technology","both"],["TSLA","Tesla","Consumer Disc.","both"],["AMD","Advanced Micro Devices","Technology","both"],
  ["AAPL","Apple","Technology","both"],["MSFT","Microsoft","Technology","both"],["META","Meta Platforms","Communications","both"],
  ["AMZN","Amazon","Consumer Disc.","both"],["GOOGL","Alphabet","Communications","both"],["AVGO","Broadcom","Technology","both"],
  ["NFLX","Netflix","Communications","both"],["MU","Micron","Technology","both"],["QCOM","Qualcomm","Technology","both"],
  ["COST","Costco","Consumer Staples","both"],["COIN","Coinbase","Financials","both"],["MSTR","Strategy","Technology","ndx"]
];

export function parseCsvLine(ln) {
  const r = []; let cur = "", q = false;
  for (const ch of ln) { if (ch === '"') q = !q; else if (ch === "," && !q) { r.push(cur); cur = ""; } else cur += ch; }
  r.push(cur); return r;
}

export async function loadUniverse() {
  try {
    const r = await fetch(SP500_CSV);
    if (!r.ok) throw new Error("csv " + r.status);
    const lines = (await r.text()).split(/\r?\n/).filter(Boolean);
    lines.shift();
    const seen = new Set(), uni = [];
    for (const c of CURATED) { uni.push(c); seen.add(c[0]); }
    for (const ln of lines) {
      const f = parseCsvLine(ln);
      const sym = (f[0] || "").trim().toUpperCase();
      if (!sym || sym.includes(".") || seen.has(sym)) continue;
      seen.add(sym);
      uni.push([sym, (f[1] || sym).trim(), (f[2] || "S&P 500").trim(), "sp"]);
    }
    return uni;
  } catch (_) { return CURATED; }
}
