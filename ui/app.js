// PineWASM Desktop UI
'use strict';

const SAMPLE = `//@version=6
strategy("Band Flip [PineWASM]", overlay=true,
     default_qty_type=strategy.percent_of_equity,
     default_qty_value=20,
     commission_type=strategy.commission.percent,
     commission_value=0.05)

len    = input.int(20,  "Length")
mult   = input.float(2.0, "BB Mult")
rsiLen = input.int(14,  "RSI Length")

basis = ta.sma(close, len)
dev   = mult * ta.stdev(close, len)
upper = basis + dev
lower = basis - dev
rsi   = ta.rsi(close, rsiLen)

longCond  = close < lower and rsi < 35
shortCond = close > upper and rsi > 65

if strategy.position_size > 0 and close > basis
    strategy.close("Long")
if strategy.position_size < 0 and close < basis
    strategy.close("Short")
if longCond
    strategy.entry("Long", strategy.long)
if shortCond
    strategy.entry("Short", strategy.short)

plot(basis, "Basis", color=color.gray)
plot(upper, "Upper", color=color.green)
plot(lower, "Lower", color=color.red)
if strategy.position_size > 0
    strategy.exit("XL", "Long", stop=strategy.position_avg_price * 0.98, limit=strategy.position_avg_price * 1.03)
if strategy.position_size < 0
    strategy.exit("XS", "Short", stop=strategy.position_avg_price * 1.02, limit=strategy.position_avg_price * 0.97)

`;

let dataSpec = { source: 'sample', n: 3000 };
let lastDataLabel = 'SAMPLE 3000 BARS';
let lastInputs = null;
let lastMeta = null;

const $ = id => document.getElementById(id);

/* ---------- pill ---------- */
function setPill(text, cls) {
  const p = $('statusPill');
  p.textContent = text;
  p.className = 'pill' + (cls ? ' ' + cls : '');
}

/* ---------- console ---------- */
function log(msg, cls) {
  const c = $('console');
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = msg;
  c.appendChild(div);
  c.scrollTop = c.scrollHeight;
}

/* ---------- editor gutter ---------- */
const editor = $('editor'), gutter = $('gutter');
function syncGutter() {
  const lines = editor.value.split('\n').length;
  let s = '';
  for (let k = 1; k <= lines; k++) s += k + '\n';
  gutter.textContent = s;
  gutter.scrollTop = editor.scrollTop;
}
editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
editor.addEventListener('input', syncGutter);
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const st = editor.selectionStart;
    editor.setRangeText('    ', st, editor.selectionEnd, 'end');
  }
});

/* ---------- chart (zoom + pan + live resize) ---------- */
const COLORS = ['#CE2029', '#32CD32', '#1E90FF', '#FFFFFF', '#808080'];
let lastRes = null;
let view = { start: 0, end: 1 };
let chartH = 300;
let lastCanvasKey = '';
let showLevels = true;

function viewFit(n) { view.start = 0; view.end = Math.max(1, n - 1); }

function clampView(n) {
  const minSpan = Math.min(n, 2);
  if (view.end - view.start < minSpan) view.end = Math.min(n - 1, view.start + minSpan);
  if (view.end - view.start > n - 1) { view.start = 0; view.end = n - 1; }
  if (view.start < 0) { view.end -= view.start; view.start = 0; }
  if (view.end > n - 1) { view.start -= view.end - (n - 1); view.end = n - 1; }
  if (view.start < 0) view.start = 0;
}

function chartCW() { return Math.max(100, $('chart').width - 64); }

let priceZoom = 1; // vertical scale (TV-style price axis drag)

