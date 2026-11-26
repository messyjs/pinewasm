// PineWASM Desktop - host runtime: ta library, broker emulator, backtest runner
'use strict';

function buildF64(mem) { return new Float64Array(mem.buffer); }

/* ---------- ta host library (window math over linear memory) ---------- */
function makeTa(mem, states) {
  const F = buildF64(mem);
  const rd = (base, bar) => F[base >> 3 + 0] === undefined ? NaN : F[(base + 8 * bar) >> 3];
  const rd2 = (base, bar) => F[(base + 8 * bar) >> 3];
  const win = (base, bar, len) => {
    if (bar - len + 1 < 0) return null;
    const s = new Float64Array(len);
    for (let k = 0; k < len; k++) { const v = rd2(base, bar - k); if (Number.isNaN(v)) return null; s[len - 1 - k] = v; }
    return s;
  };
  const mean = arr => { let x = 0; for (const v of arr) x += v; return x / arr.length; };
  const sma = (base, bar, len) => { const w = win(base, bar, len); return w ? mean(w) : NaN; };
  const wma = (base, bar, len) => {
    const w = win(base, bar, len); if (!w) return NaN;
    let num = 0, den = 0;
    for (let k = 0; k < len; k++) { const wt = len - k; num += w[k] * wt; den += wt; }
    return num / den;
  };
  const stdev = (base, bar, len) => {
    const w = win(base, bar, len); if (!w) return NaN;
    const m = mean(w); let s2 = 0;
    for (const v of w) { const d = v - m; s2 += d * d; }
    return Math.sqrt(s2 / len); // population (TV default biased)
  };
  const rmaStep = (st, v, len) => {
    const alpha = 1 / len;
    if (Number.isNaN(v)) return st.n > 0 ? st.v : NaN; // hold state on na input
    if (st.n < len) {
      st.n++;
      if (st.n === len) st.v = undefined; // seeded below by caller via sum
      if (st.n < len) { st.sum = (st.sum || 0) + v; return NaN; }
    }
    if (st.n === len && st.v === undefined) { st.sum = (st.sum || 0) + v; st.v = st.sum / len; return st.v; }
    st.v = alpha * v + (1 - alpha) * st.v;
    return st.v;
  };
  const emaStep = (st, v, len) => {
    const alpha = 2 / (len + 1);
    if (Number.isNaN(v)) return st.n > 0 ? st.v : NaN;
    if (st.n < len) {
      st.sum = (st.sum || 0) + v; st.n++;
      if (st.n < len) return NaN;
      st.v = st.sum / len; return st.v;
    }
    st.v = alpha * v + (1 - alpha) * st.v;
    return st.v;
  };
  const st2 = key => { if (!states.has(key)) states.set(key, { n: 0 }); return states.get(key); };
  return {
    F, rd, rd2, win, sma, wma, stdev,
    ta_sma: (base, bar, len) => sma(base, bar, len),
    ta_wma: (base, bar, len) => wma(base, bar, len),
    ta_stdev: (base, bar, len) => stdev(base, bar, len),
    ta_ema: (sid, base, bar, len) => emaStep(st2('e' + sid), rd2(base, bar), len),
    ta_rma: (sid, base, bar, len) => rmaStep(st2('r' + sid), rd2(base, bar), len),
    ta_rsi: (sid, base, bar, len) => {
      const su = st2('rsiU' + sid), sd = st2('rsiD' + sid);
      const cur = rd2(base, bar), prev = bar > 0 ? rd2(base, bar - 1) : NaN;
      if (Number.isNaN(prev)) { su.hold = true; sd.hold = true; return NaN; }
      const chg = cur - prev;
      const up = chg > 0 ? chg : 0, dn = chg < 0 ? -chg : 0;
      const u = rmaStep(su, up, len), d = rmaStep(sd, dn, len);
      if (Number.isNaN(u) || Number.isNaN(d)) return NaN;
      if (d === 0) return u > 0 ? 100 : NaN;
      const rs = u / d;
      return 100 - 100 / (1 + rs);
    },
    ta_highest: (base, bar, len) => { const w = win(base, bar, len); if (!w) return NaN; let m = -Infinity; for (const v of w) if (v > m) m = v; return m; },
    ta_lowest: (base, bar, len) => { const w = win(base, bar, len); if (!w) return NaN; let m = Infinity; for (const v of w) if (v < m) m = v; return m; },
    ta_change: (base, bar) => bar > 0 ? rd2(base, bar) - rd2(base, bar - 1) : NaN,
    ta_mom: (base, bar, len) => bar - len >= 0 ? rd2(base, bar) - rd2(base, bar - len) : NaN,
    ta_crossover: (aB, bB, bar) => {
      if (bar < 1) return 0;
      const ac = rd2(aB, bar), bc = rd2(bB, bar), ap = rd2(aB, bar - 1), bp = rd2(bB, bar - 1);
      return (ac > bc && ap <= bp) ? 1 : 0;
    },
    ta_crossunder: (aB, bB, bar) => {
      if (bar < 1) return 0;
      const ac = rd2(aB, bar), bc = rd2(bB, bar), ap = rd2(aB, bar - 1), bp = rd2(bB, bar - 1);
      return (ac < bc && ap >= bp) ? 1 : 0;
    },
    ta_cum: (sid, base, bar) => {
      const st = st2('c' + sid);
      const v = rd2(base, bar);
      if (!Number.isNaN(v)) st.s = (st.s || 0) + v;
      return st.s || 0;
    },
    ta_valuewhen: (cB, sB, bar, occ) => {
      let count = 0;
      for (let b = bar; b >= 0; b--) {
        const c = rd2(cB, b);
        if (c === c && c !== 0) {
          if (count === occ) return rd2(sB, b);
          count++;
        }
      }
      return NaN;
    },
    math_log: Math.log, math_exp: Math.exp,
  };
}

