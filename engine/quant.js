// PineWASM Desktop - the Quant (chat-driven constraint optimizer)
// Parses goals like "max drawdown 5%", tunes strategy inputs + position size,
// verifies every candidate by re-running the WASM engine.
'use strict';
const rt = require('./runtime');

function numericInputs(comp) {
  return (comp.inputs || []).filter(i => i.type === 'int' || i.type === 'float');
}

function boxFor(inp) {
  const d = Number(inp.defval) || 0;
  let lo, hi;
  if (inp.minval != null && inp.maxval != null) { lo = inp.minval; hi = inp.maxval; }
  else if (inp.minval != null) { lo = inp.minval; hi = Math.max(inp.minval + 1, Math.round(Math.abs(d) * 3 + 1)); }
  else if (inp.maxval != null) { lo = inp.minval != null ? inp.minval : Math.max(inp.maxval / 4, 1); hi = inp.maxval; }
  else {
    const r = Math.max(Math.abs(d) * 2.5, d === Math.round(d) ? 10 : 1.5);
    lo = d > 0 ? Math.max(1, d - r) : d - r;
    hi = d > 0 ? d + r : Math.min(-1, d + r);
    if (inp.type === 'int') { lo = Math.max(2, Math.floor(lo)); }
  }
  if (inp.type === 'int') { lo = Math.ceil(lo); hi = Math.floor(hi); }
  if (!(hi > lo)) hi = lo + (inp.type === 'int' ? 1 : 0.5);
  lo = Math.round(lo * 1e4) / 1e4; hi = Math.round(hi * 1e4) / 1e4;
  return { lo, hi };
}

function randParam(inp) {
  const b = boxFor(inp);
  const v = inp.type === 'int'
    ? Math.round(b.lo + Math.random() * (b.hi - b.lo))
    : b.lo + Math.random() * (b.hi - b.lo);
  return Math.round(v * 1e4) / 1e4;
}

function clampParam(inp, v) {
  const b = boxFor(inp);
  v = Math.min(b.hi, Math.max(b.lo, v));
  return inp.type === 'int' ? Math.round(v) : Math.round(v * 1e4) / 1e4;
}

/* ---------------- goal parsing ---------------- */
function parseGoal(text) {
  const t = String(text || '').toLowerCase();
  const g = { ddMax: null, minTrades: null, minWr: null, minPf: null, minNet: null, fixedQty: null, maxPos: null, primary: null, intent: 'goal' };
  const first = (re) => { const m = t.match(re); return m ? parseFloat(m[1]) : null; };
  if (/(draw\s*down|drawdown|\bdd\b)/.test(t)) {
    g.ddMax = first(/(?:draw\s*down|drawdown|\bdd\b)\D{0,15}?(\d+(?:\.\d+)?)/);
    const rev = first(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s*(?:draw\s*down|drawdown|\bdd\b)/);
    if (g.ddMax == null) g.ddMax = rev;
  }
  if (/\bwin(?:\s?rate)?\b/.test(t)) g.minWr = first(/(?:win(?:\s?rate)?)\D{0,12}?(\d+(?:\.\d+)?)/);
  if (/(profit\s*factor|\bpf\b)/.test(t)) g.minPf = first(/(?:profit\s*factor|\bpf\b)\D{0,12}?(\d+(?:\.\d+)?)/);
  const tm = t.match(/(\d+)\s*trades?/); if (tm) g.minTrades = parseInt(tm[1], 10);
  g.minNet = first(/(?:net(?:\s?profit)?|return|profit)\D{0,15}?(\d+(?:\.\d+)?)\s*(?:%|percent)/);
  const qt = t.match(/(?:position\s*size|sizing|qty|size)\D{0,12}?(\d+(?:\.\d+)?)\s*(?:%|percent)/);
  if (qt) g.fixedQty = Math.min(100, parseFloat(qt[1]));
  const pm = t.match(/(\d+)\s*(?:concurrent|positions\b|pos\b|slots\b)/) || t.match(/(?:concurrent|positions\b|maxpos|max\s*pos)\D{0,8}?(\d+)/);
  if (pm) g.maxPos = Math.min(10, Math.max(1, parseInt(pm[1], 10)));
  if (/(higher|maximi[sz]e|more|best)\s*(net|profit|return)/.test(t) || /max profit/.test(t)) g.primary = 'net';
  if (!/\d/.test(t) && /(help|what can|how do|hello|hi\b|hey\b)/.test(t)) g.intent = 'help';
  if (!/\d/.test(t) && /(stats|baseline|current|performance|how is it|explain)/.test(t)) g.intent = 'stats';
  // LLM loop mode: source-rewriting agent loop (Quant 2.0 parity)
  if (/\b(loop|rewrite|rework|llm|agent|improve the (script|source|code))\b/.test(t)) {
    g.intent = 'loop';
    const hasTarget = g.ddMax != null || g.minTrades != null || g.minWr != null || g.minPf != null || g.minNet != null || g.maxPos != null;
    if (!hasTarget) { g.primary = 'net'; }
    return g;
  }
  const hasTarget = g.ddMax != null || g.minTrades != null || g.minWr != null || g.minPf != null || g.minNet != null || g.fixedQty != null || g.maxPos != null;
  if (g.intent === 'goal' && !hasTarget) g.intent = 'unknown';
  return g;
}

