// PineWASM Desktop - semantic pass + WebAssembly (WAT) emitter
// Lowers Pine Script AST into WAT. History is explicit: every series lives in
// linear memory; x[k] is a bounds-checked load. na == NaN.
'use strict';

const NAN_WAT = '(f64.const nan)';

const HOST_IMPORTS = {
  ta_sma:    '(param i32 i32 i32) (result f64)',
  ta_ema:    '(param i32 i32 i32 i32) (result f64)',
  ta_rma:    '(param i32 i32 i32 i32) (result f64)',
  ta_wma:    '(param i32 i32 i32) (result f64)',
  ta_rsi:    '(param i32 i32 i32 i32) (result f64)',
  ta_tr:     '(param i32) (result f64)',
  ta_atr:    '(param i32 i32 i32) (result f64)',
  ta_stdev:  '(param i32 i32 i32) (result f64)',
  ta_highest:'(param i32 i32 i32) (result f64)',
  ta_lowest: '(param i32 i32 i32) (result f64)',
  ta_change: '(param i32 i32) (result f64)',
  ta_mom:    '(param i32 i32 i32) (result f64)',
  ta_crossover:  '(param i32 i32 i32) (result f64)',
  ta_crossunder: '(param i32 i32 i32) (result f64)',
  ta_cum:    '(param i32 i32 i32) (result f64)',
  ta_valuewhen: '(param i32 i32 i32 i32) (result f64)',
  math_log:  '(param f64) (result f64)',
  math_exp:  '(param f64) (result f64)',
  strat_pos: '(param i32) (result f64)',
  strat_avg: '(param i32) (result f64)',
  strat_entry: '(param i32 i32 f64)',
  strat_entryq: '(param i32 i32 f64 f64)',
  strat_close:  '(param i32 i32)',
  strat_exit:   '(param i32 i32 i32 f64 f64)',
  plot:      '(param i32 i32 f64)',
  plotshape: '(param i32 i32 f64 i32 i32)',
  before_bar: '(param i32)',
  after_bar: '(param i32)',
};

const BUILTIN_ORDER = ['open', 'high', 'low', 'close', 'volume', 'time'];
const BUILTIN_IDX = { open: 0, high: 1, low: 2, close: 3, volume: 4, time: 5 };
const HL2_IDX = 6;

const COLOR_MAP = {
  red: 0, maroon: 0, green: 1, lime: 1, olive: 1, orange: 1, yellow: 3,
  blue: 2, aqua: 2, teal: 2, navy: 2, white: 3, silver: 4, gray: 4, grey: 4,
  purple: 4, fuchsia: 4, black: 3,
};
const ENUM_VALS = {
  'strategy.long': 1, 'strategy.short': -1,
  'strategy.percent_of_equity': 0, 'strategy.fixed': 1,
  'strategy.commission.percent': 0, 'strategy.commission.cash_per_order': 1,
};

function dotted(e) {
  if (!e) return '';
  if (e.k === 'enum') return dotted(e.base) + '.' + e.name;
  if (e.k === 'ident') return e.name;
  return '';
}

// --- layout ------------------------------------------------------------------
// memory: [params: nParams * 8] [open high low close volume time hl2 : 7 arrays x nbars x 8] [series: nSeries x nbars x 8]
function layoutFor(nParams, nSeries) {
  const paramsBase = 0;
  const dataBase = 8 * nParams;
  const hl2Off = dataBase + 8 * 6;
  const seriesBase = dataBase + 8 * 7;
  return { paramsBase, dataBase, hl2Off, seriesBase, nParams, nSeries };
}

class Ctx {
  constructor() {
    this.errs = []; this.warns = [];
    this.series = []; this.seriesIdx = new Map();
    this.persistIdx = new Map();
    this.inputs = [];
    this.strings = []; this.stringIdx = new Map();
    this.stateCount = 0;
    this.plots = []; this.shapes = []; this.hlines = [];
    this.plotSeq = 0;
    this.site = 0;
    this.hoistNaFill = [];
    this.fPool = []; for (let k = 23; k >= 0; k--) this.fPool.push('$f' + k);
    this.iPool = []; for (let k = 15; k >= 0; k--) this.iPool.push('$i' + k);
    this.meta = { title: 'PineWASM Script', overlay: true, isStrategy: false,
      default_qty_type: 0, default_qty_value: 10, commission_type: 0,
      commission_value: 0, capital: 100000, pyramiding: 0 };
  }
  addSeries(name, persist) {
    if (this.seriesIdx.has(name)) return this.seriesIdx.get(name);
    const idx = this.series.length;
    this.series.push({ name, persist: !!persist });
    this.seriesIdx.set(name, idx);
    if (persist) this.persistIdx.set(name, this.persistIdx.size);
    return idx;
  }
  intern(s) {
    if (this.stringIdx.has(s)) return this.stringIdx.get(s);
    const id = this.strings.length;
    this.strings.push(s); this.stringIdx.set(s, id);
    return id;
  }
  nextState() { return this.stateCount++; }
  allocF() { if (!this.fPool.length) throw new Error('expr depth: f64 locals exhausted'); return this.fPool.pop(); }
  freeF(n) { if (n) this.fPool.push(n); }
  allocI() { if (!this.iPool.length) throw new Error('expr depth: i32 locals exhausted'); return this.iPool.pop(); }
  freeI(n) { if (n) this.iPool.push(n); }
}

// --- function inlining --------------------------------------------------------
function collectDeclared(stmts, set) {
  for (const s of stmts) {
    if (s.kind === 'declare' || s.kind === 'assign') set.add(s.name);
    if (s.kind === 'for') set.add(s.ivar);
    if (s.kind === 'if') { collectDeclared(s.then || [], set); collectDeclared(s.else || [], set); }
    if (s.kind === 'for') collectDeclared(s.body || [], set);
  }
}

