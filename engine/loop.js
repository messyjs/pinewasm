// PineWASM Desktop - QUANT LLM LOOP (Quant 2.0 backtest-agent-loop, merged from
// the 2026-11-24 ANATOMY build: baseline -> LLM proposes an improved strategy()
// source -> THE SAME engine runs it -> score -> refine -> repeat, compile self-heal.
// Here the verifying engine is PineWASM's own WASM pipeline (11ms per run).
'use strict';
const fs = require('fs');
const rt = require('./runtime');

const LLM_ACC_FILE = 'D:/AI Drive/Quant/accounts.json';
const LLM_CHAIN = ['glm-5.3-flash:cloud', 'glm-5.3:cloud', 'deepseek-v4-pro:cloud', 'glm-5.2:cloud'];

async function llmChat(messages, timeoutMs) {
  let accounts = [];
  try { accounts = JSON.parse(fs.readFileSync(LLM_ACC_FILE, 'utf8')).filter(a => a && a.url); } catch { }
  if (!accounts.length) throw new Error('no llm accounts configured (D:/AI Drive/Quant/accounts.json)');
  const tried = [];
  for (const acct of accounts) {
    for (const model of [acct.model, ...LLM_CHAIN].filter(Boolean).filter((m, i, a) => a.indexOf(m) === i)) {
      tried.push(acct.id + '/' + model);
      try {
        const r = await fetch(String(acct.url).replace(/\/$/, '') + '/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, stream: false, think: false, options: { temperature: 0.35, num_predict: 4096 } }),
          signal: AbortSignal.timeout(timeoutMs || 150000),
        });
        if (!r.ok) continue;
        const d = await r.json();
        const c = (d?.message?.content || '').trim();
        if (c) return c;
      } catch { }
    }
  }
  throw new Error('no llm responded (tried ' + tried.slice(0, 4).join(', ') + ')');
}

const FENCES = /```(?:pine|javascript|js)?\s*([\s\S]*?)```/i;
function extractSource(text) {
  let src = (FENCES.exec(text || '') || [null, text || ''])[1];
  src = String(src).trim();
  if (/```/.test(src)) {
    const parts = src.split(/```/).map(s => s.trim()).filter(s => /\bstrategy\s*\(/.test(s));
    if (parts.length) src = parts.sort((a, b) => b.length - a.length)[0];
  }
  return src;
}

// composite score (same as ANATOMY loop): net% + pf bonus - dd penalty
function scoreOf(stats) {
  const netPct = Number.isFinite(stats.netProfitPct) ? stats.netProfitPct : 0;
  let pf = stats.profitFactor;
  if (!Number.isFinite(pf)) pf = stats.netProfitPct > 0 ? 99 : null;
  const pfBonus = pf != null ? (Math.min(pf, 10) - 1) * 8 : -32;
  const ddPct = Number(stats.maxDDPct) || 0;
  return Math.round((netPct + pfBonus - ddPct * 0.6) * 100) / 100;
}

// target-aware: violations of the user's stated constraints cost score
function violationOf(goal, stats) {
  let v = 0;
  if (goal.ddMax != null) v += Math.max(0, stats.maxDDPct - goal.ddMax);
  if (goal.minTrades != null) v += Math.max(0, goal.minTrades - stats.trades);
  if (goal.minWr != null) v += Math.max(0, goal.minWr - stats.winRate * 100);
  if (goal.minPf != null) v += Math.max(0, goal.minPf - Math.min(stats.profitFactor, 10));
  if (goal.minNet != null) v += Math.max(0, goal.minNet - stats.netProfitPct);
  return v;
}

const SYSTEM_PROMPT = [
  'You are the QUANT loop inside PineWASM Desktop. You get a Pine v5/v6 strategy() script',
  'and its backtest report from the PineWASM WASM engine (same runs as the app UI).',
  'Propose an IMPROVED version of the SAME strategy, usually ONE meaningful change per round:',
  'tighten/loosen a filter, retune a length, fix the exit, add a trend filter that fits the',
  'losing trades. Keep position sizing and capital blocks unchanged, no lookahead, no repainting.',
  'The compiler supports ONLY this subset - stay inside it:',
  '  ta: sma ema rma wma rsi tr trueRange atr stdev highest lowest change mom cum',
  '     crossover crossunder cross valuewhen',
  '  math: abs floor ceil sqrt round max min sum avg pow log exp sign pi e',
  '  na(x) nz(x,y) if/else for loops, user functions, history x[n], ternary, and/or/not',
  '  strategy: entry close close_all exit(stop=,limit=) position_size position_avg_price',
  '  plot plotshape hline input.int/input.float/input.bool',
  'NOT supported (do NOT use): macd, bb, supertrend, linreg, vwap, stoch, security(),',
  'labels, tables, alert(), varip intrabar, strings in logic.',
  'Return ONLY the full Pine source in one fenced code block. No prose.',
].join('\n');

function reportForLLM(stats, trades) {
  const cnt = {};
  for (const t of trades) cnt[t.reason] = (cnt[t.reason] || 0) + 1;
  const worst = trades.slice().sort((a, b2) => a.pnl - b2.pnl).slice(0, 3)
    .map(t => `${t.dir > 0 ? 'LONG' : 'SHORT'} in ${t.entryPx.toFixed(2)} out ${Number(t.exitPx).toFixed(2)} (${t.reason}) pnl ${t.pnl.toFixed(0)}`);
  return {
    netPct: Number(stats.netProfitPct.toFixed(2)), maxDDPct: Number(stats.maxDDPct.toFixed(2)),
    pf: Number.isFinite(stats.profitFactor) ? Number(stats.profitFactor.toFixed(2)) : 'inf',
    winRatePct: Number((stats.winRate * 100).toFixed(1)), trades: stats.trades,
    avgWin: Number(stats.avgTrade && stats.avgTrade.toFixed ? stats.avgTrade.toFixed(1) : stats.avgTrade) || undefined,
    commissions: Math.round(stats.commissions),
    exits: cnt,
    worstTrades: worst,
  };
}

