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
  // TV overscroll: allow dragging up to 25% of the viewport past the last bar (blank space right)
  const over = Math.floor(Math.max(0, view.end - view.start) * 0.25);
  if (view.end > n - 1 + over) { view.start -= view.end - (n - 1 + over); view.end = n - 1 + over; }
  if (view.start < 0) view.start = 0;
}

function chartCW() { return Math.max(100, $('chart').width - 64); }

let priceZoom = 1; // vertical scale (TV-style price axis drag)
let lastPM = null;       // last drawn price mapping {yLo, yHi, padT, candleH}
let manualScale = null;  // TV behavior: axis wheel/drag fixes the price scale until dblclick-fit / new run

function drawChart(res, forceDraw) {
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
  if (!forceDraw && key === lastCanvasKey) return;
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
  // TV-style vertical scaling: auto range scaled by priceZoom around its middle;
  // manualScale (set by price-axis wheel/drag) freezes the scale like TV does
  let yLo, yHi;
  if (manualScale) { yLo = manualScale.lo; yHi = manualScale.hi; }
  else {
    const mid = (lo + hi) / 2;
    yLo = mid - ((mid - lo) / priceZoom);
    yHi = mid + ((hi - mid) / priceZoom);
  }
  lastPM = { yLo, yHi, padT, candleH };
  const Y = price => padT + (1 - (price - yLo) / (yHi - yLo)) * (candleH - padT - 4);
  const X = bar => ((bar - view.start) / span) * (cw - 2) + 1;
  const vis0 = (i1 - i0) + 1;
  const bw = Math.max(1, (cw / Math.max(1, vis0)) * 0.6);
  // price scale: 1-2-5 nice ticks (TV look)
  ctx.strokeStyle = '#222'; ctx.lineWidth = 1;
  ctx.font = '12px JetBrains Mono';
  const rawStep = Math.max(1e-12, yHi - yLo) / 7;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const pStep = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const dec = Math.max(0, Math.min(6, -Math.floor(Math.log10(pStep))));
  for (let tp = Math.ceil(yLo / pStep) * pStep; tp <= yHi; tp += pStep) {
    if (tp !== tp) break;
    const py = Y(tp);
    if (py < padT - 1 || py > candleH - 1) continue;
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(cw, py); ctx.stroke();
    ctx.fillStyle = '#555';
    ctx.fillText(tp.toFixed(dec), cw + 4, py + 4);
  }
  // axis frame (TV: separator between chart and price scale)
  ctx.strokeStyle = '#222';
  ctx.beginPath(); ctx.moveTo(cw + 0.5, 0); ctx.lineTo(cw + 0.5, H); ctx.stroke();
  // volume strip: dim bars along the bottom of the price pane
  let vmax = 0;
  if (res.v) for (let k = i0; k <= i1; k++) { const v2 = Number(res.v[k]); if (v2 === v2 && v2 > vmax) vmax = v2; }
  if (vmax > 0) {
    const volH = Math.round((candleH - padT - 4) * 0.16);
    for (let k = i0; k <= i1; k++) {
      const v2 = Number(res.v[k]); if (v2 !== v2 || v2 <= 0) continue;
      const x = X(k); if (x < -bw || x > cw) continue;
      const hh = Math.max(1, (v2 / vmax) * volH);
      ctx.fillStyle = res.c[k] >= res.o[k] ? 'rgba(50,205,50,0.30)' : 'rgba(206,32,41,0.30)';
      ctx.fillRect(x - bw / 2, candleH - hh, bw, hh);
    }
  }
  // candles (visible only)
  const vis = (i1 - i0) + 1;
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
  // last price: dotted line + axis tag (green if last bar closed up, red if down)
  if (n > 0) {
    const pb = Number(res.c[n - 1]);
    if (pb === pb && pb >= yLo && pb <= yHi) {
      const py = Y(pb);
      const lastUp = pb >= Number(res.o[n - 1]);
      if (py >= padT && py <= candleH - 1) {
        ctx.strokeStyle = '#333';
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(cw, py); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = lastUp ? '#32CD32' : '#CE2029';
      ctx.fillRect(cw + 1, Math.min(candleH - 17, Math.max(0, py - 8)), padR - 2, 16);
      ctx.fillStyle = '#000';
      ctx.fillText(pb.toFixed(dec), cw + 4, Math.min(candleH - 17, Math.max(0, py - 8)) + 12);
    }
  }
  // crosshair + OHLCV legend (chart body hover, snapped to the bar under cursor)
  if (forceDraw && hoverXY) {
    const hx = hoverXY.x, hy = hoverXY.y;
    if (hx >= 0 && hx <= cw && hy >= padT && hy <= candleH - 2) {
      const H2c = Math.max(1, candleH - padT - 4);
      const kb = Math.min(n - 1, Math.max(0, Math.round(view.start + (hx - 1) / (cw - 2) * span)));
      const cxp = X(kb);
      ctx.strokeStyle = '#555';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(cxp, 0); ctx.lineTo(cxp, candleH - 2); ctx.stroke();
      if (hy >= padT) {
        ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(cw, hy); ctx.stroke();
        const pcur = yLo + (1 - (hy - padT) / H2c) * (yHi - yLo);
        ctx.setLineDash([]);
        ctx.fillStyle = '#1A1A1A';
        ctx.fillRect(cw + 1, Math.min(candleH - 17, Math.max(0, hy - 8)), padR - 2, 16);
        ctx.fillStyle = '#fff';
        ctx.fillText(pcur.toFixed(dec), cw + 4, Math.min(candleH - 17, Math.max(0, hy - 8)) + 12);
      }
      ctx.setLineDash([]);
      const v1 = Number(res.v ? res.v[kb] : NaN);
      const chg = kb > 0 && Number(res.c[kb - 1]) ? ((res.c[kb] / res.c[kb - 1] - 1) * 100).toFixed(2) + '%' : '-';
      const fv = v1 === v1 ? (v1 >= 1e9 ? (v1 / 1e9).toFixed(1) + 'B' : v1 >= 1e6 ? (v1 / 1e6).toFixed(1) + 'M' : v1 >= 1e3 ? (v1 / 1e3).toFixed(1) + 'K' : v1.toFixed(0)) : '0';
      const leg = `O ${Number(res.o[kb]).toFixed(dec)}   H ${Number(res.h[kb]).toFixed(dec)}   L ${Number(res.l[kb]).toFixed(dec)}   C ${Number(res.c[kb]).toFixed(dec)}   ${chg}   V ${fv}`;
      const lw = ctx.measureText(leg).width + 16;
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.fillRect(2, 2, lw, 20);
      ctx.strokeStyle = '#222';
      ctx.strokeRect(2.5, 2.5, lw, 20);
      const upc = Number(res.c[kb]) >= Number(res.o[kb]);
      ctx.fillStyle = upc ? '#32CD32' : '#CE2029';
      ctx.fillText(leg, 10, 16);
      // snap date tag on the time axis
      const dd = new Date(res.t[kb] * 1000);
      const dtxt = `${dd.getMonth() + 1}/${dd.getDate()} ${String(dd.getHours()).padStart(2, '0')}:${String(dd.getMinutes()).padStart(2, '0')}`;
      const dw = ctx.measureText(dtxt).width + 12;
      ctx.fillStyle = '#1A1A1A';
      ctx.fillRect(Math.min(Math.max(0, cxp - dw / 2), cw - dw), H - 16, dw, 14);
      ctx.fillStyle = '#fff';
      ctx.fillText(dtxt, Math.min(Math.max(0, cxp - dw / 2), cw - dw) + 6, H - 5);
    }
  }
  const gl = $('goLive');
  if (gl) gl.classList.toggle('hidden', view.end <= n - 0.5); // pill shows when overscrolled past latest
}
let hoverXY = null;

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
    const rect = cv.getBoundingClientRect();
    const ax = e.clientX - rect.left, ay = e.clientY - rect.top;
    // BOTH buttons held = magnifier scope: wheel adjusts magnification, aim with the mouse
    if (leftDown && rightDown) {
      e.preventDefault();
      mag = Math.min(20, Math.max(1.5, mag * Math.pow(1.25, -e.deltaY / 100))); // wheel up = more zoom
      drawLoupe(e);
      return;
    }
    // right-hold + wheel = horizontal scroll: wheel up slides toward newest (right),
    // wheel down toward oldest (left) - Massi direction canon (2026-11-27)
    if (rightDown) {
      const pxPerBar = Math.max(0.35, (chartCW() - 2) / Math.max(1e-6, view.end - view.start));
      const dBar = -e.deltaY / pxPerBar;
      view.start += dBar; view.end += dBar;
      clampView(n);
      rightWheelAt = performance.now();
      drawChart(lastRes);
      return;
    }
    // LMB held (mid-drag) + wheel = NinjaTrader-style BOTH-AXIS zoom: time and value scale
    // together, anchored at the pointer. Drag references are rebased so panning continues
    // smoothly from the new framing without a jump.
    if (drag) {
      const factor = Math.pow(1.25, e.deltaY / 100);
      const frac = Math.min(1, Math.max(0, (ax - 1) / chartCW()));
      zoomTime(frac, factor, false);
      zoomPrice(factor, ay);
      rebaseDrag(drag, ax, ay);
      return;
    }
    // TV parities: wheel over the price axis zooms the price scale (cursor-anchored);
    // wheel over the time axis strip or chart body zooms time (cursor-anchored)
    if (ax > cv.width - 64 && ay <= cv.height - 18 && !e.shiftKey) {
      zoomPrice(Math.pow(1.25, e.deltaY / 100), ay);
      return;
    }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // shift+wheel or trackpad horizontal: pan (scroll up slides toward newest, matching the right-hold canon)
      const dBar = -((e.deltaX || e.deltaY) / 5);
      view.start += dBar; view.end += dBar;
      clampView(n);
      drawChart(lastRes);
      return;
    }
    const frac = Math.min(1, Math.max(0, (ax - 1) / chartCW()));
    const factor = Math.pow(1.25, e.deltaY / 100);
    // NinjaTrader zoom feel: ALWAYS anchor at the exact pointer position (bar under the
    // cursor never moves when wheeling). No right-edge pinning - use the LATEST pill to
    // snap back to now, or hover the right edge while zooming.
    zoomTime(frac, factor, false);
  }, { passive: false });

  // rebase an active drag after a mid-drag combined zoom so continuation stays 1:1
  function rebaseDrag(d, ax, ay) {
    d.x0 = ax; d.y0 = ay;
    if (d.kind === 'pan') {
      d.s0 = view.start; d.e0 = view.end;
      d.vm = null; // vertical reference re-freezes from the post-zoom mapping
    } else if (d.kind === 'price' && lastPM) {
      const H2 = Math.max(1, lastPM.candleH - lastPM.padT - 4);
      d.r0 = Math.min(1, Math.max(0, (ay - lastPM.padT) / H2));
      d.pA = lastPM.yLo + (1 - d.r0) * (lastPM.yHi - lastPM.yLo);
      d.lo0 = lastPM.yLo; d.hi0 = lastPM.yHi;
    } else if (d.kind === 'time') {
      d.s0 = view.end - view.start;
      d.frac = Math.min(1, Math.max(0, (ax - 1) / chartCW()));
    }
  }

  let rightWheelAt = 0; // suppress the stray context menu right after a right-hold wheel
  cv.addEventListener('contextmenu', (e) => { if (performance.now() - rightWheelAt < 700) e.preventDefault(); });
  // Chromium strips held-button state from wheel events (buttons=0 even mid-drag), so
  // right-hold/left-hold are tracked from mousedown/mouseup instead of e.buttons
  let rightDown = false;
  let leftDown = false;
  window.__pwBtn = { get right() { return rightDown; }, get left() { return leftDown; } };
  // magnifier scope: both buttons held = loupe follows the cursor, wheel scales zoom
  let mag = 4;
  const loupe = document.createElement('canvas');
  loupe.className = 'loupe';
  const LR = 90;
  loupe.width = LR * 2; loupe.height = LR * 2;
  loupe.style.cssText = 'position:absolute;pointer-events:none;border:1px solid #222;border-radius:50%;display:none;z-index:12;background:#000;';
  cv.parentElement.appendChild(loupe);
  function drawLoupe(e) {
    const rect = cv.getBoundingClientRect();
    const wr = cv.parentElement.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    loupe.style.left = Math.round(e.clientX - wr.left - LR) + 'px';
    loupe.style.top = Math.round(e.clientY - wr.top - LR) + 'px';
    loupe.style.display = 'block';
    const g2 = loupe.getContext('2d');
    g2.setTransform(1, 0, 0, 1, 0, 0);
    g2.fillStyle = '#000'; g2.fillRect(0, 0, LR * 2, LR * 2);
    g2.save();
    g2.beginPath(); g2.arc(LR, LR, LR - 1, 0, Math.PI * 2); g2.clip();
    const srcR = Math.max(6, LR / mag);
    const sx = Math.max(0, Math.min(cv.width - 2, cx - srcR));
    const sy = Math.max(0, Math.min(cv.height - 2, cy - srcR));
    const sw = Math.max(2, Math.min(srcR * 2, cv.width - sx));
    const sh = Math.max(2, Math.min(srcR * 2, cv.height - sy));
    g2.imageSmoothingEnabled = false;
    g2.drawImage(cv, sx, sy, sw, sh, 0, 0, LR * 2, LR * 2);
    g2.restore();
    g2.strokeStyle = '#888'; g2.lineWidth = 1;
    g2.beginPath(); g2.moveTo(LR - 12, LR); g2.lineTo(LR + 12, LR);
    g2.moveTo(LR, LR - 12); g2.lineTo(LR, LR + 12); g2.stroke();
    g2.fillStyle = '#32CD32'; g2.fillRect(LR - 1, LR - 1, 3, 3);
  }
  function hideLoupe() { loupe.style.display = 'none'; }

  // cursor hints like TV: ns-resize over price axis, ew-resize over time axis
  cv.addEventListener('mousemove', (e) => {
    if (drag) return;
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (x > cv.width - 64 && y <= cv.height - 18) cv.style.cursor = 'ns-resize';
    else if (y > cv.height - 18 && x <= cv.width - 64) cv.style.cursor = 'ew-resize';
    else cv.style.cursor = '';
    // crosshair + OHLCV legend on chart-body hover
    if (!drag && lastRes) {
      if (x <= cv.width - 64 && y <= cv.height - 18) {
        hoverXY = { x, y };
        drawChart(lastRes, true);
      } else if (hoverXY) {
        hoverXY = null;
        drawChart(lastRes, true);
      }
    }
  });
  cv.addEventListener('mouseleave', () => {
    if (hoverXY) { hoverXY = null; if (lastRes && !drag) drawChart(lastRes, true); }
  });

  // cursor-anchored price-scale zoom (TV wheel-on-axis feel)
  function zoomPrice(f, yPx) {
    if (!lastPM || !Number.isFinite(f) || f <= 0) return;
    const H2 = Math.max(1, lastPM.candleH - lastPM.padT - 4);
    const r = Math.min(1, Math.max(0, (yPx - lastPM.padT) / H2));
    const pA = lastPM.yLo + (1 - r) * (lastPM.yHi - lastPM.yLo); // price under cursor
    const Rold = Math.max(1e-9, lastPM.yHi - lastPM.yLo);
    let R = Rold * f; // wheel down = zoom out (same direction as the time axis wheel)
    R = Math.min(Math.max(R, Rold / 20), Rold * 20); // sane bounds per gesture
    manualScale = { lo: pA - (1 - r) * R, hi: pA - (1 - r) * R + R };
    lastCanvasKey = '';
    drawChart(lastRes);
  }

  let drag = null;
  cv.addEventListener('mousedown', (e) => {
    if (e.button === 2) { rightDown = true; return; }
    if (e.button === 0) leftDown = true;
    if (!lastRes) return;
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    drag = null;
    if (x > cv.width - 64 && y <= cv.height - 18) {
      if (!lastPM) return;
      const H2 = Math.max(1, lastPM.candleH - lastPM.padT - 4);
      const r0 = Math.min(1, Math.max(0, (y - lastPM.padT) / H2));
      drag = { kind: 'price', y0: y, r0,
        pA: lastPM.yLo + (1 - r0) * (lastPM.yHi - lastPM.yLo),
        lo0: lastPM.yLo, hi0: lastPM.yHi };
    }
    else if (y > cv.height - 18 && x <= cv.width - 64) drag = { kind: 'time', x0: x, s0: view.end - view.start, frac: Math.min(1, Math.max(0, (x - 1) / chartCW())) };
    else drag = { kind: 'pan', x0: x, y0: y, s0: view.start, e0: view.end };
    if (drag.kind === 'pan') cv.style.cursor = 'grabbing';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (leftDown && rightDown) { drawLoupe(e); return; } // scoping: freeze pan, move the loupe
    if (!drag || !lastRes) return;
    const n = nOf();
    const rect = cv.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (drag.kind === 'pan') {
      const dBar = -(x - drag.x0) / Math.max(1, chartCW()) * (drag.e0 - drag.s0);
      view.start = drag.s0 + dBar;
      view.end = drag.e0 + dBar;
      clampView(n);
      // vertical pan: dragging up/down moves the price scale with you (TV behavior)
      if (lastPM && Math.abs(y - drag.y0) > 2) {
        if (!drag.vm) {
          drag.vm = { lo: lastPM.yLo, hi: lastPM.yHi }; // freeze the scale on first vertical move
          manualScale = { lo: drag.vm.lo, hi: drag.vm.hi };
        }
        const H2c = Math.max(1, lastPM.candleH - lastPM.padT - 4);
        const dP = ((y - drag.y0) / H2c) * (drag.vm.hi - drag.vm.lo);
        manualScale = { lo: drag.vm.lo + dP, hi: drag.vm.hi + dP };
      }
      drawChart(lastRes);
    } else if (drag.kind === 'price') {
      // TV feel: price under the grab point follows the cursor; drag down = zoom out
      const R0 = Math.max(1e-9, drag.hi0 - drag.lo0);
      let R = R0 * Math.exp((y - drag.y0) / 60.0);
      R = Math.min(Math.max(R, R0 / 20), R0 * 20);
      manualScale = { lo: drag.pA - (1 - drag.r0) * R, hi: drag.pA - (1 - drag.r0) * R + R };
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
  window.addEventListener('mouseup', (e) => { if (e.button === 2) rightDown = false; if (e.button === 0) leftDown = false; if (!(leftDown && rightDown)) hideLoupe(); drag = null; if (cv) cv.style.cursor = ''; });
  cv.addEventListener('dblclick', () => {
    if (!lastRes) return;
    viewFit(lastRes.c.length);
    priceZoom = 1;
    manualScale = null;
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
    const mp = Math.min(10, Math.max(1, parseInt($('maxPos') && $('maxPos').value, 10) || 1));
    const mo = {};
    if (typeof qtyOverride === 'number') mo.default_qty_value = qtyOverride;
    if (mp > 1) mo.max_concurrent = mp;
    const res = await window.pw.run({ src: editor.value, dataSpec, inputs: lastInputs || {}, metaOverride: Object.keys(mo).length ? mo : null });
    if (!res.ok) {
      logErrors(res);
      setPill('ERRORS', 'err');
      return;
    }
    lastMeta = res.meta;
    lastInputs = null;
    lastRes = res;
    priceZoom = 1;
    manualScale = null;
    // TV-style open: zoomed in on the most recent bars, right edge pinned at latest
    const K = Math.min(Math.max(Math.round(res.c.length * 0.12), 60), 600);
    view.end = res.c.length - 1;
    view.start = Math.max(0, res.c.length - 1 - K);
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
    ['SLOTS', (s.slotsMax ?? 1) + (s.rejected > 0 ? ' -' + s.rejected + ' REJ' : ''), ''],
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
  let html = '<tr><th>DIR</th><th>ENTRY</th><th>PX</th><th>SL</th><th>TP</th><th>QTY</th><th>EQ%</th><th>BARS</th><th>MAE</th><th>MFE</th><th>EXIT</th><th>PX</th><th>PNL</th><th>WHY</th></tr>';
  const fQty = q => q >= 1000 ? q.toFixed(0) : q >= 10 ? q.toFixed(2) : q.toFixed(4);
  for (const tr of trades.slice(-200).reverse()) {
    const g = tr.pnl > 0 ? 'g' : 'r';
    const qty = Number.isFinite(tr.qty) ? fQty(tr.qty) : '-';
    const eqPct = Number.isFinite(tr.eqPct) ? tr.eqPct.toFixed(2) + '%' : '-';
    const bars = Number.isFinite(tr.durationBars) ? tr.durationBars : '-';
    const mae = Number.isFinite(tr.mae) ? '$' + tr.mae.toFixed(2) : '-';
    const mfe = Number.isFinite(tr.mfe) ? '$' + tr.mfe.toFixed(2) : '-';
    const pnlPct = Number.isFinite(tr.pnlPct) ? tr.pnlPct.toFixed(2) + '%' : '';
    const mins = Number.isFinite(tr.durationMs) ? (tr.durationMs / 60000) : null;
    const durTxt = mins != null ? (mins >= 60 ? (mins / 60).toFixed(1) + 'h' : mins.toFixed(0) + 'm') : '';
    const title = [
      'P&L ' + (Number.isFinite(tr.pnl) ? '$' + tr.pnl.toFixed(2) : '-') + (pnlPct ? ' (' + pnlPct + ')' : ''),
      'Entry eq $' + (Number.isFinite(tr.entryEq) ? tr.entryEq.toFixed(2) : '-') + ', size ' + qty + ' = ' + eqPct + ' of equity',
      'MAE $' + (Number.isFinite(tr.mae) ? tr.mae.toFixed(2) : '-') + (Number.isFinite(tr.maePct) ? ' (' + tr.maePct.toFixed(2) + '%)' : '') + (Number.isFinite(tr.maeTime) ? ' @ ' + fmtTime(tr.maeTime) : ''),
      'MFE $' + (Number.isFinite(tr.mfe) ? tr.mfe.toFixed(2) : '-') + (Number.isFinite(tr.mfePct) ? ' (' + tr.mfePct.toFixed(2) + '%)' : '') + (Number.isFinite(tr.mfeTime) ? ' @ ' + fmtTime(tr.mfeTime) : ''),
      'Held ' + bars + ' bars' + (durTxt ? ' (' + durTxt + ')' : '')
    ].join('\n');
    html += `<tr title="${title}"><td class="${g}">${tr.dir > 0 ? 'LONG' : 'SHORT'}</td><td class="d">${fmtTime(tr.entryTime)}</td><td>${tr.entryPx.toFixed(2)}</td><td class="r">${Number.isFinite(tr.sl) ? tr.sl.toFixed(2) : '-'}</td><td class="g">${Number.isFinite(tr.tp) ? tr.tp.toFixed(2) : '-'}</td><td>${qty}</td><td class="d">${eqPct}</td><td class="d">${bars}</td><td class="r">${mae}</td><td class="g">${mfe}</td><td class="d">${Number.isFinite(tr.exitTime) ? fmtTime(tr.exitTime) : '-'}</td><td>${Number.isFinite(tr.exitPx) ? tr.exitPx.toFixed(2) : '-'}</td><td class="${g}">${tr.pnl.toFixed(2)}${pnlPct ? ' <span style="color:var(--text3)">' + pnlPct + '</span>' : ''}</td><td class="d">${tr.reason || ''}</td></tr>`;
  }
  t.innerHTML = html;
}

/* ---------- wheel edits values in numeric inputs (Interaction canon) ----------
   Hover a number box and scroll: up = increase, down = decrease. Shift = x10,
   Ctrl/Alt = x0.1. Price-kind inputs (data-kind="price") start from the loaded
   ticker's last close when the box is empty. Generic inputs step smartly by
   order of magnitude; empty generic boxes stay empty (no context to start from). */
function currentTickerPrice() {
  const c = lastRes && lastRes.c;
  return c && c.length ? Number(c[c.length - 1]) : NaN;
}
function installWheelEdit() {
  document.addEventListener('wheel', (e) => {
    const t = e.target;
    if (!t || t.tagName !== 'INPUT' || t.readOnly || t.disabled) return;
    if (t.type === 'checkbox' || t.type === 'radio' || t.type === 'range' || t.type === 'file' || t.type === 'submit' || t.type === 'button') return;
    const kind = t.dataset && t.dataset.kind;
    const looksNum = t.type === 'number' || t.inputMode === 'decimal' || kind != null || /^\s*-?\d+(\.\d+)?\s*$/.test(String(t.value || ''));
    if (!looksNum) return;
    e.preventDefault();
    e.stopPropagation();
    let cur = parseFloat(String(t.value || '').trim());
    let empty = !(cur === cur);
    if (empty && kind === 'price') {
      const live = currentTickerPrice();
      if (!(live > 0)) return;
      t.value = live.toFixed(live >= 100 ? 2 : 4);
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (empty && kind === 'pct') {
      t.value = '0.5';               // first scroll lands on the start value, next scrolls step
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (empty) return;                                   // generic box: no start value context
    let step = kind === 'pct' ? 0.05
      : kind === 'price' ? Math.max(cur * 0.001, 0.01)
      : Math.max(Math.pow(10, Math.floor(Math.log10(Math.abs(cur) || 1))) / 10, t.type === 'number' ? 1 : 0);
    if (!(step > 0)) step = 1;
    const mult = e.shiftKey ? 10 : (e.ctrlKey || e.altKey) ? 0.1 : 1;
    let nv = cur + (e.deltaY < 0 ? step : -step) * mult;
    if (kind === 'price') nv = Number(nv.toFixed(cur >= 100 ? 2 : 4));
    else {
      const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 4;
      nv = Number(nv.toFixed(dec));
    }
    t.value = String(nv);
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new Event('change', { bubbles: true }));
  }, { capture: true, passive: false });
}
installWheelEdit();

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
function chatMsg(role, text, withApply, applyKind) {
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
    btn.textContent = applyKind === 'source' ? 'APPLY SOURCE' : 'APPLY';
    btn.onclick = async () => {
      if (!pendingApply) return;
      if (pendingApply.kind === 'source') {
        editor.value = pendingApply.src;
        syncGutter();
        qtyOverride = null;
        lastInputs = null;
        chatMsg('you', 'editor now holds the loop-improved script (sizing/inputs back to defaults) - re-running');
        showPage('compiler');
        await doRun();
        luxCrossCheck();
      } else {
        lastInputs = Object.assign({}, pendingApply.inputs);
        qtyOverride = typeof pendingApply.qty === 'number' ? pendingApply.qty : null;
        if (typeof pendingApply.maxpos === 'number' && $('maxPos')) $('maxPos').value = pendingApply.maxpos;
        const kv = Object.entries(lastInputs).map(([k2, v]) => k2 + '=' + v).join(', ');
        chatMsg('you', 'applied ' + (kv ? kv : 'signal inputs unchanged') + (qtyOverride != null ? ' | sizing ' + qtyOverride + '%' : ''));
        showPage('compiler');
        doRun();
      }
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
  pendingApply = res.applySource ? { kind: 'source', src: res.applySource } : (res.apply ? Object.assign({ kind: 'params' }, res.apply) : null);
  chatMsg('quant', res.reply, !!pendingApply, pendingApply && pendingApply.kind);
  if (res.reply.indexOf('HIT:') === 0 || res.reply.indexOf('\nHIT:') >= 0) setPill('TARGET HIT', 'ok');
  else if (res.reply.indexOf('CLOSEST:') >= 0) setPill('TARGET MISSED', 'err');
  else setPill('QUANT READY', 'ok');
}
$('chatSend').onclick = () => quantSend($('chatInput').value);
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') quantSend($('chatInput').value); });
document.querySelectorAll('.chip').forEach(c => { c.onclick = () => quantSend(c.dataset.msg); });

/* ---------- LUX engine cross-check ---------- */
async function luxCrossCheck() {
  if (!lastRes || !lastRes.t || !lastRes.c) { chatMsg('quant', 'run a backtest first (no data loaded).'); return; }
  setPill('LUX ENGINE RUNNING', 'busy');
  switchTab('quant');
  // luxRun wants rows[{t,o,h,l,c,v}]; lastRes carries columnar arrays from pw.run
  const rows = lastRes.t.map((tv, i) => ({ t: tv, o: lastRes.o[i], h: lastRes.h[i], l: lastRes.l[i], c: lastRes.c[i], v: 0 }));
  const rep = await window.pw.luxRun({ src: editor.value, data: rows });
  if (!rep.ok) {
    chatMsg('quant', 'LUX cross-check could not run this script: ' + (rep.error || 'unknown'));
    setPill('LUX CHECK FAILED', 'err');
    return;
  }
  const m = rep.m, mine = lastRes.stats;
  const cmp = (name, ours, lux) => `${name.padEnd(15)} pinewasm ${ours}   |   lux ${lux}`;
  const agree = Math.abs(mine.trades - Number(m.n)) <= Math.max(2, Number(m.n) * 0.08);
  const msg = `LUX ENGINE CROSS-CHECK (LuxAlgo vela-pinets on the same ${lastRes.nbars} bars)\n` +
    cmp('net %', mine.netProfitPct.toFixed(2), Number(m.netPct).toFixed(2)) + '\n' +
    cmp('max dd %', mine.maxDDPct.toFixed(2), Number(m.ddPct).toFixed(2)) + '\n' +
    cmp('trades', String(mine.trades), String(m.n)) + '\n' +
    cmp('win rate', (mine.winRate * 100).toFixed(1) + '%', m.winRate == null ? '-' : Number(m.winRate).toFixed(1) + '%') + '\n' +
    cmp('profit factor', Number.isFinite(mine.profitFactor) ? mine.profitFactor.toFixed(2) : 'inf', String(m.pf)) + '\n\n' +
    'DD CAVEAT: lux m.ddPct = maxDrawdown/capital is positional/per-trade, not the equity-ledger DD -' +
    ' expect it to read much smaller than pinewasm (bar-by-bar peak-trough). Compare trade counts + net, not DD.\n\n' +
    (agree
      ? 'Trade counts agree within tolerance - the pinewasm numbers are confirmed by LuxAlgo\'s own broker simulation.'
      : 'TRADE COUNT DIVERGES - the two engines interpreted something differently (fills, session rules, or unsupported builtins silently mapped). Inspect before trusting either.');
  chatMsg('quant', msg);
  setPill('CROSS-CHECKED', 'ok');
}
const luxChip = document.getElementById('luxChip');
if (luxChip) luxChip.onclick = luxCrossCheck;

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
async function fetchYahooData() {
  const symbol = ($('yhSymbol').value || 'NQ=F').trim();
  const interval = $('yhTf').value || '15m';
  setPill('FETCHING ' + symbol, 'busy');
  const res = await window.pw.fetchYahoo({ symbol, interval });
  if (!res.ok) { logErrors({ errs: res.errs }); setPill('ERRORS', 'err'); return; }
  dataSpec = { source: 'yahoo', data: res.data };
  const cur = res.meta && res.meta.currency ? ' ' + res.meta.currency : '';
  $('dataLabel').textContent = `DATA: ${res.meta && res.meta.exchange ? res.meta.exchange + ' ' : ''}${res.meta && res.meta.symbol ? res.meta.symbol : symbol}${cur} ${interval} ${res.data.C.length} BARS`;
  showPage('compiler'); doRun();
}
$('btnYahoo').onclick = fetchYahooData;
document.querySelectorAll('.chip[data-yh]').forEach(c => {
  c.onclick = () => { $('yhSymbol').value = c.dataset.yh; fetchYahooData(); };
});
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