function renameExpr(e, rmap) {
  if (!e || typeof e !== 'object') return e;
  if (e.k === 'ident') return rmap.has(e.name) ? { k: 'ident', name: rmap.get(e.name), line: e.line } : e;
  const out = Object.assign({}, e);
  ['l', 'r', 'c', 'a', 'b', 'e'].forEach(k => { if (out[k]) out[k] = renameExpr(out[k], rmap); });
  if (out.idx) out.idx = renameExpr(out.idx, rmap);
  if (out.k === 'call') {
    out.args = (out.args || []).map(a => renameExpr(a, rmap));
    const nk = {}; for (const kk of Object.keys(out.kw || {})) nk[kk] = renameExpr(out.kw[kk], rmap);
    out.kw = nk;
  }
  return out;
}

function isBuiltinCall(expr) {
  if (!expr || expr.k !== 'call') return false;
  return /^(plot|plotshape|plotchar|hline|bgcolor|fill|alertcondition|strategy\.|indicator$|strategy$)/.test(expr.name);
}

function lowerList(stmts, funcs, ctx, active) {
  const out = [];
  for (const s of stmts) {
    out.push(...lowerStmt(s, funcs, ctx, active));
  }
  return out;
}

function lowerStmt(s, funcs, ctx, active) {
  if (s.kind === 'func') return [];
  if (s.kind === 'declare' || s.kind === 'assign') {
    const r = lowerHoist(s.expr, funcs, ctx, active, 0);
    return [...r.pre, Object.assign({}, s, { expr: r.e })];
  }
  if (s.kind === 'call') {
    const r = lowerHoist(s.expr, funcs, ctx, active, 0);
    return [...r.pre, { kind: 'call', expr: r.e, line: s.line }];
  }
  if (s.kind === 'if') {
    const rc = lowerHoist(s.cond, funcs, ctx, active, 0);
    return [...rc.pre, Object.assign({}, s, { cond: rc.e,
      then: lowerList(s.then || [], funcs, ctx, active),
      else: lowerList(s.else || [], funcs, ctx, active) })];
  }
  if (s.kind === 'for') {
    const rf = lowerHoist(s.from, funcs, ctx, active, 0);
    const rt = lowerHoist(s.to, funcs, ctx, active, 0);
    const rb = s.by ? lowerHoist(s.by, funcs, ctx, active, 0) : null;
    return [...rf.pre, ...rt.pre, ...(rb ? rb.pre : []),
      Object.assign({}, s, { from: rf.e, to: rt.e, by: rb ? rb.e : null,
        body: lowerList(s.body || [], funcs, ctx, active) })];
  }
  return [s];
}

// walk expr tree; inline user-function calls into pre-stmts at statement level
function lowerHoist(e, funcs, ctx, active, depth) {
  if (!e || typeof e !== 'object' || depth > 40) return { pre: [], e };
  const pre = [];
  if (e.k === 'ident' || e.k === 'num' || e.k === 'na' || e.k === 'str') return { pre, e };
  if (e.k === 'hist') {
    const ridx = lowerHoist(e.idx, funcs, ctx, active, depth + 1);
    pre.push(...ridx.pre);
    let base = e.e;
    if (e.e && e.e.k !== 'ident') {
      const inner = lowerHoist(e.e, funcs, ctx, active, depth + 1);
      pre.push(...inner.pre);
      const tname = `ht${ctx.site++}_t`;
      pre.push({ kind: 'declare', persist: false, name: tname, expr: inner.e, line: e.line || 0 });
      ctx.hoistNaFill.push(tname);
      base = { k: 'ident', name: tname };
    } else base = e.e;
    return { pre, e: { k: 'hist', e: base, idx: ridx.e, line: e.line } };
  }
  if (e.k === 'enum') return { pre, e };
  if (e.k === 'call') {
    // children first
    const args = [];
    for (const a of (e.args || [])) { const r = lowerHoist(a, funcs, ctx, active, depth + 1); pre.push(...r.pre); args.push(r.e); }
    const kwn = {};
    for (const kk of Object.keys(e.kw || {})) { const r = lowerHoist(e.kw[kk], funcs, ctx, active, depth + 1); pre.push(...r.pre); kwn[kk] = r.e; }
    const f = funcs[e.name];
    if (!f || active.has(e.name)) return { pre, e: Object.assign({}, e, { args, kw: kwn }) };
    if (depth > 24) { ctx.errs.push({ line: e.line || 0, msg: 'inline depth exceeded: ' + e.name }); return { pre, e: { k: 'num', v: NaN } }; }
    const site = ctx.site++;
    const pfx = `f${site}_`;
    const rmap = new Map();
    f.params.forEach(p => rmap.set(p.name, pfx + p.name));
    const declared = new Set();
    const bodySrc = (f.body && f.body.length) ? f.body : (f.expr != null ? [{ kind: 'call', expr: f.expr, line: 0 }] : []);
    collectDeclared(bodySrc, declared);
    for (const d of declared) if (!rmap.has(d)) rmap.set(d, pfx + d);
    f.params.forEach((p, i2) => {
      const arg = args[i2] !== undefined ? args[i2] : (p.def || { k: 'num', v: NaN });
      pre.push({ kind: 'declare', persist: false, name: rmap.get(p.name), expr: renameExpr(arg, rmap), line: e.line || 0 });
    });
    let body = JSON.parse(JSON.stringify(bodySrc)).map(s2 => {
      if (s2.kind === 'declare') s2.name = rmap.get(s2.name) || s2.name;
      if (s2.kind === 'assign') s2.name = rmap.get(s2.name) || s2.name;
      if (s2.kind === 'for') s2.ivar = rmap.get(s2.ivar) || s2.ivar;
      return s2;
    });
    body = renameStmtList(body, rmap);
    // last expression statement -> return value
    const retName = pfx + '_retv';
    let lastExpr = null;
    if (body.length && body[body.length - 1].kind === 'call' && !isBuiltinCall(body[body.length - 1].expr)) {
      lastExpr = body[body.length - 1].expr;
      body.pop();
    }
    const innerActive = new Set([...active, e.name]);
    pre.push(...lowerList(body, funcs, ctx, innerActive));
    if (lastExpr) {
      const r = lowerHoist(lastExpr, funcs, ctx, innerActive, depth + 1);
      pre.push(...r.pre);
      pre.push({ kind: 'declare', persist: false, name: retName, expr: r.e, line: e.line || 0 });
    } else if (!(f.body && f.body.length)) {
      // single-expression function produced declare via body path? ensure exists
      pre.push({ kind: 'declare', persist: false, name: retName, expr: { k: 'num', v: NaN }, line: 0 });
    }
    return { pre, e: { k: 'ident', name: retName } };
  }
  // generic composites
  const out = Object.assign({}, e);
  ['l', 'r', 'c', 'a', 'b', 'e'].forEach(k => {
    if (out[k]) { const r = lowerHoist(out[k], funcs, ctx, active, depth + 1); pre.push(...r.pre); out[k] = r.e; }
  });
  return { pre, e: out };
}

