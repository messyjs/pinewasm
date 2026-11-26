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

/* ---------- chart ---------- */
const COLORS = ['#CE2029', '#32CD32', '#1E90FF', '#FFFFFF', '#808080'];
function drawChart(res) {
  const cv = $('chart');
  const wrap = cv.parentElement;
  const W = wrap.clientWidth - 20;
  const overlay = res.meta && res.meta.overlay;
  const subH = overlay ? 0 : 110;
  const H = 280 + subH;
  cv.width = W; cv.height = H;
  cv.style.height = H + 'px';
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const n = res.c.length;
  if (!n) return;
  const padR = 64, padT = 8, padB = 18;
  const cw = W - padR;
  const candleH = overlay ? H - padB : 280;
  // y range: candles + overlay plots
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < n; k++) { if (res.l[k] < lo) lo = res.l[k]; if (res.h[k] > hi) hi = res.h[k]; }
  if (overlay && res.plots) {
    for (const p of res.plots) {
      for (const v of p.values) { if (v === v && v < hi) hi = Math.max(hi, v); if (v === v && v > lo) lo = Math.min(lo, v); }
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) { hi = lo + 1; lo -= 1; }
  const span = hi - lo;
  lo -= span * 0.04; hi += span * 0.04;
  const Y = price => padT + (1 - (price - lo) / (hi - lo)) * (candleH - padT - 4);
  const X = bar => (bar / Math.max(1, n - 1)) * (cw - 2) + 1;
  // grid
  ctx.strokeStyle = '#222'; ctx.lineWidth = 1;
  ctx.font = '11px JetBrains Mono'; // hline price labels only, chart text allowed 12px min? keep 12
  ctx.font = '12px JetBrains Mono';
  for (let g = 0; g <= 4; g++) {
    const py = padT + g * (candleH - padT - 4) / 4;
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(cw, py); ctx.stroke();
    ctx.fillStyle = '#555';
    const price = lo + (1 - (py - padT) / (candleH - padT - 4)) * (hi - lo);
    ctx.fillText(price.toFixed(2), cw + 4, py + 4);
  }
  // candles
  const bw = Math.max(1, (cw / n) * 0.6);
  for (let k = 0; k < n; k++) {
    const x = X(k);
    const up = res.c[k] >= res.o[k];
    ctx.strokeStyle = up ? '#32CD32' : '#CE2029';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(x, Y(res.h[k])); ctx.lineTo(x, Y(res.l[k])); ctx.stroke();
    const y1 = Y(Math.max(res.o[k], res.c[k]));
    const y2 = Y(Math.min(res.o[k], res.c[k]));
    ctx.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
  }
  // hlines
  if (res.hlines) {
    for (const hl of res.hlines) {
      if (!Number.isFinite(hl.price)) continue;
      if (hl.price < lo || hl.price > hi) continue;
      ctx.strokeStyle = COLORS[hl.colorId || 4] + '66';
      ctx.beginPath(); ctx.moveTo(0, Y(hl.price)); ctx.lineTo(cw, Y(hl.price)); ctx.stroke();
    }
  }
  // plots
  if (res.plots) {
    for (const p of res.plots) {
      const vals = p.values;
      const inMain = overlay;
      const yOf = v => inMain
        ? Y(v)
        : 290 + (1 - normIn(v)) * (subH - 10) + 4;
      function normIn(v) {
        let mn = Infinity, mx = -Infinity;
        for (const q of vals) { if (q === q) { if (q < mn) mn = q; if (q > mx) mx = q; } }
        if (!Number.isFinite(mn) || mx === mn) return 0.5;
        return (v - mn) / (mx - mn);
      }
      ctx.strokeStyle = COLORS[p.colorId] || COLORS[1];
      ctx.beginPath();
      let started = false;
      for (let k = 0; k < n; k++) {
        const v = vals[k];
        if (v !== v) { started = false; continue; }
        const x = X(k), y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  // shapes
  if (res.shapes) {
    for (const bar of res.shapes) {
      const x = X(bar);
      const y = Y(res.c[bar]) + 10;
      ctx.fillStyle = '#1E90FF';
      ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x - 4, y + 3); ctx.lineTo(x + 4, y + 3); ctx.closePath(); ctx.fill();
    }
  }
  // trades
  if (res.trades) {
    for (const t of res.trades) {
      const x = X(t.entryBar), y = Y(t.entryPx);
      const ent = t.dir > 0;
      ctx.fillStyle = ent ? '#32CD32' : '#CE2029';
      ctx.beginPath();
      if (ent) { ctx.moveTo(x, y - 8); ctx.lineTo(x - 5, y + 1); ctx.lineTo(x + 5, y + 1); }
      else { ctx.moveTo(x, y + 8); ctx.lineTo(x - 5, y - 1); ctx.lineTo(x + 5, y - 1); }
      ctx.closePath(); ctx.fill();
      if (Number.isFinite(t.exitPx)) {
        const x2 = X(t.exitBar), y2 = Y(t.exitPx);
        ctx.strokeStyle = '#888';
        ctx.beginPath(); ctx.arc(x2, y2, 3.5, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }
  // date labels
  ctx.fillStyle = '#555';
  const step = Math.max(1, Math.floor(n / 6));
  for (let k = Math.floor(step / 2); k < n; k += step) {
    const d = new Date(res.t[k] * 1000);
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    ctx.fillText(label, X(k) - 12, H - 3);
  }
}

/* ---------- run ---------- */
async function doRun() {
  setPill('COMPILING', 'busy');
  try {
    const res = await window.pw.run({ src: editor.value, dataSpec, inputs: lastInputs || {} });
    if (!res.ok) {
      logErrors(res);
      setPill('ERRORS', 'err');
      return;
    }
    lastMeta = res.meta;
    lastInputs = null;
    renderStats(res);
    drawChart(res);
    renderTrades(res.trades);
    log(`OK wasm=${res.wasmSize ? res.wasmSize : ''}B bars=${res.nbars} compile=${res.compileMs}ms run=${res.runMs}ms net=${res.stats.netProfit.toFixed(2)} trades=${res.stats.trades}`, 'ok');
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
  let html = '<tr><th>DIR</th><th>ENTRY</th><th>PX</th><th>EXIT</th><th>PX</th><th>PNL</th><th>WHY</th></tr>';
  for (const tr of trades.slice(-200).reverse()) {
    const g = tr.pnl > 0 ? 'g' : 'r';
    html += `<tr><td class="${g}">${tr.dir > 0 ? 'LONG' : 'SHORT'}</td><td class="d">${fmtTime(tr.entryTime)}</td><td>${tr.entryPx.toFixed(2)}</td><td class="d">${Number.isFinite(tr.exitTime) ? fmtTime(tr.exitTime) : '-'}</td><td>${Number.isFinite(tr.exitPx) ? tr.exitPx.toFixed(2) : '-'}</td><td class="${g}">$${tr.pnl.toFixed(2)}</td><td class="d">${tr.reason || ''}</td></tr>`;
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

/* ---------- boot ---------- */
editor.value = SAMPLE;
syncGutter();
setPill('ENGINE IDLE');
log('PineWASM Desktop v0.1. Paste a Pine Script strategy, press RUN.', 'dim');
doRun();
