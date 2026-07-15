# Poppas Pro Revised Iron Condor Scanner Package

This package revises the uploaded Poppas Pro scanner files using the recommended safer Iron Condor review framework.

## Files included

- `Options Trader Academy.html` — revised front-end page with safer scanner language, Scanner Truth Box, updated table columns, visible sample/demo banner, and expanded risk disclosure inside the order ticket.
- `daily-options-scan.js` — revised on-demand Netlify function with all-four-leg bid/ask checks, short/long leg OI fields, conservative credit, mid-credit output, and safer review-status wording.
- `scan-results.js` — revised cached-board filter with support for `minShortOI`, `minLongOI`, `maxSpread`, and selected spread width.
- `scan-daily.js` — daily scheduled trigger with wording aligned to delayed/end-of-day data.

## Key upgrades

1. Probability language now says **90%+ anchor-leg probability OTM**, not a guaranteed 90% whole-condor probability.
2. Liquidity review now separates monthly OI from selected short-leg OI.
3. Bid/ask quality now uses the widest spread across all four legs where the data is available.
4. Earnings is clearly marked as requiring verification unless an earnings feed is connected.
5. Public-facing labels now say **Matches Primary Filters**, **Candidate for Manual Review**, or **Needs Review** instead of promotional terms like “High Edge.”
6. Sample/demo fallback is visibly labeled so it is not confused with live market results.

## Deployment notes

Replace your existing files with these revised files in the same locations. If your Netlify function names already map to these filenames, deploy normally. If the site expects the HTML file to be named `index.html`, rename `Options Trader Academy.html` to `index.html` before deployment.

## Important next step

Your full background scanner file `scan-build-background.js` was referenced by the uploaded files but was not included in the upload. If that file is currently producing the cached board, it should also be upgraded to output `shortPutOI`, `shortCallOI`, `longPutOI`, `longCallOI`, `spreadMax`, and `midCredit` so the revised filters work at full strength. The revised `scan-results.js` remains backward-compatible with older cached boards, but the best version requires those fields.

## v2.1 Expected Move Upgrade

This package adds an Expected Move feature to the Poppas Pro scanner results table and exported CSV.

### Files updated

- `index.html`
  - Adds `Spot`, `Exp. Move`, and `EM Status` columns to the results table.
  - Adds expected move values to the order ticket detail panel.
  - Adds expected move fields to the CSV export.
  - Computes fallback expected move in the browser when backend fields are missing.

- `netlify/functions/scan-build-background.js`
  - Calculates and stores `expectedMove`, `expectedLow`, `expectedHigh`, and `expectedMoveStatus` for each cached-board candidate.

- `netlify/functions/daily-options-scan.js`
  - Calculates and returns the same expected move fields for quick/on-demand scan output.
  - Corrects the review-score calculation to use the number of active validation checks.

- `netlify/functions/scan-results.js`
  - Passes through stored expected move fields and computes them as a safe fallback for older cached boards.

### Formula

Expected Move = Spot × IV × sqrt(DTE / 365)

### Status labels

- `Outside EM` — both short strikes are outside the expected-move range.
- `Near EM` — a short strike is near the expected-move boundary.
- `Inside EM` — at least one short strike is inside the expected-move range and requires extra review.

### Risk note

Expected Move is an IV-based estimate for the expiration window. It is not a forecast, recommendation, or guarantee. Options involve risk and all pricing, earnings, liquidity, and risk values must be verified on the trading platform before use.