function renameStmtList(list, rmap) {
  const out = [];
  for (const s of list) {
    const s2 = Object.assign({}, s);
    if (s2.cond) s2.cond = renameExpr(s2.cond, rmap);
    if (s2.expr) s2.expr = renameExpr(s2.expr, rmap);
    if (s2.from) s2.from = renameExpr(s2.from, rmap);
    if (s2.to) s2.to = renameExpr(s2.to, rmap);
    if (s2.by) s2.by = renameExpr(s2.by, rmap);
    if (s2.kind === 'if') { s2.then = renameStmtList(s2.then || [], rmap); s2.else = renameStmtList(s2.else || [], rmap); }
    if (s2.kind === 'for') s2.body = renameStmtList(s2.body || [], rmap);
    out.push(s2);
  }
  return out;
}

// --- WAT emitter --------------------------------------------------------------
class Compiler {
  constructor(program, ctx, layout) {
    this.ast = program; this.ctx = ctx;
    this.layout = layout || { paramsBase: 0, dataBase: 0, seriesBase: 0 };
  }

  emit(line) { this.wat.push(line); }

  compile() {
    const ctx = this.ctx;
    const funcs = {};
    for (const s of this.ast) if (s.kind === 'func') funcs[s.name] = s;
    // declaration
    for (const s of this.ast) {
      if (s.kind === 'call' && s.expr && /^(indicator|strategy)$/.test(s.expr.name)) {
        const a = s.expr, m = ctx.meta;
        if (a.args[0] && a.args[0].k === 'str') m.title = a.args[0].v;
        m.isStrategy = a.name === 'strategy';
        m.overlay = a.kw.overlay ? truthyConst(a.kw.overlay) : m.isStrategy;
        if (a.kw.default_qty_type && a.kw.default_qty_type.k === 'enum') m.default_qty_type = ENUM_VALS[dotted(a.kw.default_qty_type)] ?? 0;
        if (a.kw.default_qty_value && a.kw.default_qty_value.k === 'num') m.default_qty_value = a.kw.default_qty_value.v;
        if (a.kw.commission_type && a.kw.commission_type.k === 'enum') m.commission_type = ENUM_VALS[dotted(a.kw.commission_type)] ?? 0;
        if (a.kw.commission_value && a.kw.commission_value.k === 'num') m.commission_value = a.kw.commission_value.v;
        if (a.kw.capital && typeof a.kw.capital.v === 'number') m.capital = a.kw.capital.v;
        if (a.kw.capital && a.kw.capital.k === 'num') m.capital = a.kw.capital.v;
        if (a.kw.pyramiding && a.kw.pyramiding.k === 'num') m.pyramiding = a.kw.pyramiding.v;
      }
    }
    const prog = lowerList(this.ast.filter(s => s.kind !== 'func'), funcs, ctx, new Set());
    this.prog = prog;
    this.wat = [];
    for (const s of prog) this.compileStmt(s);
    return { wat: this.wat.join('\n'), ctx };
  }

  // ---------- statements ----------
  compileStmt(s) {
    const ctx = this.ctx;
    if (s.kind === 'declare') {
      ctx.addSeries(s.name, s.persist);
      const idx = ctx.seriesIdx.get(s.name);
      const store = (v) => this.emit(`(f64.store (i32.add (i32.const ${ctx.seriesBase + idx * 8}) (i32.mul (i32.const 8) (local.get $bar))) ${v})`);
      if (s.persist) {
        const fi = ctx.persistIdx.get(s.name);
        this.emit(`;; var ${s.name}`);
        this.emit(`(block $vinit`);
        this.emit(`(br_if $vinit (i32.ne (global.get $g_flag${fi}) (i32.const 0)))`);
        store(this.compileF64(s.expr));
        this.emit(`(global.set $g_flag${fi} (i32.const 1))`);
        this.emit(`)`);
      } else {
        this.emit(`;; ${s.name} =`);
        store(this.compileF64(s.expr));
      }
      return;
    }
    if (s.kind === 'assign') {
      const idx = ctx.seriesIdx.get(s.name);
      if (idx === undefined) { ctx.errs.push({ line: s.line || 0, msg: 'assign to undeclared: ' + s.name }); return; }
      this.emit(`;; ${s.name} :=`);
      this.emit(`(f64.store (i32.add (i32.const ${ctx.seriesBase + idx * 8}) (i32.mul (i32.const 8) (local.get $bar))) ${this.compileF64(s.expr)})`);
      return;
    }
    if (s.kind === 'if') {
      this.emit(`(block $ifend`);
      this.emit(`(block $elseblk`);
      this.emit(`(br_if $elseblk (i32.eqz ${this.compileBool(s.cond)}))`);
      for (const ss of (s.then || [])) this.compileStmt(ss);
      this.emit(`(br $ifend)`);
      this.emit(`)`);
      for (const ss of (s.else || [])) this.compileStmt(ss);
      this.emit(`)`);
      return;
    }
    if (s.kind === 'for') {
      const ctx2 = ctx;
      const ivIdx = ctx2.seriesIdx.has(s.ivar) ? ctx2.seriesIdx.get(s.ivar) : ctx2.addSeries(s.ivar, false);
      const ivLocal = `$fv_${ivIdx % 16}`;
      const byWat = s.by ? this.compileF64(s.by) : '(f64.const 1)';
      const prevLoop = this.loopVar;
      this.loopVar = { name: s.ivar, local: ivLocal };
      this.emit(`;; for ${s.ivar}`);
      this.emit(`(local.set ${ivLocal} ${this.compileF64(s.from)})`);
      this.emit(`(block $fexit`);
      this.emit(`(loop $floop`);
      this.emit(`(f64.store (i32.add (i32.const ${ctx2.seriesBase + ivIdx * 8}) (i32.mul (i32.const 8) (local.get $bar))) (local.get ${ivLocal}))`);
      this.emit(`(br_if $fexit (i32.gt_s (local.get ${ivLocal}) (i32.trunc_f64_s ${this.compileF64(s.to)})))`);
      for (const ss of (s.body || [])) this.compileStmt(ss);
      this.emit(`(local.set ${ivLocal} (f64.add (local.get ${ivLocal}) ${byWat}))`);
      this.emit(`(br $floop)`);
      this.emit(`))`);
      this.loopVar = prevLoop;
      return;
    }
    if (s.kind === 'call') { this.compileCallStmt(s.expr, s.line); return; }
  }

