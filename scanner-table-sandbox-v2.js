// POPPA'S Scanner Table Sandbox — Punch List Items 1 and 2.
// Sandbox-only controller. Production scanner remains unchanged.
(function () {
  'use strict';

  const RESULTS_ENDPOINT = '/.netlify/functions/scan-results';
  const EXPORT_ENDPOINT = '/.netlify/functions/scan-export';
  const COMMISSION = 2.40;
  const FEES = 0.04;
  const TOTAL_COST = COMMISSION + FEES;

  const HEADERS = [
    ['review','Review','Select this row for the educational order-ticket review.'],
    ['symbol','Symbol','Underlying symbol.'],
    ['expiry','Expiration','Option expiration date.'],
    ['dte','DTE','Calendar days to expiration.'],
    ['spot','Spot','Source: Schwab raw underlying price.'],
    ['shortPut','Short Put','Selected short-put strike.'],
    ['longPut','Long Put','Selected long-put strike.'],
    ['shortCall','Short Call','Selected short-call strike.'],
    ['longCall','Long Call','Selected long-call strike.'],
    ['requestedWidth','Width','Requested width and exact put/call width validation.'],
    ['anchorPutOTM','Anchor P(OTM)','Probability OTM for the short-put anchor leg.'],
    ['anchorCallOTM','Anchor C(OTM)','Probability OTM for the short-call anchor leg.'],
    ['lowerAnchorPOTM','Lower Anchor P(OTM)','Lower of the short-put and short-call anchor probabilities. Not a whole-condor probability.'],
    ['naturalCredit','Natural Credit','Credit using short-leg bids and long-leg asks.'],
    ['midpointCredit','Midpoint Credit','Credit using the midpoint of each Schwab bid/ask quote.'],
    ['displayedCredit','Displayed Credit','The approved candidate credit. Equal to Midpoint Credit.'],
    ['grossROC','Gross ROC','Return on risk before commission and fees.'],
    ['rocAfterCommissionAndFees','ROC After Comm & Fees','Return on risk after $2.40 commission and $0.04 fees.'],
    ['monthlyChainIV','Monthly Chain IV','Monthly option-chain implied volatility and source lineage.'],
    ['openInterest','Monthly Chain OI','Schwab raw aggregation across the selected monthly chain.'],
    ['shortPutOI','Short Put OI','Schwab open interest for the short-put anchor.'],
    ['shortCallOI','Short Call OI','Schwab open interest for the short-call anchor.'],
    ['spreadMax','Max Bid/Ask Spread','Largest Schwab bid/ask spread among the four selected legs.'],
    ['expectedMove','Expected Move','Expected move and calculation lineage.'],
    ['expectedMoveStatus','EM Status','Outside EM, Near EM, Inside EM, or Verify.'],
    ['earnings','Earnings','Earnings status or next known earnings date.'],
    ['strikeValidationStatus','Strike Validation','Confirms exact requested strikes, equal widths, same expiration, and valid Schwab contract symbols.'],
    ['reviewStatus','Review Status','Educational review classification only; not a trade recommendation.']
  ];

  let rows = [];
  let shownRows = [];
  let sortKey = 'rocAfterCommissionAndFees';
  let sortDir = -1;
  let selectedIndex = -1;

  const byId = id => document.getElementById(id);
  const num = (v, fallback = null) => {
    if (v === null || v === undefined || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const pick = (...vals) => vals.find(v => v !== null && v !== undefined && v !== '');
  const esc = v => String(v ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = v => num(v) === null ? '—' : '$' + num(v).toFixed(2);
  const whole = v => num(v) === null ? '—' : Math.round(num(v)).toLocaleString();
  const percent = v => {
    const n = num(v);
    if (n === null) return '—';
    const p = Math.abs(n) <= 1 ? n * 100 : n;
    return p.toFixed(1) + '%';
  };
  const isoDate = v => v ? String(v).slice(0,10) : '—';
  const leg = (r, key) => r.rawLegs && r.rawLegs[key] ? r.rawLegs[key] : {};
  const legMid = l => {
    const bid = num(pick(l.bidRaw, l.bid));
    const ask = num(pick(l.askRaw, l.ask));
    return bid !== null && ask !== null ? (bid + ask) / 2 : null;
  };
  const field = (r, camel, snake) => pick(r[camel], snake ? r[snake] : undefined);

  function normalized(r) {
    const shortPut = num(field(r,'shortPut','short_put'));
    const longPut = num(field(r,'longPut','long_put'));
    const shortCall = num(field(r,'shortCall','short_call'));
    const longCall = num(field(r,'longCall','long_call'));
    const requestedWidth = num(pick(r.requestedWidth, r.width));
    const actualPutWidth = num(pick(r.actualPutWidth, shortPut !== null && longPut !== null ? shortPut - longPut : null));
    const actualCallWidth = num(pick(r.actualCallWidth, longCall !== null && shortCall !== null ? longCall - shortCall : null));
    const raw = r.rawLegs || {};

    const naturalCredit = num(pick(r.naturalCredit,
      raw.shortPut && raw.longPut && raw.shortCall && raw.longCall
        ? num(pick(raw.shortPut.bidRaw,raw.shortPut.bid),0) + num(pick(raw.shortCall.bidRaw,raw.shortCall.bid),0) - num(pick(raw.longPut.askRaw,raw.longPut.ask),0) - num(pick(raw.longCall.askRaw,raw.longCall.ask),0)
        : r.credit));
    const computedMid = raw.shortPut && raw.longPut && raw.shortCall && raw.longCall
      ? legMid(raw.shortPut) + legMid(raw.shortCall) - legMid(raw.longPut) - legMid(raw.longCall)
      : null;
    const midpointCredit = num(pick(r.midpointCredit, r.midCredit, r.mid_credit, computedMid, r.credit));
    const displayedCredit = midpointCredit;
    const grossCreditDollars = displayedCredit !== null ? displayedCredit * 100 : null;
    const netCreditAfterCosts = grossCreditDollars !== null ? grossCreditDollars - TOTAL_COST : null;
    const grossMaxRisk = requestedWidth !== null && grossCreditDollars !== null ? requestedWidth * 100 - grossCreditDollars : null;
    const netMaxRiskAfterCosts = requestedWidth !== null && netCreditAfterCosts !== null ? requestedWidth * 100 - netCreditAfterCosts : null;
    const grossROC = num(pick(r.grossROC, r.roc), grossCreditDollars !== null && grossMaxRisk > 0 ? grossCreditDollars / grossMaxRisk * 100 : null);
    const rocAfterCommissionAndFees = num(pick(r.rocAfterCommissionAndFees, r.rocAfterCosts), netCreditAfterCosts !== null && netMaxRiskAfterCosts > 0 ? netCreditAfterCosts / netMaxRiskAfterCosts * 100 : null);

    const anchorPutOTM = num(pick(r.anchorPutOTM, r.putProbOtm, r.put_prob_otm));
    const anchorCallOTM = num(pick(r.anchorCallOTM, r.callProbOtm, r.call_prob_otm));
    const lowerAnchorPOTM = num(pick(r.lowerAnchorPOTMPercent, r.lowerAnchorPOTM, r.prob, r.probOtm, r.prob_otm),
      anchorPutOTM !== null && anchorCallOTM !== null ? Math.min(anchorPutOTM, anchorCallOTM) : null);

    const shortPutContractSymbol = pick(r.shortPutContractSymbol, r.source_payload && r.source_payload.option_put_short, raw.shortPut && pick(raw.shortPut.symbol,raw.shortPut.contractSymbol));
    const longPutContractSymbol = pick(r.longPutContractSymbol, r.source_payload && r.source_payload.option_put_long, raw.longPut && pick(raw.longPut.symbol,raw.longPut.contractSymbol));
    const shortCallContractSymbol = pick(r.shortCallContractSymbol, r.source_payload && r.source_payload.option_call_short, raw.shortCall && pick(raw.shortCall.symbol,raw.shortCall.contractSymbol));
    const longCallContractSymbol = pick(r.longCallContractSymbol, r.source_payload && r.source_payload.option_call_long, raw.longCall && pick(raw.longCall.symbol,raw.longCall.contractSymbol));
    const symbolsPresent = Boolean(shortPutContractSymbol && longPutContractSymbol && shortCallContractSymbol && longCallContractSymbol);
    const equalWidthConfirmed = r.equalWidthConfirmed !== undefined ? Boolean(r.equalWidthConfirmed) : actualPutWidth !== null && actualPutWidth === actualCallWidth;
    const exactPutWingFound = r.exactPutWingFound !== undefined ? Boolean(r.exactPutWingFound) : requestedWidth !== null && actualPutWidth === requestedWidth;
    const exactCallWingFound = r.exactCallWingFound !== undefined ? Boolean(r.exactCallWingFound) : requestedWidth !== null && actualCallWidth === requestedWidth;
    const status = pick(r.strikeValidationStatus,
      symbolsPresent && equalWidthConfirmed && exactPutWingFound && exactCallWingFound ? 'PASS' : 'REJECTED');
    const reason = pick(r.strikeValidationReason, status === 'PASS' ? 'Exact strikes confirmed' : !symbolsPresent ? 'One or more Schwab contract symbols are missing' : !exactPutWingFound ? 'Exact put wing unavailable' : !exactCallWingFound ? 'Exact call wing unavailable' : 'Unequal spread widths');

    return {
      ...r, shortPut,longPut,shortCall,longCall,requestedWidth,actualPutWidth,actualCallWidth,
      naturalCredit,midpointCredit,displayedCredit,grossCreditDollars,netCreditAfterCosts,grossMaxRisk,netMaxRiskAfterCosts,grossROC,rocAfterCommissionAndFees,
      anchorPutOTM,anchorCallOTM,lowerAnchorPOTM,
      shortPutContractSymbol,longPutContractSymbol,shortCallContractSymbol,longCallContractSymbol,
      symbolsPresent,equalWidthConfirmed,exactPutWingFound,exactCallWingFound,
      strikeValidationStatus:status,strikeValidationReason:reason,
      monthlyChainIV: pick(r.monthlyChainIVDisplay,r.monthlyChainIV,r.ivDisplay,r.iv),
      openInterest: pick(r.openInterest,r.monthlyOI,r.open_interest),
      shortPutOI: pick(r.shortPutOI,r.short_put_oi), shortCallOI: pick(r.shortCallOI,r.short_call_oi),
      spreadMax: pick(r.spreadMax,r.spread_max), expectedMove: pick(r.expectedMoveDisplay,r.expectedMove,r.expected_move),
      expectedMoveStatus: pick(r.expectedMoveStatus,r.expected_move_status,'Verify'),
      expiry: pick(r.expiry,r.expiration), spot: pick(r.spotDisplay,r.spot),
      reviewStatus: pick(r.reviewStatus,r.review_status,status === 'PASS' ? 'Matches primary filters ✓' : 'REJECTED — ' + reason)
    };
  }

  function legTitle(r, key, contractSymbol, includeDelta) {
    const l = leg(r,key);
    const parts = [
      'Contract: ' + (contractSymbol || 'Verify'),
      'Schwab Bid: ' + money(pick(l.bidRaw,l.bid)),
      'Schwab Ask: ' + money(pick(l.askRaw,l.ask)),
      'Schwab Midpoint: ' + money(legMid(l)),
      includeDelta ? 'Delta: ' + (pick(l.deltaRaw,l.delta,'Verify')) : null,
      'Open Interest: ' + whole(pick(l.openInterestRaw,l.openInterest,l.oi)),
      'Quote Time: ' + (pick(l.quoteTimeRaw,l.quoteTime,r.quoteTimeRaw,r.asOf,'Verify'))
    ].filter(Boolean);
    return parts.join('\n');
  }

  function addStyles() {
    if (byId('poppas-sandbox-v2-css')) return;
    const s = document.createElement('style');
    s.id = 'poppas-sandbox-v2-css';
    s.textContent = `
      #poppasSandboxToolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0 18px}
      #poppasSandboxToolbar label{display:flex;flex-direction:row;align-items:center;gap:8px;text-transform:none;letter-spacing:0;color:var(--silver)}
      #poppasSandboxToolbar input{width:auto}
      .sandbox-review-btn{padding:7px 10px;border:1px solid var(--line2);border-radius:7px;background:rgba(123,220,255,.12);color:#fff;cursor:pointer;font-weight:800}
      .strike-pass{color:var(--green);font-weight:900}.strike-rejected{color:var(--red);font-weight:900}
      .sandbox-source-note{font-size:.78rem;color:var(--muted);margin-top:5px;white-space:normal;min-width:160px}
      #sandboxOrderTicket{margin-top:18px}.sandbox-ticket-grid{display:grid;grid-template-columns:repeat(4,minmax(160px,1fr));gap:10px;margin-top:14px}
      .sandbox-ticket-item{border:1px solid var(--line);border-radius:12px;padding:12px;background:rgba(255,255,255,.04)}
      .sandbox-ticket-item span{display:block;color:var(--muted);font-size:.66rem;letter-spacing:.09em;text-transform:uppercase}.sandbox-ticket-item strong{display:block;color:#fff;margin-top:4px}
      .table-wrap table{min-width:4400px}.table-wrap th{cursor:pointer}.table-wrap td{white-space:nowrap}.table-wrap td:last-child{white-space:normal;min-width:220px}
      @media(max-width:700px){#sandboxOrderTicket .sandbox-ticket-grid{grid-template-columns:1fr}.table-wrap{max-width:100%;overflow-x:auto}}
    `;
    document.head.appendChild(s);
  }

  function updateLabels() {
    document.querySelectorAll('label').forEach(label => {
      const text = label.childNodes[0] && label.childNodes[0].nodeType === 3 ? label.childNodes[0] : null;
      if (!text) return;
      if (/Target ROC.*min/i.test(text.nodeValue)) text.nodeValue = 'Target ROC After Costs — Minimum (%)';
      if (/Target ROC.*max/i.test(text.nodeValue)) text.nodeValue = 'Target ROC After Costs — Maximum (%)';
      if (/Min anchor P\(OTM\)/i.test(text.nodeValue)) text.nodeValue = 'Minimum Lower Anchor P(OTM) (%)';
    });
  }

  function setupTable() {
    const body = byId('resultsBody');
    if (!body) return false;
    const table = body.closest('table');
    if (!table) return false;
    let thead = table.querySelector('thead');
    if (!thead) { thead = document.createElement('thead'); table.prepend(thead); }
    thead.innerHTML = '<tr>' + HEADERS.map(([key,label,title]) => `<th data-sort="${esc(key)}" title="${esc(title)}">${esc(label)}</th>`).join('') + '</tr>';
    thead.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (key === 'review') return;
      if (sortKey === key) sortDir *= -1; else { sortKey = key; sortDir = key === 'symbol' || key === 'expiry' || key === 'strikeValidationStatus' || key === 'reviewStatus' ? 1 : -1; }
      render();
    }));
    return true;
  }

  function setupToolbar() {
    const body = byId('resultsBody');
    if (!body || byId('poppasSandboxToolbar')) return;
    const wrap = body.closest('.table-wrap') || body.closest('table');
    const toolbar = document.createElement('div');
    toolbar.id = 'poppasSandboxToolbar';
    toolbar.innerHTML = `
      <button id="sandboxRefreshBtn" class="btn primary" type="button">Load Updated Candidates</button>
      <button id="sandboxExportBtn" class="btn secondary" type="button">Export CSV</button>
      <label><input id="sandboxShowRejected" type="checkbox"> Show Rejected Strike Candidates</label>
      <span id="sandboxTableStatus" class="pill">Waiting</span>`;
    wrap.parentNode.insertBefore(toolbar, wrap);
    byId('sandboxRefreshBtn').addEventListener('click', load);
    byId('sandboxExportBtn').addEventListener('click', () => {
      const diagnostic = byId('sandboxShowRejected').checked ? '?includeRejected=true' : '';
      window.location.href = EXPORT_ENDPOINT + diagnostic;
    });
    byId('sandboxShowRejected').addEventListener('change', load);
  }

  function setupTicket() {
    if (byId('sandboxOrderTicket')) return;
    const body = byId('resultsBody');
    const wrap = body && (body.closest('.table-wrap') || body.closest('table'));
    if (!wrap) return;
    const panel = document.createElement('div');
    panel.id = 'sandboxOrderTicket';
    panel.className = 'panel';
    panel.innerHTML = '<p class="eyebrow">Selected Candidate</p><h2 class="title">POPPA’S Educational Order Ticket</h2><div class="note"><strong>Displayed credit uses Schwab bid/ask midpoint values.</strong> Actual fills may differ.</div><div id="sandboxTicketContent" class="sandbox-ticket-grid"><div class="sandbox-ticket-item"><span>Status</span><strong>Select a candidate row</strong></div></div>';
    wrap.insertAdjacentElement('afterend',panel);
  }

  function valueForSort(r,key) {
    if (key === 'symbol' || key === 'expiry' || key === 'strikeValidationStatus' || key === 'reviewStatus') return String(r[key] || '');
    return num(r[key], -Infinity);
  }

  function applyFilters(list) {
    const minProb = num(byId('minProb') && byId('minProb').value, 0);
    const rocMin = num(byId('rocMin') && byId('rocMin').value, -Infinity);
    const rocMax = num(byId('rocMax') && byId('rocMax').value, Infinity);
    const ivMin = num(byId('ivMin') && byId('ivMin').value, -Infinity);
    const oiMin = num(byId('minOI') && byId('minOI').value, -Infinity);
    const shortOiMin = num(byId('minShortOI') && byId('minShortOI').value, -Infinity);
    const maxSpread = num(byId('maxSpread') && byId('maxSpread').value, Infinity);
    const width = num(byId('spreadWidth') && byId('spreadWidth').value, 0);
    const dteParts = String(byId('dteWindow') ? byId('dteWindow').value : '15-45').match(/(\d+)\D+(\d+)/);
    const dteMin = dteParts ? Number(dteParts[1]) : 15;
    const dteMax = dteParts ? Number(dteParts[2]) : 45;
    const showRejected = Boolean(byId('sandboxShowRejected') && byId('sandboxShowRejected').checked);
    return list.filter(r => {
      if (!showRejected && r.strikeValidationStatus !== 'PASS') return false;
      const lower = Math.abs(num(r.lowerAnchorPOTM,0)) <= 1 ? num(r.lowerAnchorPOTM,0)*100 : num(r.lowerAnchorPOTM,0);
      if (lower < minProb) return false;
      if (num(r.rocAfterCommissionAndFees,-Infinity) < rocMin || num(r.rocAfterCommissionAndFees,Infinity) > rocMax) return false;
      const iv = Math.abs(num(r.monthlyChainIV,0)) <= 1 ? num(r.monthlyChainIV,0)*100 : num(r.monthlyChainIV,0);
      if (iv < ivMin) return false;
      if (num(r.openInterest,0) < oiMin || num(r.shortPutOI,0) < shortOiMin || num(r.shortCallOI,0) < shortOiMin) return false;
      if (num(r.spreadMax,Infinity) > maxSpread) return false;
      if (width > 0 && num(r.requestedWidth) !== width) return false;
      if (num(r.dte,-Infinity) < dteMin || num(r.dte,Infinity) > dteMax) return false;
      return true;
    });
  }

  function earningsText(r) {
    if (r.earnings === false) return 'Clear';
    const date = pick(r.earningsDate,r.earnings_date,r.nextEarnings,r.next_earnings);
    if (date) return 'Earnings ' + isoDate(date);
    return r.earnings === true ? 'Earnings in window' : 'Verify';
  }

  function render() {
    const body = byId('resultsBody');
    if (!body) return;
    shownRows = applyFilters(rows.slice());
    shownRows.sort((a,b) => {
      if (a.strikeValidationStatus !== b.strikeValidationStatus) return a.strikeValidationStatus === 'PASS' ? -1 : 1;
      const av = valueForSort(a,sortKey), bv = valueForSort(b,sortKey);
      if (typeof av === 'string') return av.localeCompare(bv) * sortDir;
      const primary = (av - bv) * sortDir;
      if (primary) return primary;
      const lower = num(b.lowerAnchorPOTM,0) - num(a.lowerAnchorPOTM,0);
      return lower || num(b.openInterest,0) - num(a.openInterest,0);
    });
    const maxResults = Math.max(1, Math.min(500, num(byId('maxResults') && byId('maxResults').value,50)));
    shownRows = shownRows.slice(0,maxResults);
    if (!shownRows.length) {
      body.innerHTML = '<tr><td colspan="28" class="empty">No candidates match the current sandbox controls.</td></tr>';
      byId('sandboxTableStatus').textContent = '0 displayed';
      return;
    }
    body.innerHTML = shownRows.map((r,i) => {
      const widthTitle = `Requested Width: ${money(r.requestedWidth)}\nActual Put Width: ${money(r.actualPutWidth)}\nActual Call Width: ${money(r.actualCallWidth)}\nEqual Widths: ${r.equalWidthConfirmed ? 'Confirmed' : 'Not confirmed'}`;
      const lowerTitle = 'The lower of the short-put and short-call Probability OTM values. It identifies the weaker anchor leg and is not a guaranteed whole-condor probability.';
      const afterTitle = `Commission: $2.40\nFees: $0.04\nTotal Cost: $2.44\nNet Credit After Costs: ${money(r.netCreditAfterCosts)}\nNet Maximum Risk: ${money(r.netMaxRiskAfterCosts)}`;
      const strikeClass = r.strikeValidationStatus === 'PASS' ? 'strike-pass' : 'strike-rejected';
      const em = String(r.expectedMoveStatus||'').toLowerCase();
      const emClass = em.includes('outside') ? 'em-out' : em.includes('inside') ? 'em-in' : em.includes('near') ? 'em-near' : 'warn';
      return `<tr data-index="${i}">
        <td><button class="sandbox-review-btn" type="button">Review</button></td>
        <td><strong>${esc(r.symbol)}</strong></td><td>${esc(isoDate(r.expiry))}</td><td>${esc(r.dte)}</td><td title="Source: Schwab raw underlying price">${money(r.spot)}</td>
        <td title="${esc(legTitle(r,'shortPut',r.shortPutContractSymbol,true))}">${esc(r.shortPut)}</td>
        <td title="${esc(legTitle(r,'longPut',r.longPutContractSymbol,false))}">${esc(r.longPut)}</td>
        <td title="${esc(legTitle(r,'shortCall',r.shortCallContractSymbol,true))}">${esc(r.shortCall)}</td>
        <td title="${esc(legTitle(r,'longCall',r.longCallContractSymbol,false))}">${esc(r.longCall)}</td>
        <td title="${esc(widthTitle)}">${money(r.requestedWidth)}</td>
        <td title="Probability OTM for the short-put anchor leg. Schwab raw when provided; otherwise POPPA’S delta-based approximation.\nSource: ${esc(pick(r.anchorPutSource,'Verify'))}\nMethod: ${esc(pick(r.anchorPutMethod,'Verify'))}">${percent(r.anchorPutOTM)}</td>
        <td title="Probability OTM for the short-call anchor leg. Schwab raw when provided; otherwise POPPA’S delta-based approximation.\nSource: ${esc(pick(r.anchorCallSource,'Verify'))}\nMethod: ${esc(pick(r.anchorCallMethod,'Verify'))}">${percent(r.anchorCallOTM)}</td>
        <td title="${esc(lowerTitle)}">${percent(r.lowerAnchorPOTM)}</td>
        <td title="POPPA’S calculated natural credit using Schwab raw bid and ask values.">${money(r.naturalCredit)}</td>
        <td title="POPPA’S calculated from Schwab bid/ask midpoint values.">${money(r.midpointCredit)}</td>
        <td title="Credit Source: ${esc(pick(r.creditSource,'POPPA calculated from Schwab bid/ask midpoint values'))}\nCredit Method: ${esc(pick(r.creditMethod,'Short-leg midpoints minus long-leg midpoints'))}">${money(r.displayedCredit)}</td>
        <td title="Gross return on risk before commission and fees. POPPA’S calculated.">${percent(r.grossROC)}</td>
        <td title="${esc(afterTitle)}">${percent(r.rocAfterCommissionAndFees)}</td>
        <td title="Source: ${esc(pick(r.monthlyChainIVSource,'Verify'))}\nMethod: ${esc(pick(r.monthlyChainIVMethod,'Verify'))}\nFallback: ${esc(pick(r.monthlyChainIVFallbackReason,'None'))}">${percent(r.monthlyChainIV)}</td>
        <td>${whole(r.openInterest)}</td><td>${whole(r.shortPutOI)}</td><td>${whole(r.shortCallOI)}</td>
        <td title="Largest Schwab bid/ask spread among the four selected legs.">${money(r.spreadMax)}</td>
        <td title="Source: ${esc(pick(r.expectedMoveSource,'POPPA calculated'))}\nMethod: ${esc(pick(r.expectedMoveMethod,'Verify'))}\nFallback: ${esc(pick(r.expectedMoveFallbackReason,'None'))}">${r.expectedMove === null || r.expectedMove === undefined ? '—' : '±'+money(r.expectedMove)}</td>
        <td class="${emClass}">${esc(r.expectedMoveStatus)}</td><td>${esc(earningsText(r))}</td>
        <td class="${strikeClass}" title="${esc(r.strikeValidationReason)}">${esc(r.strikeValidationStatus)}<div class="sandbox-source-note">${esc(r.strikeValidationReason)}</div></td>
        <td>${esc(r.reviewStatus)}<div class="sandbox-source-note">Educational review classification only; not a trade recommendation.</div></td>
      </tr>`;
    }).join('');
    body.querySelectorAll('tr[data-index]').forEach(tr => tr.addEventListener('click', () => selectRow(Number(tr.dataset.index))));
    byId('sandboxTableStatus').textContent = `${shownRows.length.toLocaleString()} displayed · ${rows.length.toLocaleString()} loaded`;
    selectRow(0);
  }

  function selectRow(index) {
    selectedIndex = index;
    const r = shownRows[index];
    if (!r) return;
    const body = byId('resultsBody');
    body.querySelectorAll('tr').forEach(tr => tr.classList.remove('row-active'));
    const active = body.querySelector(`tr[data-index="${index}"]`);
    if (active) active.classList.add('row-active');
    const fields = [
      ['Short Put',r.shortPut],['Long Put',r.longPut],['Short Call',r.shortCall],['Long Call',r.longCall],
      ['Requested Width',money(r.requestedWidth)],['Actual Put Width',money(r.actualPutWidth)],['Actual Call Width',money(r.actualCallWidth)],['Exact-Width Validation',r.strikeValidationStatus+' — '+r.strikeValidationReason],
      ['Natural Credit',money(r.naturalCredit)],['Midpoint Credit',money(r.midpointCredit)],['Displayed Credit',money(r.displayedCredit)],['Commission','$2.40'],['Fees','$0.04'],
      ['Net Credit After Costs',money(r.netCreditAfterCosts)],['Gross Maximum Risk',money(r.grossMaxRisk)],['Net Maximum Risk After Costs',money(r.netMaxRiskAfterCosts)],
      ['Gross ROC',percent(r.grossROC)],['ROC After Commission & Fees',percent(r.rocAfterCommissionAndFees)],['Anchor P(OTM)',percent(r.anchorPutOTM)],['Anchor C(OTM)',percent(r.anchorCallOTM)],['Lower Anchor P(OTM)',percent(r.lowerAnchorPOTM)],
      ['Expected Move',r.expectedMove == null ? '—' : '±'+money(r.expectedMove)],['Quote Time',pick(r.quoteTimeRaw,r.asOf,'Verify')],['Data Source',pick(r.dataSource,'Schwab/TOS Market Data API')]
    ];
    byId('sandboxTicketContent').innerHTML = fields.map(([label,value]) => `<div class="sandbox-ticket-item"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');
  }

  async function load() {
    const status = byId('sandboxTableStatus');
    if (status) status.textContent = 'Loading…';
    const includeRejected = Boolean(byId('sandboxShowRejected') && byId('sandboxShowRejected').checked);
    try {
      const response = await fetch(RESULTS_ENDPOINT + (includeRejected ? '?includeRejected=true' : ''), { cache:'no-store', headers:{accept:'application/json'} });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      rows = (Array.isArray(data.results) ? data.results : Array.isArray(data.rows) ? data.rows : []).map(normalized);
      render();
      const truth = byId('truthDataMode'); if (truth) truth.textContent = pick(data.dataMode,data.scanMode,'Schwab/TOS market data');
      const build = byId('truthBuild'); if (build) build.textContent = data.building ? 'Building' : 'Ready';
      const universe = byId('truthUniverse'); if (universe) universe.textContent = whole(pick(data.universeCount,data.total,rows.length));
      const last = byId('truthLastScan'); if (last) last.textContent = pick(data.generatedAt,'Available');
    } catch (error) {
      if (status) status.textContent = 'Load failed';
      const body = byId('resultsBody');
      if (body) body.innerHTML = `<tr><td colspan="28" class="empty">Unable to load sandbox candidates: ${esc(error.message)}</td></tr>`;
    }
  }

  function bindControls() {
    ['rocMin','rocMax','minProb','ivMin','minOI','minShortOI','maxSpread','spreadWidth','dteWindow','maxResults'].forEach(id => {
      const el = byId(id); if (el) el.addEventListener('change',render);
    });
  }

  function init() {
    addStyles(); updateLabels();
    if (!setupTable()) return;
    setupToolbar(); setupTicket(); bindControls(); load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