function drawChart(res) {
  if (!res || !res.c.length) return;
  const cv = $('chart');
  const wrap = cv.parentElement;
  const W = Math.max(320, wrap.clientWidth - 20);
  const overlay = res.meta && res.meta.overlay;
  const subH = overlay ? 0 : 110;
  const H = chartH + subH;
  const n = res.c.length;
  clampView(n);
  const key = [W, H, view.start.toFixed(3), view.end.toFixed(3), res.trades.length, res.plots.length, res.nbars].join('|');
  if (key === lastCanvasKey) return;
  lastCanvasKey = key;
  cv.width = W; cv.height = H;
  cv.style.height = H + 'px';
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const padR = 64, padT = 8, padB = 18;
  const cw = W - padR;
  const span = Math.max(0.0001, view.end - view.start);
  const i0 = Math.max(0, Math.floor(view.start));
  const i1 = Math.min(n - 1, Math.ceil(view.end));
  const candleH = overlay ? H - padB : chartH;
  // price range over visible bars (+ visible overlay plots)
  let lo = Infinity, hi = -Infinity;
  for (let k = i0; k <= i1; k++) { if (res.l[k] < lo) lo = res.l[k]; if (res.h[k] > hi) hi = res.h[k]; }
  if (overlay && res.plots) {
    for (const p of res.plots) {
      for (let k = Math.max(0, i0); k <= i1; k++) {
        const v = p.values[k];
        if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
    }
  }
  // include entry/TP/SL levels of visible trades in the price range
  if (showLevels && res.trades) {
    for (const t of res.trades) {
      if (t.exitBar == null || t.exitBar < i0 - 1 || t.entryBar > i1 + 1) continue;
      for (const p3 of [t.entryPx, t.sl, t.tp]) {
        if (Number.isFinite(p3)) { if (p3 < lo) lo = p3; if (p3 > hi) hi = p3; }
      }
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) { hi = (lo === hi ? lo + 1 : hi + 1); lo -= 1; }
  const pspan = (hi - lo) || 1;
  lo -= pspan * 0.04; hi += pspan * 0.04;
  // TV-style vertical scaling: price axis drag zooms around the middle
  const mid = (lo + hi) / 2;
  const yLo = mid - ((mid - lo) / priceZoom);
  const yHi = mid + ((hi - mid) / priceZoom);
  const Y = price => padT + (1 - (price - yLo) / (yHi - yLo)) * (candleH - padT - 4);
  const X = bar => ((bar - view.start) / span) * (cw - 2) + 1;
  // grid
  ctx.strokeStyle = '#222'; ctx.lineWidth = 1;
  ctx.font = '12px JetBrains Mono';
  for (let g = 0; g <= 4; g++) {
    const py = padT + g * (candleH - padT - 4) / 4;
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(cw, py); ctx.stroke();
    ctx.fillStyle = '#555';
    const price = yLo + (1 - (py - padT) / (candleH - padT - 4)) * (yHi - yLo);
    ctx.fillText(price.toFixed(2), cw + 4, py + 4);
  }
  // candles (visible only)
  const vis = (i1 - i0) + 1;
  const bw = Math.max(1, (cw / Math.max(1, vis)) * 0.6);
  for (let k = i0; k <= i1; k++) {
    const x = X(k);
    if (x < -bw || x > cw + bw) continue;
    const up = res.c[k] >= res.o[k];
    ctx.strokeStyle = up ? '#32CD32' : '#CE2029';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(x, Y(res.h[k])); ctx.lineTo(x, Y(res.l[k])); ctx.stroke();
    const y1 = Y(Math.max(res.o[k], res.c[k]));
    const y2 = Y(Math.min(res.o[k], res.c[k]));
    ctx.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
  }
  // trade levels: entry (blue solid) + TP (green dashed) + SL (red dashed)
  if (res.trades && showLevels) {
    ctx.lineWidth = 1;
    for (const t of res.trades) {
      if (t.exitBar == null || Number.isNaN(t.exitBar)) continue;
      if (t.exitBar < i0 - 1 || t.entryBar > i1 + 1) continue;
      const x1 = Math.max(0, X(t.entryBar));
      const x2 = Math.min(cw, X(t.exitBar));
      const seg = (price, color, label) => {
        if (!Number.isFinite(price) || price < yLo || price > yHi) return;
        ctx.strokeStyle = color;
        ctx.beginPath(); ctx.moveTo(x1, Y(price)); ctx.lineTo(x2, Y(price)); ctx.stroke();
        if (x2 - x1 > 44) {
          ctx.fillStyle = color;
          ctx.fillText(label + ' ' + price.toFixed(2), Math.min(x1 + 3, cw - 60), Y(price) - 3);
        }
      };
      seg(t.entryPx, '#1E90FF', 'E');
      ctx.setLineDash([5, 3]);
      seg(t.tp, '#32CD32', 'TP');
      seg(t.sl, '#CE2029', 'SL');
      ctx.setLineDash([]);
    }
  }
  // hlines
  if (res.hlines) {
    for (const hl of res.hlines) {
      if (!Number.isFinite(hl.price)) continue;
      if (hl.price < yLo || hl.price > yHi) continue;
      ctx.strokeStyle = COLORS[hl.colorId || 4] + '66';
      ctx.beginPath(); ctx.moveTo(0, Y(hl.price)); ctx.lineTo(cw, Y(hl.price)); ctx.stroke();
    }
  }
  // plots
  if (res.plots) {
    for (const p of res.plots) {
      const vals = p.values;
      let mn = Infinity, mx = -Infinity;
      for (const q of vals) { if (q === q) { if (q < mn) mn = q; if (q > mx) mx = q; } }
      if (!Number.isFinite(mn) || mx === mn) { mx = mn + 1; mn -= 0.5; }
      const inMain = overlay;
      const yOf = v => inMain ? Y(v) : chartH + 12 + (1 - (v - mn) / (mx - mn)) * (subH - 18);
      ctx.strokeStyle = COLORS[p.colorId] || COLORS[1];
      ctx.beginPath();
      let started = false;
      const k0 = Math.max(0, i0 - 1);
      for (let k = k0; k <= i1; k++) {
        const v = vals[k];
        if (v !== v) { started = false; continue; }
        const x = X(k), y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (!inMain) {
        ctx.fillStyle = '#555';
        ctx.fillText(p.title + ': ' + (Number.isFinite(vals[i1]) ? vals[i1].toFixed(2) : '-'), 6, chartH + 12);
      }
    }
  }
  // shapes
  if (res.shapes) {
    ctx.fillStyle = '#1E90FF';
    for (const bar of res.shapes) {
      if (bar < i0 || bar > i1) continue;
      const x = X(bar);
      const y = Y(res.c[bar]) + 10;
      ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x - 4, y + 3); ctx.lineTo(x + 4, y + 3); ctx.closePath(); ctx.fill();
    }
  }
  // trades
  if (res.trades) {
    for (const t of res.trades) {
      const ent = t.dir > 0;
      if (t.entryBar >= i0 - 1 && t.entryBar <= i1 + 1) {
        const x = X(t.entryBar), y = Y(t.entryPx);
        ctx.fillStyle = ent ? '#32CD32' : '#CE2029';
        ctx.beginPath();
        if (ent) { ctx.moveTo(x, y - 8); ctx.lineTo(x - 5, y + 1); ctx.lineTo(x + 5, y + 1); }
        else { ctx.moveTo(x, y + 8); ctx.lineTo(x - 5, y - 1); ctx.lineTo(x + 5, y - 1); }
        ctx.closePath(); ctx.fill();
      }
      if (Number.isFinite(t.exitPx) && t.exitBar >= i0 - 1 && t.exitBar <= i1 + 1) {
        const x2 = X(t.exitBar), y2 = Y(t.exitPx);
        ctx.strokeStyle = '#888';
        ctx.beginPath(); ctx.arc(x2, y2, 3.5, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }
  // date labels (visible range)
  ctx.fillStyle = '#555';
  const stepB = Math.max(1, Math.round(span / 6));
  for (let k = Math.ceil(view.start); k <= view.end; k += stepB) {
    if (k < 0 || k >= n) continue;
    const d = new Date(res.t[k] * 1000);
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    ctx.fillText(label, X(k) - 12, H - 3);
  }
  const gl = $('goLive');
  if (gl) gl.classList.toggle('hidden', view.end >= n - 1.5);
}

/* zoom + pan interactions (TradingView-style) */
function setupChartInteractions() {
  const cv = $('chart');
  const nOf = () => (lastRes ? lastRes.c.length : 0);

  const zoomTime = (frac, factor, pinRight) => {
    const n = nOf();
    const span1 = Math.min(Math.max((view.end - view.start) * factor, 2), n - 1);
    if (pinRight) {
      // TV behavior: pinned at the latest bar - right edge stays put while zooming
      view.end = n - 1;
      view.start = Math.max(0, view.end - span1);
    } else {
      const barA = view.start + frac * (view.end - view.start);
      view.start = barA - frac * span1;
      view.end = view.start + span1;
    }
    clampView(n);
    drawChart(lastRes);
  };

  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!lastRes) return;
    const n = nOf();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // shift+wheel or trackpad horizontal: pan
      const dBar = (e.deltaX || e.deltaY) / 5;
      view.start += dBar; view.end += dBar;
      clampView(n);
      drawChart(lastRes);
      return;
    }
    const rect = cv.getBoundingClientRect();
    const ax = e.clientX - rect.left;
    const frac = Math.min(1, Math.max(0, (ax - 1) / chartCW()));
    const factor = Math.pow(1.25, e.deltaY / 100);
    const pinned = view.end >= n - 1.5;
    zoomTime(frac, factor, pinned);
  }, { passive: false });

  let drag = null;
  cv.addEventListener('mousedown', (e) => {
    if (!lastRes) return;
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    drag = null;
    if (x > cv.width - 64) drag = { kind: 'price', y0: y, k0: priceZoom };
    else if (y > cv.height - 18 && x <= cv.width - 64) drag = { kind: 'time', x0: x, s0: view.end - view.start, frac: Math.min(1, Math.max(0, (x - 1) / chartCW())) };
    else drag = { kind: 'pan', x0: x, s0: view.start, e0: view.end };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag || !lastRes) return;
    const n = nOf();
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (drag.kind === 'pan') {
      const dBar = -(x - drag.x0) / Math.max(1, chartCW()) * (drag.e0 - drag.s0);
      view.start = drag.s0 + dBar;
      view.end = drag.e0 + dBar;
      clampView(n);
      drawChart(lastRes);
    } else if (drag.kind === 'price') {
      priceZoom = Math.min(8, Math.max(0.2, drag.k0 * Math.exp((y - drag.y0) / 60.0)));
      lastCanvasKey = '';
      drawChart(lastRes);
    } else if (drag.kind === 'time') {
      // drag time axis: right = zoom out, left = zoom in (TV-like)
      const span1 = Math.min(Math.max(drag.s0 * Math.exp((x - drag.x0) / 200.0), 2), n - 1);
      const barA = view.start + drag.frac * (view.end - view.start);
      view.start = barA - drag.frac * span1;
      view.end = view.start + span1;
      clampView(n);
      drawChart(lastRes);
    }
  });
  window.addEventListener('mouseup', () => { drag = null; });  cv.addEventListener('dblclick', () => {
    if (!lastRes) return;
    viewFit(lastRes.c.length);
    priceZoom = 1;
    lastCanvasKey = '';
    drawChart(lastRes);
  });
  $('goLive').addEventListener('click', () => {
    const n = nOf();
    if (!n || !lastRes) return;
    const keep = view.end - view.start;
    view.end = n - 1;
    view.start = Math.max(0, n - 1 - keep);
    clampView(n);
    lastCanvasKey = '';
    drawChart(lastRes);
  });
  new ResizeObserver(() => { if (lastRes) drawChart(lastRes); }).observe(document.querySelector('.chart-wrap'));
}

