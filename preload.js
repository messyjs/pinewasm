// PineWASM - LUX cross-check host (runs in the PRELOAD isolated world)
// Embeds LuxAlgo's open-source vela chart + PineTS engine (from the 2026-11-24
// ANATOMY work) as a SECOND backtest engine: hidden chart fed with PineWASM's own
// bars, strategy mounted via runScript, per-trade ledger tabulated like TV.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// vendor resolution: LuxAlgo vela stack + its deps live in ./vendor (npm-proof)
const Module = require('module');
const nodePath = require('path');
const VENDOR = nodePath.join(__dirname, 'vendor');
const VENDOR_RE = /^(pinets|proxy-compare|@luxalgo\/|@zag-js\/|@floating-ui\/|@internationalized\/)/;
if (!Module._pwVendorHook) {
  const origResolve = Module._resolveFilename;
  Module._pwVendorHook = true;
  Module._resolveFilename = function (request, ...rest) {
    if (VENDOR_RE.test(request) && !nodePath.isAbsolute(request)) {
      try { return origResolve.call(this, nodePath.join(VENDOR, request), ...rest); } catch { }
    }
    return origResolve.call(this, request, ...rest);
  };
}

const { VelaWorkspace } = require('@luxalgo/vela/workspace');
const { PineWorkerEngine } = require('@luxalgo/vela-pinets');
const bridge = require('./engine/vela/pine-v4to5.cjs');

const OVERLAY_RE = /(?<![\w.$])overlay\s*[:=]\s*true(?:\s*[,)\n]|\s*$)/m;
const LUX_THEME = {
  background: '#000000', textColor: '#888888', gridColor: '#222222',
  borderColor: '#222222', upColor: '#32cd32', downColor: '#ce2029',
};

function prepSource(src) {
  const raw = String(src || '');
  let run = bridge.normalizePineFull(raw);
  try { if (bridge.needsBridge(run)) run = bridge.bridgePreV5(run).source; } catch { }
  return run;
}

const r2 = (v) => Math.round(Number(v) * 100) / 100;

// tabulate one ScriptRun (run.strategy + run.trades()) - port of ANATOMY backtest.mjs
function tabulate(run) {
  const st = run && run.strategy;
  if (!st) return { ok: false, error: 'engine returned no broker state - is it a strategy() script?' };
  return Promise.resolve(typeof run.trades === 'function' ? run.trades() : (typeof st.trades === 'function' ? st.trades() : []))
    .then((ledger0) => {
      const ledger = Array.isArray(ledger0) ? ledger0 : [];
      const closed = ledger.filter(t => !t.open && Number.isFinite(Number(t.pnl)));
      const open = ledger.filter(t => t.open);
      const cap = Number.isFinite(Number(st.initialCapital)) && Math.abs(st.initialCapital) > 0 ? Number(st.initialCapital) : 10000;
      const pnl = closed.map(t => Number(t.pnl));
      const grossProfit = closed.filter(t => Number(t.pnl) > 0).reduce((s, t) => s + Number(t.pnl), 0) || Number(st.grossProfit) || 0;
      const grossLoss = closed.filter(t => Number(t.pnl) < 0).reduce((s, t) => s - Number(t.pnl), 0) || Number(st.grossLoss) || 0;
      const pf = grossLoss > 0 ? r2(grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : null);
      const wins = closed.filter(t => Number(t.pnl) > 0), losses = closed.filter(t => Number(t.pnl) < 0);
      const tradesOut = ledger.map(t => {
        const entryFill = t.entry || {};
        const exitFill = t.exit || null;
        return {
          side: t.side, open: !!t.open,
          entryPx: Number(entryFill.price) || NaN, exitPx: exitFill ? Number(exitFill.price) : NaN,
          qty: Number(t.qty) || 0, pnl: t.open ? null : (Number.isFinite(Number(t.pnl)) ? r2(Number(t.pnl)) : null),
        };
      });
      const ddPct = Number.isFinite(Number(st.maxDrawdown)) ? Math.round(Math.max(0, Number(st.maxDrawdown)) / cap * 10000) / 100 : null;
      return {
        ok: true,
        initialCapital: r2(cap),
        m: {
          net: r2(Number(st.netPnl) || 0),
          netPct: r2((Number(st.netPnl) || 0) / cap * 100),
          pf: pf === Infinity ? 'inf' : pf,
          n: closed.length, openN: open.length,
          winRate: closed.length ? Math.round(wins.length / closed.length * 1000) / 10 : null,
          maxDD: r2(Number(st.maxDrawdown) || 0), ddPct,
          commissions: r2(closed.reduce((s, t) => s + (Number(t.commission) || 0), 0)),
          stops: closed.filter(t => /stop/i.test(String(t.reason || '')) || (Number(t.pnl) < 0)).length,
        },
        trades: tradesOut,
        bars: closed.length,
      };
    });
}