/* ---------------- evaluation ---------------- */
// hard = the user's stated targets; soft = robustness prior so the quant never
// falls in love with vacuous 1-trade candidates.
function hardPen(goal, s) {
  let pen = 0;
  if (goal.ddMax != null) pen += Math.max(0, s.maxDDPct - goal.ddMax) * 60;
  if (goal.minTrades != null) pen += Math.max(0, goal.minTrades - s.trades) * 25;
  if (goal.minWr != null) pen += Math.max(0, goal.minWr - s.winRate * 100) * 12;
  if (goal.minPf != null) pen += Math.max(0, goal.minPf - Math.min(Math.max(s.profitFactor, 0), 99)) * 40;
  if (goal.minNet != null) pen += Math.max(0, goal.minNet - s.netProfitPct) * 8;
  if (s.trades === 0) pen += 10000;
  return pen;
}
function softPen(goal, s, floor) {
  if (goal.minTrades != null || s.trades === 0) return 0;
  return Math.max(0, floor - s.trades) * 15;
}

async function tune(comp, data, goal, opts) {
  opts = opts || {};
  const maxRuns = opts.maxRuns || 450;
  const t0 = Date.now();
  const knobs = numericInputs(comp);
  const knobDefaults = Object.fromEntries(knobs.map(k => [k.title, k.defval]));
  const baseRun = rt.runBacktest(comp, data, {}, null);
  const base = { inputs: knobDefaults, qty: comp.meta.default_qty_value || 10, stats: baseRun.stats };
  const qtyRef = 10;
  let runs = 1;
  const floor = Math.max(4, Math.min(8, Math.floor((baseRun.stats.trades || 0) * 0.6)));

  // Hard constraints that do NOT depend on size (win rate / pf / trade floors).
  const sizeFreeGoal = Object.assign({}, goal, { ddMax: null });
  // The size-dependent DD budget: T in % of equity.
  const T = goal.ddMax != null ? goal.ddMax : Math.max(20, baseRun.stats.maxDDPct);

  let best1 = null;   // best signal config at reference size
  const rank1 = (inputs, stats) => {
    const ddRef = Math.max(0.4, stats.maxDDPct);
    const ddMinPossible = (stats.maxDDPct / qtyRef) * 1;   // even at qty 1
    const feasible = ddMinPossible <= T + 1e-9;
    const estNetAtBudget = feasible ? (stats.netProfitPct / ddRef) * T : -1e9;
    const hard = hardPen(sizeFreeGoal, stats);
    const soft = softPen(goal, stats, floor);
    return { inputs: Object.assign({}, inputs), stats, hard, soft, feasible, est: estNetAtBudget, trades: stats.trades };
  };
  function rankBetter(a, b2) {
    if (a.feasible !== b2.feasible) return a.feasible;
    if (a.hard !== b2.hard) return a.hard < b2.hard;
    if (a.soft !== b2.soft) return a.soft < b2.soft;
    if (Math.abs(a.est - b2.est) > 1e-9) return a.est > b2.est;
    return a.trades > b2.trades;
  }
  const consider1 = (inputs, stats) => {
    const c = rank1(inputs, stats);
    if (!best1 || rankBetter(c, best1)) best1 = c;
    return c;
  };

  let yieldI = { n: 0 };
  async function ynow() { if (++yieldI.n % 24 === 0) await new Promise(r => setImmediate(r)); }

  // mk(q, cap): meta override builder - goal.maxPos pins the cap; otherwise cap comes from the caller (auto caps)
  const mk = (q, cap) => (goal.maxPos != null
    ? Object.assign({ max_concurrent: goal.maxPos }, q != null ? { default_qty_value: q } : {})
    : (q != null ? { default_qty_value: q, max_concurrent: cap || 1 } : null));

  const runRef = (inputs) => rt.runBacktest(comp, data, inputs, mk(qtyRef, 1));

  // phase 1a: profile sweep - each knob scanned across its box, others default
  const pool = [];
  pool.push(consider1(knobDefaults, baseRun.stats));
  for (const k of knobs) {
    const b = boxFor(k);
    for (let i = 0; i < 8; i++) {
      if (runs >= maxRuns) break;
      const v = clampParam(k, b.lo + (b.hi - b.lo) * i / 7);
      const inputs = Object.assign({}, knobDefaults, { [k.title]: v });
      const c = consider1(inputs, runRef(inputs).stats);
      pool.push(c);
      runs++;
      await ynow();
    }
  }

  // phase 1b: hill climb the composite objective from the top seeds
  pool.sort((a, b2) => (rankBetter(a, b2) ? -1 : 1));
  const seeds = [];
  for (const c of pool) {
    if (seeds.length >= 3) break;
    const near = seeds.some(s2 => knobs.every(k => {
      const av = s2.inputs[k.title], bv = c.inputs[k.title];
      const b = boxFor(k);
      return av != null && bv != null && Math.abs(av - bv) <= (b.hi - b.lo) * 0.1;
    }));
    if (!near) seeds.push(c);
  }
  for (const seed of seeds) {
    let from = seed;
    for (let rd = 0; rd < 3 && runs < maxRuns; rd++) {
      let improved = false;
      for (const k of knobs) {
        const b = boxFor(k);
        const cur = from.inputs[k.title];
        const step = Math.max((b.hi - b.lo) / 12, k.type === 'int' ? 1 : 0.05);
        for (const dv of [-step * 2, -step, step, step * 2]) {
          if (runs >= maxRuns) break;
          const v = clampParam(k, cur + dv);
          if (v === cur) continue;
          const inputs = Object.assign({}, from.inputs, { [k.title]: v });
          const prev = best1;
          const c = consider1(inputs, runRef(inputs).stats);
          runs++;
          if (best1 !== prev) { from = c; improved = true; }
          await ynow();
        }
      }
      if (!improved) break;
    }
    if (runs >= maxRuns) break;
  }

  if (!best1) return { baseline: base, best: rank1(knobDefaults, baseRun.stats), runs, ms: Date.now() - t0, achieved: false, knobs: knobs.map(k => k.title) };

  // phase 2: consume the DD budget - binary search on position size at the winning config
  const fitQty = async (inputs, cap) => {
    if (goal.fixedQty != null) {
      const r = rt.runBacktest(comp, data, inputs, mk(goal.fixedQty, cap));
      runs++;
      return { inputs, qty: goal.fixedQty, maxpos: goal.maxPos || cap, stats: r.stats, hard: hardPen(goal, r.stats) };
    }
    let lo = 1, hi = 100, hit = null;
    while (runs < maxRuns && hi - lo > 0.2) {
      const qty = Math.round((lo + hi) / 2 * 4) / 4;
      if (qty === lo || qty === hi) break; // midpoint rounded onto a bound - no progress possible
      const r = rt.runBacktest(comp, data, inputs, mk(qty, cap));
      runs++;
      if (hardPen(goal, r.stats) <= 0) { lo = qty; hit = { inputs, qty, maxpos: goal.maxPos || cap, stats: r.stats, hard: 0 }; }
      else hi = qty;
      await ynow();
    }
    if (!hit) {
      const r = rt.runBacktest(comp, data, inputs, mk(1, cap));
      runs++;
      hit = { inputs, qty: 1, maxpos: goal.maxPos || cap, stats: r.stats, hard: hardPen(goal, r.stats) };
    }
    return hit;
  };
  let final = null;
  if (goal.maxPos != null) {
    final = await fitQty(best1.inputs, 1); // cap pinned by the goal
  } else {
    // auto: also fit the slot cap (1..3) - more slots means simultaneous same-dir entries,
    // which usually raises net at the same DD budget; ties prefer fewer slots
    const cands = [];
    for (const cap of [1, 2, 3]) {
      if (runs >= maxRuns) break;
      cands.push(await fitQty(best1.inputs, cap));
    }
    cands.sort((a, b2) => {
      const fa = a.hard <= 0, fb2 = b2.hard <= 0;
      if (fa !== fb2) return fa ? -1 : 1;
      if (Math.abs(a.stats.netProfitPct - b2.stats.netProfitPct) > 1e-9) return b2.stats.netProfitPct - a.stats.netProfitPct;
      return (a.maxpos || 1) - (b2.maxpos || 1);
    });
    final = cands[0] || null;
  }
  if (!final) final = { inputs: best1.inputs, qty: 1, maxpos: 1, stats: baseRun.stats, hard: hardPen(goal, baseRun.stats) };

  // report the better of (budget-filled config) and any direct hit found along the way
  const bestFinal = final;
  return {
    baseline: base,
    best: Object.assign({}, bestFinal, { est: best1.est, ref: best1 }),
    runs, ms: Date.now() - t0,
    achieved: hardPen(goal, bestFinal.stats) <= 0,
    knobs: knobs.map(k => k.title),
  };

}
/* ---------------- sensitivity (fallback answer) ---------------- */
function sensitivity(comp, data) {
  const rows = [];
  const knobs = numericInputs(comp);
  const baseRun = rt.runBacktest(comp, data, {}, null);
  const baseNet = baseRun.stats.netProfitPct, baseDD = baseRun.stats.maxDDPct;
  for (const k of knobs) {
    const b = boxFor(k);
    let bestNet = null, minDD = null;
    const span = b.hi - b.lo;
    for (let i = 0; i <= 8; i++) {
      const v = clampParam(k, b.lo + span * i / 8);
      const inputs = { [k.title]: v };
      const r = rt.runBacktest(comp, data, inputs, null);
      if (!bestNet || r.stats.netProfitPct > bestNet.net) bestNet = { v, net: r.stats.netProfitPct };
      if (!minDD || r.stats.maxDDPct < minDD.dd) minDD = { v, dd: r.stats.maxDDPct };
    }
    rows.push({ name: k.title, bestNet, minDD, baseNet, baseDD });
  }
  const qtyRows = [];
  for (const q of [3, 5, 10, 15, 25, 50, 75, 100]) {
    const r = rt.runBacktest(comp, data, {}, { default_qty_value: q });
    qtyRows.push({ qty: q, net: r.stats.netProfitPct, dd: r.stats.maxDDPct });
  }
  return { rows, qtyRows, baseNet, baseDD };
}