/* resizable splitters */
function setupSplitters() {
  const drag = (id, cls, onMove) => {
    const el = $(id);
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.body.classList.add(cls);
      const startY = e.clientY, startX = e.clientX;
      const move = (ev) => onMove({ x: ev.clientX, y: ev.clientY, dx: ev.clientX - startX, dy: ev.clientY - startY });
      const up = () => {
        document.body.classList.remove(cls);
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  };
  drag('vsplit', 'dragging-x', ({ x }) => {
    const main = document.querySelector('.main-h').getBoundingClientRect();
    const w = Math.max(280, Math.min(main.width - 420, x - main.left));
    $('colEditor').style.width = w + 'px';
    if (lastRes) drawChart(lastRes);
  });
  drag('hsplit1', 'dragging-y', ({ y }) => {
    const col = $('colEditor').getBoundingClientRect();
    const h = Math.max(90, Math.min(col.height - 160, col.bottom - y - 30));
    $('console').style.height = h + 'px';
  });
  drag('hsplit2', 'dragging-y', ({ y }) => {
    const wrap = document.querySelector('.chart-wrap').getBoundingClientRect();
    chartH = Math.max(140, Math.min(1400, y - wrap.top - 14));
    lastCanvasKey = '';
    if (lastRes) drawChart(lastRes);
  });
}

/* ---------- run ---------- */
async function doRun() {
  setPill('COMPILING', 'busy');
  try {
    const res = await window.pw.run({ src: editor.value, dataSpec, inputs: lastInputs || {}, metaOverride: (typeof qtyOverride === 'number' ? { default_qty_value: qtyOverride } : null) });
    if (!res.ok) {
      logErrors(res);
      setPill('ERRORS', 'err');
      return;
    }
    lastMeta = res.meta;
    lastInputs = null;
    lastRes = res;
    priceZoom = 1;
    viewFit(res.c.length);
    lastCanvasKey = ''; // force redraw after new run
    renderStats(res);
    drawChart(res);
    renderTrades(res.trades);
    log(`OK wasm=${res.wasmSize ? res.wasmSize : ''}B bars=${res.nbars} compile=${res.compileMs}ms run=${res.runMs}ms net=${res.stats.netProfit.toFixed(2)} trades=${res.stats.trades}`, 'ok');
    const mixC = {};
    for (const t of res.trades) mixC[t.reason] = (mixC[t.reason] || 0) + 1;
    log(`exits: ${Object.entries(mixC).map(([k2, v]) => v + ' ' + k2).join(' / ')}`, 'dim');
    if (res.meta.isStrategy) setPill('WASM READY', 'ok');
    else setPill('INDICATOR RUN', 'ok');
  } catch (ex) {
    log('run failed: ' + ex.message, 'err');
    setPill('ERRORS', 'err');
  }
}

function logErrors(res) {
  for (const e of (res.errs || [])) log(`L${e.line}: ${e.msg}`, 'err');
  for (const w of (res.warns || [])) log(`warn L${w.line}: ${w.msg}`, 'dim');
}

function renderStats(res) {
  const s = res.stats || {};
  const cls = v => v > 0 ? 'pos' : (v < 0 ? 'neg' : '');
  const cells = [
    ['NET', '$' + (s.netProfit ?? 0).toFixed(0), cls(s.netProfit || 0)],
    ['NET %', (s.netProfitPct ?? 0).toFixed(2) + '%', cls(s.netProfitPct || 0)],
    ['PF', (s.profitFactor ?? 0).toFixed(2), ''],
    ['MAX DD', (s.maxDDPct ?? 0).toFixed(1) + '%', 'neg'],
    ['TRADES', s.trades ?? 0, ''],
    ['WIN', ((s.winRate ?? 0) * 100).toFixed(0) + '%', 'acc'],
    ['RUN', (res.runMs ?? 0) + 'ms', ''],
    ['WASM', res.meta && res.meta.isStrategy ? 'STRAT' : 'IND', 'acc'],
  ];
  $('stats').innerHTML = cells.map(([l, v, c]) =>
    `<div class="stat ${c}"><div class="sv">${v}</div><div class="sl">${l}</div></div>`).join('');
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear() - 2000}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function renderTrades(trades) {
  const t = $('trades');
  let html = '<tr><th>DIR</th><th>ENTRY</th><th>PX</th><th>SL</th><th>TP</th><th>EXIT</th><th>PX</th><th>PNL</th><th>WHY</th></tr>';
  for (const tr of trades.slice(-200).reverse()) {
    const g = tr.pnl > 0 ? 'g' : 'r';
    html += `<tr><td class="${g}">${tr.dir > 0 ? 'LONG' : 'SHORT'}</td><td class="d">${fmtTime(tr.entryTime)}</td><td>${tr.entryPx.toFixed(2)}</td><td class="r">${Number.isFinite(tr.sl) ? tr.sl.toFixed(2) : '-'}</td><td class="g">${Number.isFinite(tr.tp) ? tr.tp.toFixed(2) : '-'}</td><td class="d">${Number.isFinite(tr.exitTime) ? fmtTime(tr.exitTime) : '-'}</td><td>${Number.isFinite(tr.exitPx) ? tr.exitPx.toFixed(2) : '-'}</td><td class="${g}">$${tr.pnl.toFixed(2)}</td><td class="d">${tr.reason || ''}</td></tr>`;
  }
  t.innerHTML = html;
}

/* ---------- compile on type (debounced quick compile for errors) ---------- */
let compileTimer = null;
editor.addEventListener('input', () => {
  clearTimeout(compileTimer);
  compileTimer = setTimeout(async () => {
    const res = await window.pw.compile(editor.value);
    if (res.ok) setPill('WASM READY', 'ok');
  }, 900);
});

/* ---------- sweep ---------- */
$('btnSweep').onclick = async () => {
  const res = await window.pw.compile(editor.value);
  if (!res.ok) { logErrors(res); return; }
  const numeric = (res.inputs || []).filter(i => i.type === 'int' || i.type === 'float');
  const sel = $('sweepInput');
  sel.innerHTML = numeric.map(i => `<option value="${i.title}">${i.title}</option>`).join('');
  $('sweepPanel').classList.remove('hidden');
  setPill('SWEEP PICK INPUT', 'busy');
};
$('btnSweepClose').onclick = () => $('sweepPanel').classList.add('hidden');
$('btnSweepRun').onclick = async () => {
  const name = $('sweepInput').value;
  if (!name) return;
  const from = Number($('sweepFrom').value), to = Number($('sweepTo').value), step = Number($('sweepStep').value) || 1;
  const values = [];
  for (let v = from; v <= to + 1e-9; v += step) values.push(Math.round(v * 1e6) / 1e6);
  setPill(`SWEEPING ${values.length} RUNS`, 'busy');
  const t0 = performance.now();
  const res = await window.pw.sweep({ src: editor.value, dataSpec, inputs: {}, name, values });
  if (!res.ok) { logErrors(res); setPill('ERRORS', 'err'); return; }
  const ms = (performance.now() - t0).toFixed(0);
  $('sweepHead').style.display = '';
  $('sweepWrap').style.display = '';
  switchTab('sweep');
  $('sweepName').textContent = `[${name}] ${values.length} runs in ${ms}ms (compile once)`;
  let best = null;
  for (const r of res.rows) if (!best || r.stats.netProfitPct > best.stats.netProfitPct) best = r;
  let html = '<tr><th>VALUE</th><th>NET %</th><th>TRADES</th><th>PF</th><th>MDD %</th></tr>';
  for (const r of res.rows) {
    const isBest = r === best;
    html += `<tr${isBest ? ' class="best"' : ''}><td>${r.value}</td><td>${r.stats.netProfitPct.toFixed(2)}</td><td>${r.stats.trades}</td><td>${r.stats.profitFactor.toFixed(2)}</td><td>${r.stats.maxDDPct.toFixed(1)}</td></tr>`;
  }
  $('sweepTbl').innerHTML = html;
  setPill('SWEEP DONE', 'ok');
};

/* ---------- panels + quant chat ---------- */
function switchTab(t) {
  const map = { trades: ['paneTrades', 'tabBtnTrades'], sweep: ['paneSweep', 'tabBtnSweep'], quant: ['paneQuant', 'tabBtnQuant'] };
  for (const key of Object.keys(map)) {
    $(map[key][0]).classList.toggle('hidden', key !== t);
    $(map[key][1]).classList.toggle('on', key === t);
  }
}
document.querySelectorAll('.qtab').forEach(b => { b.onclick = () => switchTab(b.dataset.t); });

let qtyOverride = null;
let pendingApply = null;
function chatMsg(role, text, withApply) {
  const log = $('chatLog');
  const d = document.createElement('div');
  d.className = 'chat-m ' + (role === 'quant' ? 'q' : 'you');
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = role === 'quant' ? 'QUANT:' : 'YOU:';
  const txt = document.createElement('div');
  txt.className = 'txt';
  txt.textContent = text;
  d.appendChild(who);
  d.appendChild(txt);
  if (withApply) {
    const row = document.createElement('div');
    row.className = 'applyRow';
    const btn = document.createElement('button');
    btn.className = 'btn btn-green';
    btn.textContent = 'APPLY';
    btn.onclick = () => {
      if (!pendingApply) return;
      lastInputs = Object.assign({}, pendingApply.inputs);
      qtyOverride = typeof pendingApply.qty === 'number' ? pendingApply.qty : null;
      const kv = Object.entries(lastInputs).map(([k2, v]) => k2 + '=' + v).join(', ');
      chatMsg('you', 'applied ' + (kv ? kv : 'signal inputs unchanged') + (qtyOverride != null ? ' | sizing ' + qtyOverride + '%' : ''));
      showPage('compiler');
      doRun();
    };
    row.appendChild(btn);
    d.appendChild(row);
  }
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

async function quantSend(text) {
  text = (text || '').trim();
  if (!text) return;
  chatMsg('you', text);
  $('chatInput').value = '';
  setPill('QUANT THINKING', 'busy');
  switchTab('quant');
  const res = await window.pw.quantChat({ src: editor.value, dataSpec, message: text });
  pendingApply = res.apply || null;
  chatMsg('quant', res.reply, !!pendingApply);
  if (res.reply.indexOf('HIT:') === 0 || res.reply.indexOf('\nHIT:') >= 0) setPill('TARGET HIT', 'ok');
  else if (res.reply.indexOf('CLOSEST:') >= 0) setPill('TARGET MISSED', 'err');
  else setPill('QUANT READY', 'ok');
}
$('chatSend').onclick = () => quantSend($('chatInput').value);
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') quantSend($('chatInput').value); });
document.querySelectorAll('.chip').forEach(c => { c.onclick = () => quantSend(c.dataset.msg); });

/* ---------- bot builder ---------- */
$('btnBuildBot').onclick = async () => {
  setPill('BUILDING BOT', 'busy');
  const name = (lastMeta && lastMeta.title) || 'bot';
  const res = await window.pw.genbot({ src: editor.value, botName: name });
  if (!res.ok) { logErrors(res); setPill('ERRORS', 'err'); return; }
  $('botCode').textContent = res.code;
  window.lastBotDir = res.dir;
  $('botMeta').textContent = `${res.meta.title} - ${res.meta.isStrategy ? 'strategy' : 'indicator'} - saved to ${res.dir}`;
  $('botInputs').textContent = res.inputs.map(i => `${i.name}: ${JSON.stringify(i.def)}`).join('\n');
  $('btnOpenBot').disabled = false;
  setPill('BOT BUILT', 'ok');
};
$('btnOpenBot').onclick = async () => {
  if (window.lastBotDir) window.pw.openPath(window.lastBotDir);
};

/* ---------- pages & menu ---------- */
const PAGES = ['compiler', 'bot', 'data'];
function showPage(name) {
  for (const p of PAGES) $('page-' + p).classList.add('hidden');
  $('page-' + name).classList.remove('hidden');
  $('pageLabel').textContent = name.toUpperCase();
}
$('menuBtn').onclick = () => $('menuDrop').classList.toggle('hidden');
document.addEventListener('click', (e) => {
  if (!$('menuDrop').contains(e.target) && e.target !== $('menuBtn')) $('menuDrop').classList.add('hidden');
});
$('menuDrop').addEventListener('click', async (e) => {
  const act = e.target.dataset && e.target.dataset.act;
  if (!act) return;
  $('menuDrop').classList.add('hidden');
  if (act === 'page-compiler') return showPage('compiler');
  if (act === 'page-bot') return showPage('bot');
  if (act === 'page-data') return showPage('data');
  if (act === 'open-pine') {
    const f = await window.pw.readFile('pine');
    if (f) { editor.value = f.text; syncGutter(); showPage('compiler'); doRun(); }
    return;
  }
  if (act === 'open-csv') {
    const f = await window.pw.readFile('csv');
    if (f) {
      dataSpec = { source: 'csv', path: f.path };
      const lines = f.text.split(/\r?\n/).filter(l => l.trim()).length;
      lastDataLabel = f.path.split(/[\\/]/).pop().toUpperCase() + ` ${lines} ROWS`;
      $('dataLabel').textContent = 'DATA: ' + lastDataLabel;
      showPage('compiler'); doRun();
    }
    return;
  }
  if (act === 'fetch-okx') { showPage('data'); return; }
  if (act === 'export-wasm') {
    await window.pw.exportWasm(editor.value);
    return;
  }
  if (act === 'github') { /* no-op offline */ }
});

$('btnRun').onclick = doRun;
$('btnCsv').onclick = async () => {
  const f = await window.pw.readFile('csv');
  if (f) {
    dataSpec = { source: 'csv', path: f.path };
    const lines = f.text.split(/\r?\n/).filter(l => l.trim()).length;
    $('dataLabel').textContent = 'DATA: ' + f.path.split(/[\\/]/).pop().toUpperCase() + ` ${lines} ROWS`;
    showPage('compiler'); doRun();
  }
};
$('btnOkx').onclick = async () => {
  const symbol = $('okxSymbol').value || 'BTC-USDT-SWAP';
  const bar = $('okxTf').value;
  const limit = Number($('okxLimit').value) || 300;
  setPill('FETCHING ' + symbol, 'busy');
  const res = await window.pw.fetchKlines({ symbol, bar, limit });
  if (!res.ok) { logErrors({ errs: res.errs }); setPill('ERRORS', 'err'); return; }
  dataSpec = { source: 'okx', data: res.data };
  $('dataLabel').textContent = `DATA: OKX ${symbol} ${bar} ${res.data.C.length} BARS`;
  showPage('compiler'); doRun();
};
$('btnSample').onclick = () => {
  dataSpec = { source: 'sample', n: 3000 };
  $('dataLabel').textContent = 'DATA: SAMPLE 3000 BARS';
  showPage('compiler'); doRun();
};

/* showLevels toggle */
$('btnLevels').onclick = () => {
  showLevels = !showLevels;
  $('btnLevels').textContent = 'LEVELS: ' + (showLevels ? 'ON' : 'OFF');
  lastCanvasKey = '';
  if (lastRes) drawChart(lastRes);
};

/* ---------- boot ---------- */
setupChartInteractions();
setupSplitters();
chatMsg('quant', 'QUANT online. Give me a target and I tune inputs + position size to hit it, verifying every candidate against the WASM backtest.\nExamples:\n  max drawdown 5%\n  max dd 10% with at least 20 trades\n  stats');
editor.value = SAMPLE;
syncGutter();
setPill('ENGINE IDLE');
log('PineWASM Desktop v0.1. Paste a Pine Script strategy, press RUN.', 'dim');
doRun();