  compileCallStmt(e, line) {
    const ctx = this.ctx;
    const name = e.k === 'call' ? e.name : null;
    if (!name) { this.compileF64(e); return; }
    if (name === 'plot') {
      const pid = ctx.plotSeq++;
      const title = (e.args[1] && e.args[1].k === 'str') ? e.args[1].v : (e.kw.title && e.kw.title.k === 'str' ? e.kw.title.v : 'plot' + pid);
      const colorId = (e.kw.color && e.kw.color.k === 'enum') ? (COLOR_MAP[dotted(e.kw.color).split('.')[1]] ?? 1) : (pid % 2 ? 1 : 2);
      ctx.plots.push({ pid, title, colorId });
      this.emit(`(call $e.plot (local.get $bar) (i32.const ${pid}) ${this.compileF64(e.args[0] || { k: 'na' })})`);
      return;
    }
    if (name === 'plotshape' || name === 'plotchar') {
      const pid = ctx.plotSeq++;
      const colorId = (e.kw.color && e.kw.color.k === 'enum') ? (COLOR_MAP[dotted(e.kw.color).split('.')[1]] ?? 1) : 1;
      const dloc = e.kw.location && e.kw.location.k === 'enum' ? dotted(e.kw.location) : 'location.abovebar';
      const loc = /belowbar/.test(dloc) ? 0 : 1;
      ctx.shapes.push({ pid, colorId, loc, shape: e.kw.style && e.kw.style.k === 'enum' ? dotted(e.kw.style) : 'shape.triangleup' });
      this.emit(`(call $e.plotshape (local.get $bar) (i32.const ${pid}) ${this.compileF64(e.args[0])} (i32.const ${colorId}) (i32.const ${loc}))`);
      return;
    }
    if (name === 'hline') {
      const price = e.args[0] && e.args[0].k === 'num' ? e.args[0].v : NaN;
      const colorId = (e.kw.color && e.kw.color.k === 'enum') ? (COLOR_MAP[dotted(e.kw.color).split('.')[1]] ?? 4) : 4;
      ctx.hlines.push({ price, colorId });
      return;
    }
    if (name === 'bgcolor' || name === 'fill' || name === 'alertcondition' || name === 'barcolor') return;
    if (name === 'strategy.entry') {
      const sid = this.strId(e.args[0]);
      let dir = '(f64.const 1)';
      if (e.args[1] && e.args[1].k === 'enum') {
        const dv = ENUM_VALS[dotted(e.args[1])];
        dir = `(f64.const ${Number.isFinite(dv) ? dv : 1})`;
      }
      const qty = e.kw.qty || e.args[2];
      if (qty) this.emit(`(call $e.strat_entryq (local.get $bar) (i32.const ${sid}) ${dir} ${this.compileF64(qty)})`);
      else this.emit(`(call $e.strat_entry (local.get $bar) (i32.const ${sid}) ${dir})`);
      return;
    }
    if (name === 'strategy.close') {
      const sid = this.strId(e.args[0]);
      this.emit(`(call $e.strat_close (local.get $bar) (i32.const ${sid}))`);
      return;
    }
    if (name === 'strategy.close_all') {
      this.emit(`(call $e.strat_close (local.get $bar) (i32.const -2))`);
      return;
    }
    if (name === 'strategy.exit') {
      const sid = this.strId(e.args[0]);
      const fromExpr = (e.kw && e.kw.from_entry) || (e.args && e.args[1]);
      const fromSid = fromExpr ? this.strId(fromExpr) : sid;
      const stop = e.kw.stop ? this.compileF64(e.kw.stop) : NAN_WAT;
      const limit = e.kw.limit ? this.compileF64(e.kw.limit) : NAN_WAT;
      this.emit(`(call $e.strat_exit (local.get $bar) (i32.const ${sid}) (i32.const ${fromSid}) ${stop} ${limit})`);
      return;
    }
    ctx.warns.push({ line: line || 0, msg: 'statement ignored: ' + name });
    for (const a of (e.args || [])) this.compileF64(a);
  }

  strId(e) {
    if (e && e.k === 'str') return this.ctx.intern(e.v);
    if (e && e.k === 'ident') return this.ctx.intern(e.name);
    return this.ctx.intern('anon' + this.ctx.intern('__anon'));
  }

  // ---------- expressions ----------
  compileBool(e) {
    if (!e) return '(i32.const 1)';
    if (e.k === 'num') return `(i32.const ${e.v !== 0 ? 1 : 0})`;
    if (e.k === 'and') return `(i32.and ${this.compileBool(e.l)} ${this.compileBool(e.r)})`;
    if (e.k === 'or') return `(i32.or ${this.compileBool(e.l)} ${this.compileBool(e.r)})`;
    if (e.k === 'not') return `(i32.eqz ${this.compileBool(e.e)})`;
    if (e.k === 'bin' && ['==', '!=', '<', '<=', '>', '>='].includes(e.op)) {
      const op = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' }[e.op];
      return `(f64.${op} ${this.compileF64(e.l)} ${this.compileF64(e.r)})`;
    }
    const X = this.compileF64(e);
    return `(i32.and (f64.eq ${X} ${X}) (f64.ne ${X} (f64.const 0)))`;
  }