async function runLoop(baseSrc, data, goal, opts) {
  opts = opts || {};
  const iterations = Math.min(Math.max(opts.iterations || 4, 1), 8);
  if (!opts.deadline) opts.deadline = 480000;
  const t0 = Date.now();
  const out = { ok: false, rounds: [], best: null, base: null, error: null };

  const baselineComp = await rt.compileScript(baseSrc);
  if (!baselineComp.ok) {
    out.error = 'baseline script does not compile: ' + (baselineComp.errs || []).map(e => 'L' + e.line + ' ' + e.msg).join('; ');
    return out;
  }
  const baseRun = rt.runBacktest(baselineComp, data, goal.__inputs || {}, null);
  const baseRec = { i: 0, kind: 'baseline', ok: true, stats: baseRun.stats, score: scoreOf(baseRun.stats), source: baseSrc };
  out.rounds.push(baseRec);
  out.base = baseRec;
  if (baseRun.stats.trades === 0) { out.error = 'baseline produced no trades on this data - nothing to improve'; return out; }

  let lastSource = baseSrc;
  let lastRun = baseRun;
  let best = { score: scoreOf(baseRun.stats), src: baseSrc, stats: baseRun.stats, i: 0 };
  let modelNote = '';
  let consecutiveFails = 0;

  for (let i = 1; i <= iterations; i++) {
    if (opts.deadline && Date.now() - t0 > opts.deadline) break;
    const userMsg = [
      goal.__msg && goal.__msg.trim() ? 'USER TARGET: ' + goal.__msg.trim() : '',
      'MARKET: ' + (opts.symbol || 'loaded data') + ' - bars: ' + data.c.length,
      modelNote ? 'NOTE: ' + modelNote : '',
      'CURRENT REPORT (PineWASM engine):',
      JSON.stringify(reportForLLM(lastRun.stats, lastRun.trades), null, 1),
      'CURRENT PINE SOURCE:',
      '```pine', lastSource.trim(), '```',
      'Return the improved full Pine source now (one fenced block, no prose).',
    ].filter(Boolean).join('\n\n');

    let proposed = '';
    try {
      const raw = await llmChat([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userMsg }]);
      proposed = extractSource(raw);
      if (!proposed || !/\bstrategy\s*\(/.test(proposed)) throw new Error('reply carried no strategy() source');
    } catch (e) {
      out.rounds.push({ i, kind: 'model', ok: false, error: 'llm: ' + String(e.message || e).slice(0, 160) });
      modelNote = 'The last request failed: ' + String(e.message || e).slice(0, 120) + ' - return the FULL Pine source in ONE fenced block, nothing else.';
      continue;
    }

    // compile + run; self-heal on compile errors (up to 2 heal attempts)
    let healed = 0;
    let lastErr = '';
    while (true) {
      const comp = await rt.compileScript(proposed);
      if (!comp.ok) {
        lastErr = (comp.errs || []).map(e2 => 'L' + e2.line + ': ' + e2.msg).join(' | ');
        if (++healed <= 2 && proposed !== lastSource) {
          try {
            const raw = await llmChat([
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: 'YOUR LAST VERSION FAILED TO COMPILE. Engine errors: ' + lastErr + '\nFix it and return the FULL corrected Pine source in one fenced block, no prose.\n\nCURRENT SOURCE:\n```pine\n' + proposed.trim() + '\n```' },
            ]);
            const p2 = extractSource(raw);
            if (!p2 || !/\bstrategy\s*\(/.test(p2)) throw new Error('no source');
            proposed = p2;
            continue;
          } catch (e2) {
            lastErr = 'self-heal failed: ' + String(e2.message || e2).slice(0, 100);
          }
        }
        break;
      }
      const run = rt.runBacktest(comp, data, goal.__inputs || {}, null);
      const rec = {
        i, kind: 'agent', ok: true, stats: run.stats, source: proposed,
        score: scoreOf(run.stats), violations: violationOf(goal, run.stats),
        errors: null, trades: run.trades,
      };
      out.rounds.push(rec);
      if (rec.score > best.score || (Math.abs(rec.score - best.score) < 1e-9 && rec.violations < (best.violations == null ? 1e9 : best.violations))) {
        best = { score: rec.score, src: proposed, stats: run.stats, i, violations: rec.violations };
      }
      lastSource = proposed;
      lastRun = run;
      consecutiveFails = 0;
      break;
    }
    if (lastErr) {
      consecutiveFails++;
      out.rounds.push({ i, kind: 'compile', ok: false, error: lastErr });
      modelNote = 'YOUR LAST VERSION FAILED TO COMPILE. Engine errors: ' + lastErr + ' - fix it and return the full corrected Pine source.';
      if (consecutiveFails >= 2) { out.error = 'loop aborted - engine refused 2 proposals in a row'; break; }
    }
  }

  out.best = { score: best.score, source: best.src, stats: best.stats, round: best.i };
  out.ok = true;
  out.ms = Date.now() - t0;
  return out;
}

module.exports = { runLoop, scoreOf, violationOf, extractSource, llmChat, reportForLLM };