/* ---------- broker (typed-array data: {t,o,h,l,c,v} Float64Arrays) ---------- */
function makeBroker(meta, data) {
  const cap = meta.capital || 100000;
  const px = { t: data.t, o: data.o, h: data.h, l: data.l, c: data.c };
  const at = (arr, bar) => arr[bar];
  const b = {
    cash: cap, qty: 0, avgPx: NaN, entrySid: -1, entryBar: -1,
    pendMarket: [], pendClose: [], exits: new Map(),
    equity: [], trades: [], o: null, commissions: 0,
    pyramiding: meta.pyramiding || 0,
  };
  const sizeQty = (dir, px, bar) => {
    const eq = b.cash + b.qty * px;
    const val = meta.default_qty_value || 10;
    if (meta.default_qty_type === 1) return Math.abs(val);
    return (eq * val / 100) / px; // percent of equity
  };
  const commission = (notional) => {
    const cv = meta.commission_value || 0;
    const c = meta.commission_type === 1 ? cv : notional * cv / 100;
    b.cash -= c; b.commissions += c;
  };
  const closePos = (pxl, bar, reason) => {
    if (b.qty === 0) return;
    const dir = Math.sign(b.qty);
    const q = Math.abs(b.qty);
    const pnl = dir * (pxl - b.avgPx) * q;
    commission(Math.abs(q * pxl));
    if (b.o) {
      b.o.exitBar = bar; b.o.exitPx = pxl; b.o.exitTime = data.t[bar];
      b.o.pnl = pnl; b.o.reason = reason;
      b.trades.push(b.o); b.o = null;
    }
    b.cash += pnl; b.qty = 0; b.avgPx = NaN; b.entrySid = -1;
  };
  const openPos = (dir, pxl, bar, sid, qtyOverride) => {
    const q = qtyOverride !== undefined ? qtyOverride : sizeQty(dir, pxl, bar);
    if (!(q > 0)) return;
    commission(Math.abs(q * pxl));
    b.qty = dir * q; b.avgPx = pxl; b.entrySid = sid; b.entryBar = bar;
    b.o = { dir, entryBar: bar, entryTime: data.t[bar], entryPx: pxl, qty: q, sid };
    b.exits.set(sid, { stop: NaN, limit: NaN });
  };
  return {
    state: b,
    strat_entry: (bar, sid, dir) => { b.pendMarket.push({ bar, sid, dir: dir > 0 ? 1 : -1 }); },
    strat_entryq: (bar, sid, dir, qty) => { b.pendMarket.push({ bar, sid, dir: dir > 0 ? 1 : -1, qty: Math.abs(qty) }); },
    strat_close: (bar, sid) => { b.pendClose.push({ bar, sid }); },
    strat_exit: (bar, sid, fromSid, stop, limit) => { b.exits.set(fromSid, { stop, limit }); },
    strat_pos: () => b.qty,
    strat_avg: () => b.qty === 0 ? NaN : b.avgPx,
    step: (bar) => {
      const oo = data.o[bar], hh = data.h[bar], ll = data.l[bar];
      // 1) market orders from previous bar fills at open
      const fills = b.pendMarket.filter(x => x.bar < bar); b.pendMarket = b.pendMarket.filter(x => x.bar >= bar);
      const closes = b.pendClose.filter(x => x.bar < bar); b.pendClose = b.pendClose.filter(x => x.bar >= bar);
      for (const c of closes) {
        if (c.sid === -2) closePos(oo, bar, 'close');
        else if (b.qty !== 0 && b.entrySid === c.sid) closePos(oo, bar, 'close');
      }
      for (const f of fills) {
        if (f.dir > 0) {
          if (b.qty < 0) closePos(oo, bar, 'reverse');
          if (b.qty > 0 && b.entrySid === f.sid) continue; // already in
          if (b.qty === 0) openPos(1, oo, bar, f.sid, f.qty);
        } else {
          if (b.qty > 0) closePos(oo, bar, 'reverse');
          if (b.qty < 0 && b.entrySid === f.sid) continue;
          if (b.qty === 0) openPos(-1, oo, bar, f.sid, f.qty);
        }
      }
      // 2) intrabar exits
      if (b.qty !== 0) {
        const ex = b.exits.get(b.entrySid);
        if (ex) {
          const dir = Math.sign(b.qty);
          if (dir > 0) {
            if (ex.stop === ex.stop && ll <= ex.stop) closePos(Math.min(oo, ex.stop), bar, 'stop');
            else if (ex.limit === ex.limit && hh >= ex.limit) closePos(Math.max(oo, ex.limit), bar, 'limit');
          } else {
            if (ex.stop === ex.stop && hh >= ex.stop) closePos(Math.max(oo, ex.stop), bar, 'stop');
            else if (ex.limit === ex.limit && ll <= ex.limit) closePos(Math.min(oo, ex.limit), bar, 'limit');
          }
        }
      }
    },
    mark: (bar) => {
      b.equity.push(b.cash + b.qty * data.c[bar]);
    },
    finish: () => {
      const last = data.c.length - 1;
      if (b.qty !== 0) closePos(data.c[last], last, 'end');
      return b;
    },
  };
}