  compileF64(e) {
    const ctx = this.ctx;
    if (!e) return NAN_WAT;
    switch (e.k) {
      case 'num': {
        if (Number.isNaN(e.v)) return NAN_WAT;
        if (!Number.isFinite(e.v)) return `(f64.const ${e.v > 0 ? 'inf' : '-inf'})`;
        return `(f64.const ${e.v})`;
      }
      case 'na': return NAN_WAT;
      case 'str': return NAN_WAT;
      case 'enum': {
        const d = dotted(e);
        if (d === 'strategy.position_size') return '(call $e.strat_pos (local.get $bar))';
        if (d === 'strategy.position_avg_price') return '(call $e.strat_avg (local.get $bar))';
        if (d === 'math.pi') return '(f64.const 3.141592653589793)';
        if (d === 'math.e') return '(f64.const 2.718281828459045)';
        if (ENUM_VALS[d] !== undefined) return `(f64.const ${ENUM_VALS[d]})`;
        if (/^color\./.test(d)) return `(f64.const ${COLOR_MAP[d.split('.')[1]] || 4})`;
        return '(f64.const 0)';
      }
      case 'neg': return `(f64.neg ${this.compileF64(e.e)})`;
      case 'not': return `(f64.convert_i32_s (i32.eqz ${this.compileBool(e.e)}))`;
      case 'and': case 'or': return `(f64.convert_i32_s ${this.compileBool(e)})`;
      case 'bin': {
        const isCmp = ['==', '!=', '<', '<=', '>', '>='].includes(e.op);
        if (isCmp) return `(f64.convert_i32_s ${this.compileBool(e)})`;
        const L = this.compileF64(e.l), R = this.compileF64(e.r);
        if (e.op === '+') return `(f64.add ${L} ${R})`;
        if (e.op === '-') return `(f64.sub ${L} ${R})`;
        if (e.op === '*') return `(f64.mul ${L} ${R})`;
        if (e.op === '/') return `(call $fdiv ${L} ${R})`;
        if (e.op === '%') return `(call $fpmod ${L} ${R})`;
        return NAN_WAT;
      }
      case 'ter': {
        const lc = ctx.allocI(); const d = ctx.allocF();
        let wat;
        try {
          const C = this.compileBool(e.c);
          const A = this.compileF64(e.a);
          const B = this.compileF64(e.b);
          wat = `(block $t${ctx.site} (result f64)
(local.set ${lc} ${C})
(local.set ${d} ${A})
(local.set ${d} (select (result f64) (local.get ${d}) ${B} (local.get ${lc})))
(local.get ${d})
)`;
        } finally { ctx.freeF(d); ctx.freeI(lc); }
        return wat;
      }
      case 'hist': {
        let base;
        const n = e.e && e.e.name;
        if (e.e.k === 'ident') {
          if (BUILTIN_IDX[n] !== undefined) base = this.builtinBaseWat(BUILTIN_IDX[n]);
          else if (n === 'hl2') base = this.builtinBaseWat(HL2_IDX);
          else if (ctx.seriesIdx.has(n)) base = `(i32.const ${ctx.seriesBase + ctx.seriesIdx.get(n) * 8})`;
          else if (this.loopVar && this.loopVar.name === n) { ctx.errs.push({ line: e.line || 0, msg: 'history not supported on loop var' }); return NAN_WAT; }
          else if (n === 'strategy.position_size' || n === 'strategy.position_avg_price') { ctx.errs.push({ line: e.line || 0, msg: 'history not supported on ' + n }); return NAN_WAT; }
          else { ctx.errs.push({ line: e.line || 0, msg: 'history of unknown series: ' + n }); return NAN_WAT; }
        } else { ctx.errs.push({ line: e.line || 0, msg: 'history requires series identifier' }); return NAN_WAT; }
        return this.histWat(base, e.idx);
      }
      case 'ident': return this.compileIdent(e);
      case 'call': return this.compileCall(e);
      default: return NAN_WAT;
    }
  }

  chain(op, l, r) { return { k: 'bin', op, l, r }; }

  builtinBaseWat(idx) {
    const lay = this.layout;
    return `(i32.add (i32.const ${lay.dataBase}) (i32.mul (i32.const ${8 * idx}) (global.get $g_nb)))`;
  }

  compileIdent(e) {
    const ctx = this.ctx, n = e.name;
    const loadAt = base => `(f64.load (i32.add ${base} (i32.mul (i32.const 8) (local.get $bar))))`;
    if (BUILTIN_IDX[n] !== undefined) return loadAt(this.builtinBaseWat(BUILTIN_IDX[n]));
    if (n === 'hl2') return loadAt(this.builtinBaseWat(HL2_IDX));
    if (n === 'hlc3') return this.compileF64(this.chain('/', this.chain('+', { k: 'ident', name: 'high' }, this.chain('+', { k: 'ident', name: 'low' }, { k: 'ident', name: 'close' })), { k: 'num', v: 3 }));
    if (n === 'ohlc4') return this.compileF64(this.chain('/', this.chain('+', this.chain('+', { k: 'ident', name: 'open' }, { k: 'ident', name: 'high' }), this.chain('+', { k: 'ident', name: 'low' }, { k: 'ident', name: 'close' })), { k: 'num', v: 4 }));
    if (n === 'bar_index') return '(f64.convert_i32_u (local.get $bar))';
    if (n === 'last_bar_index') return '(f64.convert_i32_u (i32.sub (global.get $g_nb) (i32.const 1)))';
    if (n === 'true') return '(f64.const 1)';
    if (n === 'false') return '(f64.const 0)';
    if (n === 'na') return NAN_WAT;
    if (this.loopVar && this.loopVar.name === n) return `(local.get ${this.loopVar.local})`;
    if (n === 'strategy.position_size') return '(call $e.strat_pos (local.get $bar))';
    if (n === 'strategy.position_avg_price') return '(call $e.strat_avg (local.get $bar))';
    if (ctx.seriesIdx.has(n)) {
      const idx = ctx.seriesIdx.get(n);
      return `(f64.load (i32.add (i32.const ${ctx.seriesBase + idx * 8}) (i32.mul (i32.const 8) (local.get $bar))))`;
    }
    ctx.errs.push({ line: e.line || 0, msg: 'unknown identifier: ' + n });
    return NAN_WAT;
  }