/* ---------------- reply text ---------------- */
const fmt = (v, d) => (v == null || !Number.isFinite(v) ? '-' : Number(v).toFixed(d == null ? 2 : d));

function statsLine(s) {
  return `net ${fmt(s.netProfitPct, 2)}% | dd ${fmt(s.maxDDPct, 2)}% | ${s.trades} trades | pf ${fmt(Math.min(s.profitFactor, 99), 2)} | win ${fmt(s.winRate * 100, 1)}%`;
}

function helpText(goal) {
  const t = String(goal && goal.__msg || '').toLowerCase().trim();
  if (/^(hi|hey|hello)\b/.test(t)) {
    return `QUANT online. I re-run the WASM backtest for everything I tell you.\nTell me a target, e.g.\n  max drawdown 5%\n  max dd 10% with at least 20 trades and win rate 50%\n  position size 8%, profit factor over 1.5\n  stats\nI tune the strategy inputs + position size until the constraints pass.`;
  }
  return `I did not find a numeric target in that.\nI understand targets like:\n  max drawdown 5%          (hard cap on drawdown)\n  at least 20 trades       (trade count floor)\n  win rate 50%             (floor)\n  profit factor 1.5        (floor)\n  net profit 10%           (floor)\n  position size 8%         (fix the sizing knob)\nSay "stats" for the current numbers, or just give me a target and I optimize.`;
}