/* ---------- stats ---------- */
function computeStats(b, cap) {
  const eq = b.equity;
  let peak = -Infinity, maxDD = 0;
  for (const v of eq) { if (v > peak) peak = v; if (peak > 0) { const dd = (peak - v) / peak; if (dd > maxDD) maxDD = dd; } }
  const trades = b.trades;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const net = (b.cash - cap);
  return {
    netProfit: net,
    netProfitPct: net / cap * 100,
    finalEquity: b.cash,
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
    maxDDPct: maxDD * 100,
    avgTrade: trades.length ? net / trades.length : 0,
    commissions: b.commissions,
  };
}

/* ---------- compile + run ---------- */
let wabtMod = null;
async function ensureWabt() {
  if (!wabtMod) {
    const WabtModule = require('wabt');
    wabtMod = await WabtModule();
  }
  return wabtMod;
}

async function compileScript(src) {
  const t0 = Date.now();
  const info = require('./compile').compile(src);
  const tC = Date.now() - t0;
  if (!info.wat || info.errs.length) {
    return { ok: false, errs: info.errs, warns: info.warns, meta: info.meta, compileMs: tC, info };
  }
  const wabt = await ensureWabt();
  const t1 = Date.now();
  let wasmBytes = null;
  try {
    const parsed = wabt.parseWat('pinewasm.wat', info.wat, {});
    const bin = parsed.toBinary({ log: false, write_debug_names: false });
    wasmBytes = bin.buffer;
  } catch (ex) {
    return { ok: false, errs: [{ line: 0, msg: 'wat parse: ' + ex.message }], warns: info.warns, meta: info.meta, compileMs: tC, info, wat: info.wat };
  }
  const wam = new WebAssembly.Module(wasmBytes);
  const tW = Date.now() - t1;
  return {
    ok: true, module: wam, wasmSize: wasmBytes.length, bytes: wasmBytes,
    meta: info.meta, inputs: info.inputs, layout: info.layout,
    seriesCount: info.series.length, plots: info.plots, shapes: info.shapes, hlines: info.hlines,
    strings: info.strings, stateCount: info.stateCount,
    compileMs: tC, watMs: tW, warns: info.warns, wat: info.wat, info,
  };
}