  histWat(base, idxExpr) {
    const ctx = this.ctx;
    const lk = ctx.allocF(); const lb = ctx.allocI();
    let wat;
    try {
      const idxWat = this.compileF64(idxExpr);
      wat = `(block $hdone (result f64)
(block $hna2
(local.set ${lk} ${idxWat})
(br_if $hna2 (f64.ne (local.get ${lk}) (local.get ${lk})))
(local.set ${lb} (i32.trunc_f64_s (local.get ${lk})))
(br_if $hna2 (i32.lt_s (local.get ${lb}) (i32.const 0)))
(br_if $hna2 (i32.lt_s (i32.sub (local.get $bar) (local.get ${lb})) (i32.const 0)))
(br $hdone (f64.load (i32.add ${base} (i32.mul (i32.const 8) (i32.sub (local.get $bar) (local.get ${lb}))))))
)
${NAN_WAT}
)`;
    } finally { ctx.freeI(lb); ctx.freeF(lk); }
    return wat;
  }

  // materialize a series arg for ta funcs: bare ident -> direct base; else fresh real series + pre-store
  materialize(e) {
    const ctx = this.ctx;
    if (e.k === 'ident') {
      const n = e.name;
      if (BUILTIN_IDX[n] !== undefined) return { baseWat: this.builtinBaseWat(BUILTIN_IDX[n]) };
      if (n === 'hl2') return { baseWat: this.builtinBaseWat(HL2_IDX) };
      if (ctx.seriesIdx.has(n)) return { baseWat: `(i32.const ${ctx.seriesBase + ctx.seriesIdx.get(n) * 8})` };
    }
    const tname = `tm${ctx.site++}_t`;
    const idx = ctx.addSeries(tname, false);
    ctx.hoistNaFill.push(tname);
    const baseWat = `(i32.const ${ctx.seriesBase + idx * 8})`;
    const pre = `(f64.store (i32.add ${baseWat} (i32.mul (i32.const 8) (local.get $bar))) ${this.compileF64(e)})`;
    return { baseWat, pre };
  }