const sleep = (ms) => new Promise(r2 => setTimeout(r2, ms));

async function luxRun(payload) {
  const rows = Array.isArray(payload && payload.data) ? payload.data : [];
  const bars = rows.map(b => ({
    time: Math.round(Number(b.t) * 1000), open: Number(b.o), high: Number(b.h),
    low: Number(b.l), close: Number(b.c), volume: Number(b.v) || 0,
  })).filter(b => Number.isFinite(b.time) && Number.isFinite(b.close));
  if (bars.length < 50) return { ok: false, error: 'need >= 50 bars of loaded data for the lux engine' };
  if (!/\bstrategy\s*\(/.test(String(payload && payload.src))) return { ok: false, error: 'not a strategy() source' };

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;width:1000px;height:600px;z-index:-1;pointer-events:none;';
  document.body.appendChild(host);
  let ws = null, res = null, errTxt = '';
  try {
    ws = new VelaWorkspace(host, {
      layout: false,
      symbol: 'pwx:PINEWASM',
      timeframe: '15',
      live: false,
      persist: false,
      theme: LUX_THEME,
      engines: { pine: () => new PineWorkerEngine() },
      data: bars,
    });
    for (let attempt = 0; attempt < 40 && !res; attempt++) {
      try {
        if (!ws || !ws.chart || typeof ws.chart.runScript !== 'function') { await sleep(250); continue; }
        res = await ws.chart.runScript(prepSource(payload.src));
      } catch (e) {
        errTxt = String((e && e.message) || e);
        if (/engine|worker|not ready|initializ/i.test(errTxt)) { await sleep(250); continue; }
        break;
      }
    }
  } catch (e) {
    errTxt = 'workspace: ' + String((e && e.message) || e);
  }
  let report = null;
  if (res && res.ok) {
    try { report = await tabulate(res.run); } catch (e) { report = { ok: false, error: 'tabulate: ' + String((e && e.message) || e).slice(0, 160) }; }
    try { res.remove && res.remove(); } catch { }
  }
  try { ws && ws.destroy && ws.destroy(); } catch { }
  try { host.remove(); } catch { }
  if (!report) {
    const engErr = res && res.error ? ((res.error.message || String(res.error))) : errTxt;
    return { ok: false, error: String(engErr || 'engine refused to compile this script').slice(0, 240) };
  }
  return report;
}

contextBridge.exposeInMainWorld('pw', {
  compile: (src) => ipcRenderer.invoke('compile', src),
  run: (payload) => ipcRenderer.invoke('run', payload),
  sweep: (payload) => ipcRenderer.invoke('sweep', payload),
  luxRun,
  fetchKlines: (p) => ipcRenderer.invoke('fetch-klines', p),
  genbot: (p) => ipcRenderer.invoke('genbot', p),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  exportWasm: (src) => ipcRenderer.invoke('export-wasm', src),
  readFile: (kind) => ipcRenderer.invoke('read-file', kind),
});