// data: {o,h,l,c,v,t: Float64Array}, nbars
function buildMemory(comp, data, nbars, inputValues) {
  const lay = comp.layout;
  const bytesNeeded = lay.seriesBase + 8 * comp.seriesCount * nbars;
  const pages = Math.ceil(bytesNeeded / 65536) + 1;
  const mem = new WebAssembly.Memory({ initial: pages, maximum: pages });
  const F = new Float64Array(mem.buffer);
  // params
  for (let i = 0; i < lay.nParams; i++) {
    const inp = comp.inputs.find(x => x.idx === i);
    F[i] = (inputValues && inputValues[inp && inp.name || i] !== undefined)
      ? Number(inputValues[inp && inp.name || i])
      : ((inp && inp.defval) || 0);
  }
  // ohlcv (+hl2)
  const base = lay.dataBase >> 3;
  const stride = nbars;
  const src = data;
  for (let k = 0; k < nbars; k++) {
    F[base + 0 * stride + k] = src.o[k];
    F[base + 1 * stride + k] = src.h[k];
    F[base + 2 * stride + k] = src.l[k];
    F[base + 3 * stride + k] = src.c[k];
    F[base + 4 * stride + k] = src.v[k];
    F[base + 5 * stride + k] = src.t[k];
    F[base + 6 * stride + k] = (src.h[k] + src.l[k]) / 2;
  }
  return mem;
}

function zeroSeries(mem, comp, nbars) {
  const lay = comp.layout;
  const F = new Float64Array(mem.buffer);
  const start = lay.seriesBase >> 3;
  const len = comp.seriesCount * nbars;
  F.fill(0, start, start + len);
}