  compileCall(e) {
    const ctx = this.ctx;
    const n = e.name;
    if (/^input\./.test(n)) {
      const type = n.split('.')[1];
      let defval = e.args[0] ? evalConst(e.args[0]) : (e.kw.defval ? evalConst(e.kw.defval) : 0);
      const title = (e.args[1] && e.args[1].k === 'str') ? e.args[1].v : (e.kw.title && e.kw.title.k === 'str' ? e.kw.title.v : `input${ctx.inputs.length}`);
      const minval = e.kw.minval && e.kw.minval.k === 'num' ? e.kw.minval.v : null;
      const maxval = e.kw.maxval && e.kw.maxval.k === 'num' ? e.kw.maxval.v : null;
      let ii = ctx.inputs.findIndex(x => x.title === title && x.type === type);
      if (ii < 0) { ii = ctx.inputs.length; ctx.inputs.push({ idx: ii, type, defval, title, minval, maxval }); }
      if (type === 'string') return NAN_WAT;
      if (type === 'source') return `(f64.load (i32.add ${this.builtinBaseWat(BUILTIN_IDX.close)} (i32.mul (i32.const 8) (local.get $bar))))`;
      return `(f64.load (i32.const ${8 * ii}))`;
    }
    if (n === 'na' && (e.args || []).length) return `(f64.convert_i32_s (f64.ne ${this.compileF64(e.args[0])} ${this.compileF64(e.args[0])}))`;
    if (n === 'nz') {
      const lc = ctx.allocI(); const d = ctx.allocF();
      let wat;
      try {
        const X = this.compileF64(e.args[0]);
        const Y = e.args[1] ? this.compileF64(e.args[1]) : '(f64.const 0)';
        wat = `(block (result f64)
(local.set ${lc} (f64.ne ${X} ${X}))
(local.set ${d} ${Y})
(select (result f64) (local.get ${d}) ${X} (local.get ${lc}))
)`;
      } finally { ctx.freeF(d); ctx.freeI(lc); }
      return wat;
    }
    if (n === 'math.abs') return `(f64.abs ${this.compileF64(e.args[0])})`;
    if (n === 'math.floor') return `(f64.floor ${this.compileF64(e.args[0])})`;
    if (n === 'math.ceil') return `(f64.ceil ${this.compileF64(e.args[0])})`;
    if (n === 'math.sqrt') return `(f64.sqrt ${this.compileF64(e.args[0])})`;
    if (n === 'math.round') {
      if (e.args[1]) {
        const p = e.args[1].k === 'num' ? e.args[1].v : 0;
        const m = `(f64.const ${Math.pow(10, p)})`;
        return `(f64.div (f64.nearest (f64.mul ${this.compileF64(e.args[0])} ${m})) ${m})`;
      }
      return `(f64.nearest ${this.compileF64(e.args[0])})`;
    }
    if (n === 'int') return `(f64.trunc ${this.compileF64(e.args[0])})`;
    if (n === 'math.max' || n === 'math.min') {
      let out = this.compileF64(e.args[0]);
      for (let i2 = 1; i2 < (e.args || []).length; i2++) out = `(f64.${n === 'math.max' ? 'max' : 'min'} ${out} ${this.compileF64(e.args[i2])})`;
      return out;
    }
    if (n === 'math.sum') {
      let out = '(f64.const 0)';
      for (const a of (e.args || [])) out = `(f64.add ${out} ${this.compileF64(a)})`;
      return out;
    }
    if (n === 'math.avg') {
      const k = Math.max(1, (e.args || []).length);
      let out = '(f64.const 0)';
      for (const a of (e.args || [])) out = `(f64.add ${out} ${this.compileF64(a)})`;
      return `(f64.div ${out} (f64.const ${k}))`;
    }
    if (n === 'math.pow') return `(f64.pow ${this.compileF64(e.args[0])} ${this.compileF64(e.args[1])})`;
    if (n === 'math.log') return `(call $e.math_log ${this.compileF64(e.args[0])})`;
    if (n === 'math.exp') return `(call $e.math_exp ${this.compileF64(e.args[0])})`;
    if (n === 'math.sign') return `(call $fsign ${this.compileF64(e.args[0])})`;
    if (n === 'ta.sma') { const a = this.materialize(e.args[0]); return `${a.pre ? a.pre + '\n' : ''}(call $e.ta_sma ${a.baseWat} (local.get $bar) ${this.i32Of(e.args[1])})`; }
    if (n === 'ta.ema') { const a = this.materialize(e.args[0]); const sid = ctx.nextState(); return `${a.pre ? a.pre + '\n' : ''}(call $e.ta_ema (i32.const ${sid}) ${a.baseWat} (local.get $bar) ${this.i32Of(e.args[1])})`; }
    if (n === 'ta.rma') { const a = this.materialize(e.args[0]); const sid = ctx.nextState(); return `${a.pre ? a.pre + '\n' : ''}(call $e.ta_rma (i32.const ${sid}) ${a.baseWat} (local.get $bar) ${this.i32Of(e.args[1])})`; }
    if (n === 'ta.wma') { const a = this.materialize(e.args[0]); return `${a.pre ? a.pre + '\n' : ''}(call $e.ta_wma ${a.baseWat} (local.get $bar) ${this.i32Of(e.args[1])})`; }
    if (n === 'ta.rsi') { const a = this.materialize(e.args[0]); const sid = ctx.nextState(); return `${a.pre ? a.pre + '\n' : ''}(call $e.ta_rsi (i32.const ${sid}) ${a.baseWat} (local.get $bar) ${e.args[1] ? this.i32Of(e.args[1]) : '(i32.const 14)'})`; }
    if (n === 'ta.tr' || n === 'ta.trueRange') return '(call $e.ta_tr (local.get $bar))';
    if (n === 'ta.atr') { const sid = ctx.nextState(); return `(call $e.ta_atr (i32.const ${sid}) (local.get $bar) ${e.args[0] ? this.i32Of(e.args[0]) : '(i32.const 14)'})`; }
    if (n === 'ta.stdev') { const a = this.materialize(e.args[0]); return `${a.pre ? a.pre + '\n' : ''}(call $e.ta_stdev ${a.baseWat} (local.get $bar) ${this.i32Of(e.args[1])})`; }
    if (n === 'ta.highest') { const a = this.materialize(e.args[0]); return `${a.pre ? a.pre + '\n' : ''}(call $e.ta_highest ${a.baseWat} (local.get $bar) ${this.i32Of(e.args[1])})`; }
    if (n === 'ta.lowest') { const a = this.materialize(e.args[0]); return `${a.pre ? a.pre + '\n' : ''}(call $e.ta_lowest ${a.baseWat} (local.get $bar) ${this.i32Of(e.args[1])})`; }
    if (n === 'ta.change') { const a = this.materialize(e.args[0]); return `${a.pre ? a.pre + '\n' : ''}(call $e.ta_change ${a.baseWat} (local.get $bar))`; }
    if (n === 'ta.mom') { const a = this.materialize(e.args[0]); return `${a.pre ? a.pre + '\n' : ''}(call $e.ta_mom ${a.baseWat} (local.get $bar) ${this.i32Of(e.args[1])})`; }
    if (n === 'ta.cum') { const a = this.materialize(e.args[0]); const sid = ctx.nextState(); return `${a.pre ? a.pre + '\n' : ''}(call $e.ta_cum (i32.const ${sid}) ${a.baseWat} (local.get $bar))`; }
    if (n === 'ta.crossover') { const a = this.materialize(e.args[0]); const b = this.materialize(e.args[1]); return `${a.pre ? a.pre + '\n' : ''}${b.pre ? b.pre + '\n' : ''}(call $e.ta_crossover ${a.baseWat} ${b.baseWat} (local.get $bar))`; }
    if (n === 'ta.crossunder') { const a = this.materialize(e.args[0]); const b = this.materialize(e.args[1]); return `${a.pre ? a.pre + '\n' : ''}${b.pre ? b.pre + '\n' : ''}(call $e.ta_crossunder ${a.baseWat} ${b.baseWat} (local.get $bar))`; }
    if (n === 'ta.cross') { const a = this.materialize(e.args[0]); const b = this.materialize(e.args[1]); return `${a.pre ? a.pre + '\n' : ''}${b.pre ? b.pre + '\n' : ''}(call $e.ta_crossover ${a.baseWat} ${b.baseWat} (local.get $bar))`; }
    if (n === 'ta.valuewhen') {
      const a = this.materialize(e.args[0]); const b = this.materialize(e.args[1]);
      return `${a.pre ? a.pre + '\n' : ''}${b.pre ? b.pre + '\n' : ''}(call $e.ta_valuewhen ${a.baseWat} ${b.baseWat} (local.get $bar) ${this.i32Of(e.args[2])})`;
    }
    ctx.errs.push({ line: e.line || 0, msg: 'unsupported function: ' + n });
    for (const a of (e.args || [])) this.compileF64(a);
    return NAN_WAT;
  }

  i32Of(e) {
    if (e && e.k === 'num') return `(i32.const ${Math.trunc(e.v)})`;
    if (!e) return '(i32.const 1)';
    const X = this.compileF64(e);
    return `(i32.trunc_f64_s ${X})`;
  }
}

function truthyConst(e) {
  return !!((e.k === 'num' && e.v !== 0) || (e.k === 'ident' && e.name === 'true'));
}
function evalConst(e) {
  if (e.k === 'num') return e.v;
  if (e.k === 'ident' && e.name === 'true') return 1;
  if (e.k === 'ident' && e.name === 'false') return 0;
  return 0;
}

