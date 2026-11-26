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
  const { src, dataSpec, inputs } = payload;
  try {
    const comp = await getCompiled(src);
    if (!comp.ok) return { ok: false, errs: comp.errs, warns: comp.warns };
    const data = loadData(dataSpec);
    const r = rt.runBacktest(comp, data, inputs || {});
    return {
      ok: true, stats: r.stats, trades: r.trades,
      equity: downsample(r.equity, 2000),
      plots: r.plots.map(p => ({ pid: p.pid, title: p.title, colorId: p.colorId, values: Array.from(p.values) })),
      shapes: r.shapes, hlines: comp.hlines,
      meta: comp.meta, inputs: comp.inputs,
      runMs: r.runMs, nbars: r.nbars,
      t: Array.from(data.t), o: Array.from(data.o), h: Array.from(data.h),
      l: Array.from(data.l), c: Array.from(data.c),
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