const WELCOME = 'QUANT online. Give me a target and I tune inputs + position size to hit it, verifying every candidate against the backtest.\nExamples:\n  max drawdown 5%\n  max dd 10% with at least 20 trades\n  stats\n';

function targetLine(goal) {
  const parts = [];
  if (goal.ddMax != null) parts.push(`max drawdown <= ${goal.ddMax}%`);
  if (goal.minTrades != null) parts.push(`trades >= ${goal.minTrades}`);
  if (goal.minWr != null) parts.push(`win rate >= ${goal.minWr}%`);
  if (goal.minPf != null) parts.push(`profit factor >= ${goal.minPf}`);
  if (goal.minNet != null) parts.push(`net >= ${goal.minNet}%`);
  if (goal.fixedQty != null) parts.push(`position size fixed ${goal.fixedQty}%`);
  if (goal.maxPos != null) parts.push(`max ${goal.maxPos} concurrent position${goal.maxPos > 1 ? 's' : ''}`);
  return parts.join(' + ') || 'n/a';
}

function changesLine(baseline, best, knobs) {
  const out = [];
  for (const name of knobs) {
    const a = baseline.inputs[name] != null ? baseline.inputs[name] : null;
    const b = best.inputs[name];
    if (a == null) continue;
    if (b != null && Math.abs(b - a) > 1e-9) out.push(`${name} ${a} -> ${b}`);
  }
  if (best.stats && Math.abs((best.qty || 0) - (baseline.qty || 0)) > 1e-9) {
    out.unshift(`sizing ${baseline.qty}% -> ${best.qty}%`);
  }
  if (best.maxpos != null && best.maxpos > 1) out.push(`max positions ${best.maxpos}`);
  return out.length ? out.join(', ') : 'inputs already near-optimal';
}