// module shell ----------------------------------------------------------------
function wrapModule(bodyWat, ctx, layout) {
  const nPersist = ctx.persistIdx.size;
  const flags = [];
  for (let i = 0; i < nPersist; i++) flags.push(`(global $g_flag${i} (mut i32) (i32.const 0))`);
  const imports = Object.entries(HOST_IMPORTS).map(([name, sig]) => `(import "e" "${name}" (func $e.${name} ${sig}))`);
  const wat = `(module
(import "env" "mem" (memory 1))
${imports.join('\n')}
(global $g_nb (mut i32) (i32.const 0))
${flags.join('\n')}
;; helpers
(func $fdiv (param $a f64) (param $b f64) (result f64)
(select (result f64) (f64.const nan)
(f64.div (local.get $a) (local.get $b))
(f64.ne (local.get $b) (f64.const 0))))
(func $fpmod (param $a f64) (param $b f64) (result f64)
(select (result f64) (f64.const nan)
(f64.sub (local.get $a) (f64.mul (f64.trunc (f64.div (local.get $a) (local.get $b))) (local.get $b)))
(f64.ne (local.get $b) (f64.const 0))))
(func $fsign (param $x f64) (result f64)
(if (result f64) (f64.gt (local.get $x) (f64.const 0)) (then (f64.const 1))
(else (if (result f64) (f64.lt (local.get $x) (f64.const 0)) (then (f64.const -1)) (else (f64.const 0))))))

;; bar body
(func $body (param $bar i32)
${Array.from({ length: 16 }, (_, k) => `(local $fv_${k} f64)`).join('\n')}
${bodyWat}
)

;; prologue: persist carry + hoisted na-fill
(func $pro (param $bar i32)
;; persist carry (t = t-1) for bar>0
${[...ctx.persistIdx.entries()].map(([name, fi]) => {
    const idx = ctx.seriesIdx.get(name);
    return `(block
(br_if 0 (i32.eqz (local.get $bar)))
(br_if 0 (i32.ne (global.get $g_flag${fi}) (i32.const 0)))
(f64.store (i32.add (i32.const ${layout.seriesBase + idx * 8}) (i32.mul (i32.const 8) (local.get $bar)))
(f64.load (i32.add (i32.const ${layout.seriesBase + idx * 8}) (i32.mul (i32.const 8) (i32.sub (local.get $bar) (i32.const 1)))))))`;
  }).join('\n')}
;; hoisted temps: NaN each bar
${ctx.hoistNaFill.map(nm => {
    const idx = ctx.seriesIdx.get(nm);
    if (idx === undefined) return '';
    return `(f64.store (i32.add (i32.const ${layout.seriesBase + idx * 8}) (i32.mul (i32.const 8) (local.get $bar))) (f64.const nan))`;
  }).join('\n')}
)

(func $run (param $nb i32)
(local $b i32)
(global.set $g_nb (local.get $nb))
(local.set $b (i32.const 0))
(block $rdone
(loop $rloop
(br_if $rdone (i32.ge_s (local.get $b) (local.get $nb)))
(call $e.before_bar (local.get $b))
(call $pro (local.get $b))
(call $body (local.get $b))
(call $e.after_bar (local.get $b))
(local.set $b (i32.add (local.get $b) (i32.const 1)))
(br $rloop)
))
)
(export "run" (func $run))
)`;
  return wat;
}

function compile(src) {
  const errs = [], warns = [];
  const ast = require('./parser').parse(src, errs);
  // count inputs for layout
  let nParams = 0; const seenTitles = new Set();
  const walkE = (e) => {
    if (!e || typeof e !== 'object') return;
    if (e.k === 'call' && /^input\./.test(e.name)) {
      const t = (e.args[1] && e.args[1].k === 'str') ? e.args[1].v : (e.kw.title && e.kw.title.k === 'str' ? e.kw.title.v : 'input' + seenTitles.size);
      if (!seenTitles.has(t)) { seenTitles.add(t); nParams++; }
    }
    ['l', 'r', 'c', 'a', 'b', 'e'].forEach(k => e[k] && walkE(e[k]));
    (e.args || []).forEach(walkE);
    Object.values(e.kw || {}).forEach(walkE);
    if (e.idx) walkE(e.idx);
  };
  const walkS = (list) => { if (!list) return; for (const s of list) {
    ['expr', 'cond', 'from', 'to', 'by'].forEach(k => s[k] && walkE(s[k]));
    ['then', 'else', 'body'].forEach(k => walkS(s[k]));
  } };
  for (const s of ast) walkS([s]);
  if (nParams === 0) nParams = 1; // keep at least a stub param slot

  // pass A: discover series count (fresh ctx)
  const ctxA = new Ctx();
  const ca = new Compiler(ast.filter(() => true), ctxA);
  let rA;
  try { rA = ca.compile(); } catch (ex) { errs.push({ line: 0, msg: 'compile pass A: ' + ex.message }); }
  const nSeries = ctxA.series.length;
  const layout = layoutFor(Math.max(1, nParams), nSeries);
  // pass B: real bases
  const ctxB = new Ctx();
  ctxB.meta = JSON.parse(JSON.stringify(ctxA.meta)); // deterministic; pass B re-derives anyway
  ctxB.paramsBase = layout.paramsBase;
  ctxB.dataBase = layout.dataBase;
  ctxB.seriesBase = layout.seriesBase;
  const cb = new Compiler(ast.filter(() => true), ctxB);
  cb.layout = layout;
  let rB;
  try { rB = cb.compile(); } catch (ex) { errs.push({ line: 0, msg: 'compile pass B: ' + ex.message }); return { wat: null, errs, warns, meta: ctxA.meta, layout, series: [], persistFlags: 0, hoistNaFill: [] }; }
  cb.prog = rB ? rB : null;
  cb.layout = layout;
  // $body wat from pass B
  const bodyWat = (rB && rB.wat) ? rB.wat : '';
  const fullWat = wrapModule(bodyWat, ctxB, layout);
  return {
    wat: fullWat, errs: errs.concat(rB.ctx.errs), warns: warns.concat(rB.ctx.warns),
    meta: rB.ctx.meta,
    inputs: rB.ctx.inputs,
    strings: rB.ctx.strings,
    stateCount: rB.ctx.stateCount,
    plots: rB.ctx.plots, shapes: rB.ctx.shapes, hlines: rB.ctx.hlines,
    series: rB.ctx.series.map(s => s.name),
    persistFlags: rB.ctx.persistIdx.size,
    hoistNaFill: rB.ctx.hoistNaFill,
    layout,
  };
}

module.exports = { compile, layoutFor, _internals: { Ctx, lowerList } };