function makeInstance(comp, mem, data, nbars) {
  const broker = makeBroker(comp.meta, data);
  const states = new Map();
  const ta = makeTa(mem, states);
  // tr + atr need OHLC: wrap with memory view
  const F = ta.F;
  const dBase = comp.layout.dataBase >> 3;
  const stride = nbars;
  const hAt = b => F[dBase + 1 * stride + b], lAt = b => F[dBase + 2 * stride + b], cAt = b => F[dBase + 3 * stride + b];
  ta.ta_tr = (bar) => {
    const tr0 = hAt(bar) - lAt(bar);
    if (bar === 0) return tr0;
    const pc = cAt(bar - 1);
    return Math.max(tr0, Math.abs(hAt(bar) - pc), Math.abs(lAt(bar) - pc));
  };
  ta.ta_atr = (sid, bar, len) => {
    const st = states.get('atr' + sid) || (() => { const s = { n: 0 }; states.set('atr' + sid, s); return s; })();
    return rmaStepImpl(st, ta.ta_tr(bar), len);
  };
  function rmaStepImpl(st, v, len) {
    const alpha = 1 / len;
    if (Number.isNaN(v)) return st.n > 0 ? st.v : NaN;
    if (st.n < len) {
      st.sum = (st.sum || 0) + v; st.n++;
      if (st.n < len) return NaN;
      st.v = st.sum / len; return st.v;
    }
    st.v = alpha * v + (1 - alpha) * st.v;
    return st.v;
  }
  // plot buffers
  const plots = comp.plots.map(p => ({ ...p, values: new Float64Array(nbars).fill(NaN) }));
  const shapeArr = [];
  const plotIdx = new Map(plots.map(p => [p.pid, p]));
  const imports = {
    env: { mem },
    e: Object.assign({}, ta, {
      strat_pos: broker.strat_pos, strat_avg: broker.strat_avg,
      strat_entry: broker.strat_entry, strat_entryq: broker.strat_entryq,
      strat_close: broker.strat_close, strat_exit: broker.strat_exit,
      plot: (bar, pid, v) => { const p = plotIdx.get(pid); if (p) p.values[bar] = v; },
      plotshape: (bar, pid, v) => { if (v === v && v !== 0) shapeArr.push(bar); },
      // keep ta funcs' signatures: some take (bar) only
      ta_sma: ta.ta_sma, ta_wma: ta.ta_wma, ta_stdev: ta.ta_stdev,
      ta_ema: ta.ta_ema, ta_rma: ta.ta_rma, ta_rsi: ta.ta_rsi,
      ta_tr: ta.ta_tr, ta_atr: ta.ta_atr,
      ta_highest: ta.ta_highest, ta_lowest: ta.ta_lowest,
      ta_change: ta.ta_change, ta_mom: ta.ta_mom,
      ta_crossover: ta.ta_crossover, ta_crossunder: ta.ta_crossunder,
      ta_cum: ta.ta_cum, ta_valuewhen: ta.ta_valuewhen,
      math_log: ta.math_log, math_exp: ta.math_exp,
      before_bar: broker.step, after_bar: broker.mark,
    }),
  };
  // strip: wabt/wasm import table expects exact match; extra keys ok
  const inst = new WebAssembly.Instance(comp.module, imports);
  return { inst, broker, plots, shapeArr };
}

function runBacktest(comp, data, inputValues) {
  const nbars = data.c.length;
  const mem = buildMemory(comp, data, nbars, inputValues);
  const { inst, broker, plots, shapeArr } = makeInstance(comp, mem, data, nbars);
  const t0 = Date.now();
  inst.exports.run(nbars);
  const runMs = Date.now() - t0;
  const b = broker.finish();
  const stats = computeStats(b, comp.meta.capital || 100000);
  return {
    ok: true, stats, trades: b.trades, equity: b.equity, plots,
    shapes: shapeArr, runMs, nbars,
  };
}

function sweep(comp, data, baseInputs, sweepSpec) {
  const rows = [];
  const nbars = data.c.length;
  const mem = buildMemory(comp, data, nbars, baseInputs); // compile-time sizing only
  for (const val of sweepSpec.values) {
    zeroSeries(mem, comp, nbars);
    const iv = Object.assign({}, baseInputs || {}, { [sweepSpec.name]: val });
    // rewrite params
    const F = new Float64Array(mem.buffer);
    for (let i = 0; i < comp.layout.nParams; i++) {
      const inp = comp.inputs.find(x => x.idx === i);
      const nm = inp ? (inp.title || 'input' + i) : 'input' + i;
      F[i] = iv[nm] !== undefined ? Number(iv[nm]) : ((inp && inp.defval) || 0);
    }
    const { inst, broker } = makeInstance(comp, mem, data, nbars);
    inst.exports.run(nbars);
    const b = broker.finish();
    const st = computeStats(b, comp.meta.capital || 100000);
    rows.push({ value: val, stats: st });
  }
  return rows;
}

module.exports = { compileScript, runBacktest, sweep, buildMemory, zeroSeries, makeInstance, computeStats };