function sharpeOf(equity, data) {
  const n = equity.length;
  if (n < 30) return null;
  let avgDt = 0;
  const m = Math.min(200, n - 1);
  for (let k = 1; k <= m; k++) avgDt += (data.t[k] - data.t[k - 1]) / m;
  if (!(avgDt > 0)) return null;
  const perYear = (365 * 86400) / avgDt;
  const rets = [];
  for (let k = 1; k < n; k++) {
    const a = equity[k - 1], b = equity[k];
    if (a > 0 && b > 0) rets.push(b / a - 1);
  }
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((x, y) => x + (y - mean) * (y - mean), 0) / rets.length);
  if (!(sd > 0)) return null;
  return (mean / sd) * Math.sqrt(perYear);
}

function biggestDDWindow(equity, n) {
  let peak = -Infinity, peakI = 0, worst = 0, w0 = 0, w1 = 0, curPeak = -Infinity, curPeakI = 0;
  for (let k = 0; k < n; k++) {
    const v = equity[k];
    if (v > curPeak) { curPeak = v; curPeakI = k; }
    const dd = curPeak > 0 ? (curPeak - v) / curPeak : 0;
    if (dd > worst) { worst = dd; w0 = curPeakI; w1 = k; }
  }
  return { pct: worst * 100, from: w0, to: w1 };
}

module.exports = { parseGoal, tune, sensitivity, helpText, WELCOME, targetLine, changesLine, statsLine, sharpeOf, biggestDDWindow, fmt };
