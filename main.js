// PineWASM Desktop - Electron main process
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const rt = require('./engine/runtime');
const dataMod = require('./engine/data');
const pygen = require('./engine/pygen');

let win = null;

function createWindow() {
  const displays = screen.getAllDisplays();
  // DISPLAY RULE: open on the LEFTMOST display
  const left = displays.sort((a, b) => a.workArea.x - b.workArea.x)[0];
  const wa = left.workArea;
  win = new BrowserWindow({
    x: wa.x + Math.round(wa.width * 0.06),
    y: wa.y + Math.round(wa.height * 0.05),
    width: Math.round(wa.width * 0.88),
    height: Math.round(wa.height * 0.88),
    minWidth: 1000,
    minHeight: 620,
    backgroundColor: '#000000',
    title: 'PineWASM',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

/* ---------- compile cache ---------- */
const compCache = new Map();
async function getCompiled(src) {
  const crypto = require('crypto');
  const key = crypto.createHash('sha1').update(src).digest('hex');
  if (compCache.has(key)) return compCache.get(key);
  const comp = await rt.compileScript(src);
  compCache.set(key, comp);
  if (compCache.size > 12) compCache.delete(compCache.keys().next().value);
  return comp;
}

function loadData(spec) {
  if (spec.source === 'sample') return dataMod.genSample(spec.n || 3000);
  if (spec.source === 'csv') return dataMod.parseCsv(fs.readFileSync(spec.path, 'utf8'));
  if (spec.source === 'okx' && spec.data) {
    return dataMod.toData(spec.data.T, spec.data.O, spec.data.H, spec.data.L, spec.data.C, spec.data.V);
  }
  if (spec.source === 'yahoo' && spec.data) {
    return dataMod.toData(spec.data.T, spec.data.O, spec.data.H, spec.data.L, spec.data.C, spec.data.V);
  }
  return dataMod.genSample(3000);
}

/* ---------- IPC ---------- */
ipcMain.handle('compile', async (_e, src) => {
  try {
    const comp = await getCompiled(src);
    const { wat } = comp.info ? comp.info : {};
    return {
      ok: comp.ok, meta: comp.meta, inputs: comp.inputs, plots: comp.plots,
      shapes: comp.shapes, hlines: comp.hlines, seriesCount: comp.seriesCount,
      wasmSize: comp.wasmSize, compileMs: comp.compileMs, watMs: comp.watMs,
      errs: comp.errs, warns: comp.warns,
    };
  } catch (ex) { return { ok: false, errs: [{ line: 0, msg: ex.message }] }; }
});

ipcMain.handle('run', async (_e, payload) => {
  const { src, dataSpec, inputs, metaOverride } = payload;
  try {
    const comp = await getCompiled(src);
    if (!comp.ok) return { ok: false, errs: comp.errs, warns: comp.warns };
    const data = loadData(dataSpec);
    const r = rt.runBacktest(comp, data, inputs || {}, metaOverride || null);
    return {
      ok: true, stats: r.stats, trades: r.trades,
      equity: downsample(r.equity, 2000),
      plots: r.plots.map(p => ({ pid: p.pid, title: p.title, colorId: p.colorId, values: Array.from(p.values) })),
      shapes: r.shapes, hlines: comp.hlines,
      meta: comp.meta, inputs: comp.inputs,
      runMs: r.runMs, nbars: r.nbars,
      t: Array.from(data.t), o: Array.from(data.o), h: Array.from(data.h),
      l: Array.from(data.l), c: Array.from(data.c), v: Array.from(data.v),
    };
  } catch (ex) { return { ok: false, errs: [{ line: 0, msg: 'run: ' + ex.message }] }; }
});

ipcMain.handle('sweep', async (_e, payload) => {
  const { src, dataSpec, inputs, name, values } = payload;
  try {
    const comp = await getCompiled(src);
    if (!comp.ok) return { ok: false, errs: comp.errs };
    const data = loadData(dataSpec);
    const rows = rt.sweep(comp, data, inputs || {}, { name, values });
    return { ok: true, rows };
  } catch (ex) { return { ok: false, errs: [{ line: 0, msg: 'sweep: ' + ex.message }] }; }
});

async function quantGenerateImpl(data, Q) {
  const loop = require('./engine/loop');
  const res = await loop.generateImpl(data, Q, { maxRounds: 5 });
  if (!res.best) {
    return { reply: 'GENERATE failed: ' + (res.error || 'unknown') + ' Try a more concrete description, or name a preset (conservative / balanced / aggressive / scalper / swing).', rounds: res.rounds };
  }
  const s = res.best.stats;
  let reply = `GENERATE (${res.best.preset}) - compiled + backtested on ${data.c.length} bars\n` +
    `net ${Number(s.netProfitPct).toFixed(2)}% | ${s.trades} trades | pf ${Number(Math.min(Math.max(s.profitFactor, 0), 99)).toFixed(2)} | win ${(s.winRate * 100).toFixed(1)}% | dd ${Number(s.maxDDPct).toFixed(2)}%\n`;
  reply += `Hit APPLY SOURCE to load it into the editor - then run the LLM LOOP chip to sharpen it.`;
  return { reply, applySource: res.best.src };
}

async function quantLoopImpl(src, data, message, rounds) {
  const q = require('./engine/quant');
  const loop = require('./engine/loop');
  const Q = Object.assign({}, q.parseGoal(message), { __msg: message });
  const res = await loop.runLoop(src, data, Q, { iterations: Math.min(Math.max(Number(rounds) || 4, 1), 8) });
  if (!res.ok && res.error) return { reply: 'LOOP failed: ' + res.error };
  let reply = 'LLM LOOP (' + res.rounds.length + ' runs)\nbaseline: ' + q.statsLine(res.base.stats) + ' (score ' + res.base.score + ')';
  for (const r2 of res.rounds) {
    if (r2.kind === 'baseline') continue;
    if (r2.kind === 'model' || r2.kind === 'compile') reply += `\nR${r2.i}: ${r2.kind === 'model' ? 'llm miss' : 'compile fail'} - ${r2.error}`;
    else {
      const mark = res.best.round === r2.i ? ' <- BEST' : '';
      reply += `\nR${r2.i}: net ${Number(r2.stats.netProfitPct).toFixed(2)}% | dd ${Number(r2.stats.maxDDPct).toFixed(2)}% | ${r2.stats.trades} trades | pf ${Number.isFinite(r2.stats.profitFactor) ? Number(r2.stats.profitFactor).toFixed(2) : 'inf'} | win ${(r2.stats.winRate * 100).toFixed(0)}% | score ${r2.score}${mark}`;
    }
  }
  const improved = res.best.score - res.base.score;
  reply += `\n\nBEST: round ${res.best.round} - score ${res.best.score} vs baseline ${res.base.score} (${improved >= 0 ? '+' : ''}${improved.toFixed(1)}) in ${(res.ms / 1000).toFixed(0)}s`;
  reply += `\nBest stats: ${q.statsLine(res.best.stats)}`;
  reply += `\nAPPLY SOURCE replaces the editor with the improved script (original stays recoverable from chat).`;
  return { reply, applySource: res.best.source };
}

ipcMain.handle('quant-loop', async (_e, { src, dataSpec, message, rounds }) => {
  try {
    const data = loadData(dataSpec);
    return await quantLoopImpl(src, data, message, rounds);
  } catch (ex) { return { reply: 'loop error: ' + ex.message };
  }
});

ipcMain.handle('quant-chat', async (_e, { src, dataSpec, message }) => {
  try {
    const comp = await getCompiled(src);
    if (!comp.ok) {
      return { reply: 'The script has compile errors - fix those first:\n' +
        (comp.errs || []).map(e => 'L' + e.line + ': ' + e.msg).join('\n') };
    }
    if (!comp.meta || !comp.meta.isStrategy) {
      return { reply: 'This is an indicator, not a strategy. The QUANT tunes strategies (entries/exits/sizing). Load a strategy script and try again.' };
    }
    const data = loadData(dataSpec);
    const q = require('./engine/quant');
    const Q = Object.assign({}, q.parseGoal(message), { __msg: message });
    if (Q.intent === 'loop') {
      return await quantLoopImpl(src, data, message, 4);
    }
    if (Q.intent === 'generate') {
      return await quantGenerateImpl(data, Q);
    }
    if (Q.intent === 'help' || Q.intent === 'unknown') return { reply: q.helpText(Q) };
    const baseRun = rt.runBacktest(comp, data, {}, null);
    const eq = baseRun.equity;
    if (Q.intent === 'stats') {
      const win = q.biggestDDWindow(eq, eq.length);
      const sh = q.sharpeOf(eq, data);
      const cnt = {};
      for (const t of baseRun.trades) cnt[t.reason] = (cnt[t.reason] || 0) + 1;
      const mix = Object.entries(cnt).map(([k2, v]) => v + ' ' + k2).join(' / ') || 'no trades';
      const f = new Date(data.t[win.from] * 1000).toISOString().slice(0, 10);
      const t2 = new Date(data.t[win.to] * 1000).toISOString().slice(0, 10);
      return { reply: `CURRENT (${data.c.length} bars)\n${q.statsLine(baseRun.stats)}\n` +
        `exits: ${mix}\nsharpe ~${sh ? sh.toFixed(2) : '-'}\nworst drawdown ${win.pct.toFixed(2)}% - peak ${f} -> trough ${t2}\n\n` +
        `Note: if all exits are "close"/"limit" and none "stop", a 100% win rate here is structural -\nyour script exits winners by design and the stop never gets touched. Give me a target and I optimize.` };
    }
    const res = await q.tune(comp, data, Q);
    const b = res.best;
    let reply = `TARGET: ${q.targetLine(Q)}\n`;
    reply += `BASELINE: ${q.statsLine(res.baseline.stats)}\n`;
    reply += (res.achieved ? 'HIT:     ' : 'CLOSEST: ') + `${q.statsLine(b.stats)}\n`;
    reply += `CHANGED: ${q.changesLine(res.baseline, b, res.knobs)}\n`;
    reply += `${res.runs} backtests in ${(res.ms / 1000).toFixed(1)}s (compile paid once)\n`;
    if (res.achieved && Q.ddMax != null) {
      reply += `\nDD margin vs target: ${(Q.ddMax - b.stats.maxDDPct).toFixed(2)}%. Hit APPLY to load these settings into the chart.`;
    } else if (res.achieved) {
      reply += `\nHit APPLY to load these settings into the chart.`;
    } else {
      reply += `\nCould not reach every target by tuning inputs + sizing alone on this dataset. Relax a constraint, or ask for M2 levers (hard per-trade stop, regime filter).`;
    }
    return { reply, apply: { inputs: b.inputs, qty: b.qty, maxpos: Q.maxPos || b.maxpos || null } };
  } catch (ex) { return { reply: 'quant error: ' + ex.message }; }
});

ipcMain.handle('fetch-yahoo', async (_e, { symbol, interval, range }) => {
  try {
    const iv = interval || '15m';
    // Yahoo caps intraday granularity: 1m ~7d, 5m/15m <60d, 1h <730d
    const RANGES = { '1m': '7d', '5m': '55d', '15m': '60d', '1h': '730d', '1d': '2y', '1wk': '5y' };
    const rg = range || RANGES[iv] || '1mo';
    // Yahoo v8 chart needs an fc.yahoo.com A3 cookie + crumb (422 without)
    const r0 = await fetch('https://fc.yahoo.com', { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const jar = (r0.headers.getSetCookie ? r0.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
    const rc = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': 'Mozilla/5.0', Cookie: jar }, signal: AbortSignal.timeout(15000) });
    const crumb = (await rc.text()).trim();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?crumb=${encodeURIComponent(crumb)}&interval=${iv}&range=${encodeURIComponent(rg)}&includePrePost=false&events=div%2Csplit`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json', Cookie: jar },
      signal: AbortSignal.timeout(25000),
    });
    const j = await res.json();
    const r1 = j && j.chart && j.chart.result && j.chart.result[0];
    if (!r1 || (j.chart && j.chart.error)) return { ok: false, errs: [{ line: 0, msg: 'yahoo: ' + ((j.chart && j.chart.error && j.chart.error.description) || ('http ' + res.status + ' for ' + symbol)) }] };
    const q = (r1.indicators && r1.indicators.quote && r1.indicators.quote[0]) || {};
    const ts = r1.timestamp || [];
    const o = q.open || [], h = q.high || [], l = q.low || [], c = q.close || [], v = q.volume || [];
    const T2 = [], O2 = [], H2 = [], L2 = [], C2 = [], V2 = [];
    for (let i = 0; i < ts.length; i++) {
      const oo = o[i], hh = h[i], ll = l[i], cc = c[i];
      if (oo == null || hh == null || ll == null || cc == null) continue; // yahoo nulls on halts
      T2.push(ts[i]); O2.push(Number(oo)); H2.push(Number(hh)); L2.push(Number(ll)); C2.push(Number(cc)); V2.push(Number(v[i]) || 0);
    }
    if (T2.length > 5000) { // cap memory; keep the most recent bars
      const cut = T2.length - 5000;
      return { ok: true, data: { T: T2.slice(cut), O: O2.slice(cut), H: H2.slice(cut), L: L2.slice(cut), C: C2.slice(cut), V: V2.slice(cut) },
        meta: { symbol: (r1.meta && r1.meta.symbol) || symbol, currency: r1.meta && r1.meta.currency, exchange: r1.meta && r1.meta.exchangeName } };
    }
    return { ok: true, data: { T: T2, O: O2, H: H2, L: L2, C: C2, V: V2 }, meta: { symbol: (r1.meta && r1.meta.symbol) || symbol, currency: r1.meta && r1.meta.currency, exchange: r1.meta && r1.meta.exchangeName } };
  } catch (ex) { return { ok: false, errs: [{ line: 0, msg: 'yahoo: ' + ex.message }] }; }
});

ipcMain.handle('fetch-klines', async (_e, { symbol, bar, limit }) => {
  try {
    const url = `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(symbol)}&bar=${bar}&limit=${Math.min(limit, 300)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const j = await res.json();
    const rows = (j.data || []).slice().reverse();
    const T = rows.map(r => Number(r[0]) / 1000);
    const O = rows.map(r => Number(r[1]));
    const H = rows.map(r => Number(r[2]));
    const L = rows.map(r => Number(r[3]));
    const C = rows.map(r => Number(r[4]));
    const V = rows.map(r => Number(r[5]));
    return { ok: true, data: { T, O, H, L, C, V } };
  } catch (ex) { return { ok: false, errs: [{ line: 0, msg: 'fetch: ' + ex.message }] }; }
});

ipcMain.handle('genbot', async (_e, { src, botName }) => {
  try {
    const out = pygen.generateBot(src);
    if (out.errs.length) return { ok: false, errs: out.errs };
    const slug = (botName || out.meta.title || 'bot').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'bot';
    const dir = path.join(__dirname, 'bots', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bot.py'), out.bot);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(
      Object.fromEntries(out.inputs.map(i => [i.name, i.def])), null, 2));
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'pandas\nnumpy\nrequests\n');
    fs.writeFileSync(path.join(dir, 'README.md'),
      `# ${out.meta.title}\n\nGenerated by PineWASM Desktop from a TradingView-perfected strategy.\n\n## Run backtest\n\n    python bot.py --okx BTC-USDT-SWAP --tf 15m --limit 300\n    python bot.py --csv data.csv --trades-csv trades.csv\n\n## Live + webhook (Tradovate bridge)\n\nSet "webhook_url" in config.json, then:\n\n    python bot.py --okx BTC-USDT-SWAP --live --interval 30\n\nSignals POST JSON: {"action":"buy"|"sell"|"close","symbol":...,"qty":1,"price":...}\n`);
    return { ok: true, dir, code: out.bot, meta: out.meta, inputs: out.inputs };
  } catch (ex) { return { ok: false, errs: [{ line: 0, msg: 'genbot: ' + ex.message }] }; }
});

ipcMain.handle('open-path', async (_e, p) => { shell.openPath(p || path.join(__dirname, 'bots')); return true; });
ipcMain.handle('export-wasm', async (_e, src) => {
  try {
    const comp = await getCompiled(src);
    if (!comp.ok) return { ok: false, errs: comp.errs };
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save WASM module', defaultPath: 'pinewasm_strategy.wasm',
    });
    if (canceled || !filePath) return { ok: true, skipped: true };
    fs.writeFileSync(filePath, Buffer.from(comp.bytes));
    fs.writeFileSync(filePath.replace(/\.wasm$/, '.wat'), comp.wat);
    return { ok: true, path: filePath };
  } catch (ex) { return { ok: false, errs: [{ line: 0, msg: ex.message }] };
  }
});
ipcMain.handle('read-file', async (_e, p) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: p === 'pine' ? 'Open Pine Script' : 'Open CSV data',
    filters: p === 'pine'
      ? [{ name: 'Pine', extensions: ['pine', 'txt'] }]
      : [{ name: 'CSV', extensions: ['csv', 'txt'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  return { path: filePaths[0], text: fs.readFileSync(filePaths[0], 'utf8') };
});

function downsample(arr, n) {
  if (arr.length <= n) return Array.from(arr);
  const step = arr.length / n;
  const out = [];
  for (let k = 0; k < n; k++) out.push(arr[Math.floor(k * step)]);
  return out;
}
