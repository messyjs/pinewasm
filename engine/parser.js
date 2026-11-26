// PineWASM Desktop - parser (statements + expressions -> AST)
'use strict';
const { tokenize } = require('./lexer');

class Parser {
  constructor(src, errs) {
    this.toks = tokenize(src, errs);
    this.errs = errs;
    this.i = 0;
  }
  peek(k) { return this.toks[this.i + (k || 0)]; }
  next() { return this.toks[this.i++]; }
  at(t, v) { const p = this.peek(); return p.t === t && (v === undefined || p.v === v); }
  eat(t, v) { if (this.at(t, v)) { return this.next(); } return null; }
  expect(t, v) { const tk = this.eat(t, v); if (!tk) this.err(this.peek(), 'expected ' + (v || t)); return tk; }
  err(tk, msg) { this.errs.push({ line: tk ? tk.line : 0, msg }); }
  skipNls() { while (this.at('nl')) this.next(); }
  skipSoftNl() { this.eat('nl'); }

  parseProgram() {
    const out = [];
    this.skipNls();
    while (!this.at('eof')) {
      const s = this.parseStmt();
      if (s) out.push(s);
      if (!this.at('eof') && !this.at('dedent')) this.eat('nl');
      this.skipNls();
    }
    return out;
  }

  parseBlock() { // after 'indent' ... 'dedent'
    this.expect('indent');
    const st = [];
    this.skipNls();
    while (!this.at('dedent') && !this.at('eof')) {
      const s = this.parseStmt();
      if (s) st.push(s);
      if (!this.at('dedent') && !this.at('eof')) this.eat('nl');
      this.skipNls();
    }
    this.eat('dedent');
    return st;
  }

  parseStmt() {
    const tk = this.peek();
    if (tk.t === 'nl') { this.next(); return null; }
    // version comment line becomes id 'version' via //@version? handled as comment -> skip
    if (tk.t === 'id') {
      if (tk.v === 'if') return this.parseIf();
      if (tk.v === 'for') return this.parseFor();
      if (tk.v === 'while') { this.err(tk, 'while not supported in v0.1'); return null; }
      const nk = this.peek(1);
      // function definition: name(params) => body
      if (nk.t === 'op' && nk.v === '(') {
        // lookahead for '=>'
        let k = 2, depth = 1;
        while (depth > 0 && !(this.toks[this.i + k].t === 'eof')) {
          if (this.toks[this.i + k].t === 'op' && this.toks[this.i + k].v === '(') depth++;
          if (this.toks[this.i + k].t === 'op' && this.toks[this.i + k].v === ')') depth--;
          k++;
        }
        if (depth === 0 && this.toks[this.i + k] && this.toks[this.i + k].t === 'op' && this.toks[this.i + k].v === '=>') return this.parseFunc();
      }
      // declaration keywords
      if (tk.v === 'var' || tk.v === 'varip') {
        this.next();
        const persist = tk.v === 'varip' || true; // varip treated same as var in v0.1 (no intrabar)
        // optional type word
        if (this.peek().t === 'id' && ['float', 'int', 'bool', 'string', 'color', 'series', 'simple'].includes(this.peek().v)) this.next();
        const name = this.expect('id');
        this.expect('op', '=');
        const e = this.parseExpr();
        return { kind: 'declare', persist, name: name.v, expr: e, line: tk.line };
      }
      if (['float', 'int', 'bool', 'string', 'color', 'simple', 'series'].includes(tk.v)) {
        const t2 = this.peek(1);
        if (t2.t === 'id') {
          this.next(); const name = this.next();
          if (this.eat('op', '=')) { return { kind: 'declare', persist: false, name: name.v, expr: this.parseExpr(), line: tk.line }; }
          if (this.eat('op', ':=')) { return { kind: 'assign', name: name.v, expr: this.parseExpr(), line: tk.line }; }
          this.err(name, 'expected = or :=');
          return null;
        }
      }
    }
    // assignment  name := expr  or  declaration  name = expr
    if (tk.t === 'id' && this.peek(1).t === 'op' && (this.peek(1).v === ':=' || this.peek(1).v === '=')) {
      const name = this.next().v;
      const opTok = this.next().v;
      const e = this.parseExpr();
      return opTok === '='
        ? { kind: 'declare', persist: false, name, expr: e, line: tk.line }
        : { kind: 'assign', name, expr: e, line: tk.line };
    }
    // expression statement (call like plot/strategy.entry)
    const e = this.parseExpr();
    return { kind: 'call', expr: e, line: tk.line };
  }

  parseIf() {
    const tk = this.expect('id', 'if');
    const cond = this.parseExpr();
    let then = [], alt = [];
    if (this.at('nl')) { this.next();
      if (this.at('indent')) then = this.parseBlock();
    }
    // else / else if on same scope line
    const save = this.i;
    this.skipNls();
    if (this.at('id', 'else')) {
      this.next();
      if (this.at('id', 'if')) alt = [this.parseIf()];
      else if (this.at('nl')) { this.next(); if (this.at('indent')) alt = this.parseBlock(); }
    } else this.i = save;
    return { kind: 'if', cond, then, else: alt, line: tk.line };
  }

  parseFor() {
    const tk = this.expect('id', 'for');
    const ivar = this.expect('id').v;
    this.expect('op', '=');
    const from = this.parseExpr();
    this.expect('id', 'to');
    const to = this.parseExpr();
    let by = null;
    if (this.eat('id', 'by')) by = this.parseExpr();
    let body = [];
    if (this.at('nl')) { this.next(); if (this.at('indent')) body = this.parseBlock(); }
    return { kind: 'for', ivar, from, to, by, body, line: tk.line };
  }

  parseFunc() {
    const name = this.expect('id').v;
    this.expect('op', '(');
    const params = [];
    if (!this.at('op', ')')) {
      do {
        const p = this.expect('id').v;
        let def = null;
        if (this.eat('op', '=')) def = this.parseExpr();
        params.push({ name: p, def });
      } while (this.eat('op', ','));
    }
    this.expect('op', ')');
    this.expect('op', '=>');
    let expr = null, body = [];
    if (this.at('nl')) {
      this.next();
      body = this.parseBlock();
    } else {
      expr = this.parseExpr();
    }
    return { kind: 'func', name, params, expr, body, line: name ? 0 : 0 };
  }

  // expressions ------------------------------------------------------------
  parseExpr() { return this.parseTern(); }
  parseTern() {
    const c = this.parseOr();
    if (this.at('op', '?')) {
      this.next();
      const a = this.parseTern();
      this.expect('op', ':');
      const b = this.parseTern();
      return { k: 'ter', c, a, b };
    }
    return c;
  }
  parseOr() {
    let l = this.parseAnd();
    while (this.at('id', 'or') || this.at('id', 'and') === false && false) {}
    while (this.at('id', 'or')) { this.next(); const r = this.parseAnd(); l = { k: 'or', l, r }; }
    return l;
  }
  parseAnd() {
    let l = this.parseCmp();
    while (this.at('id', 'and')) { this.next(); const r = this.parseCmp(); l = { k: 'and', l, r }; }
    return l;
  }
  parseCmp() {
    let l = this.parseAdd();
    while (this.at('op') && ['==', '!=', '<', '<=', '>', '>='].includes(this.peek().v)) {
      const op = this.next().v; const r = this.parseAdd(); l = { k: 'bin', op, l, r };
    }
    return l;
  }
  parseAdd() {
    let l = this.parseMul();
    while (this.at('op') && (this.peek().v === '+' || this.peek().v === '-')) {
      const op = this.next().v; const r = this.parseMul(); l = { k: 'bin', op, l, r };
    }
    return l;
  }
  parseMul() {
    let l = this.parseUnary();
    while (this.at('op') && ['*', '/', '%'].includes(this.peek().v)) {
      const op = this.next().v; const r = this.parseUnary(); l = { k: 'bin', op, l, r };
    }
    return l;
  }
  parseUnary() {
    if (this.at('op', '-') || this.at('op', '+')) { const op = this.next().v; const e = this.parseUnary(); return op === '-' ? { k: 'neg', e } : e; }
    if (this.at('id', 'not')) { this.next(); const e = this.parseUnary(); return { k: 'not', e }; }
    return this.parsePostfix();
  }
  parsePostfix() {
    let e = this.parsePrimary();
    for (;;) {
      if (this.at('op', '[')) { this.next(); const idx = this.parseExpr(); this.expect('op', ']'); e = { k: 'hist', e, idx }; }
      else if (this.at('op', '.')) { this.next(); const nm = this.expect('id').v; e = { k: 'enum', base: e, name: nm }; }
      else if (this.at('op', '(') && (e.k === 'enum')) {
        this.next(); const a = this.parseArgs();
        e = { k: 'call', name: dottedStr(e), args: a.args, kw: a.kw, line: this.peek(-1).line };
      }
      else break;
    }
    return e;
  }
  parseArgs() {
    const args = [], kw = {};
    if (this.at('op', ')')) { this.next(); return { args, kw }; }
    do {
      if (this.at('id') && this.peek(1).t === 'op' && this.peek(1).v === '=') {
        const nm = this.next().v; this.next();
        kw[nm] = this.parseExpr();
      } else {
        args.push(this.parseTern());
      }
    } while (this.eat('op', ','));
    this.expect('op', ')');
    return { args, kw };
  }
  parsePrimary() {
    const tk = this.peek();
    if (tk.t === 'num') { this.next(); return { k: 'num', v: tk.v }; }
    if (tk.t === 'str') { this.next(); return { k: 'str', v: tk.v }; }
    if (tk.t === 'id') {
      this.next();
      if (tk.v === 'true') return { k: 'num', v: 1 };
      if (tk.v === 'false') return { k: 'num', v: 0 };
      if (tk.v === 'na') return { k: 'na' };
      if (tk.v === 'int' && this.at('op', '(')) { this.next(); const a = this.parseArgs(); return { k: 'call', name: 'math.round', args: a.args, kw: a.kw }; }
      if (tk.v === 'float' && this.at('op', '(')) { this.next(); const a = this.parseArgs(); return a.args[0] || { k: 'num', v: NaN }; }
      if (this.at('op', '(')) { this.next(); const a = this.parseArgs(); return { k: 'call', name: tk.v, args: a.args, kw: a.kw, line: tk.line }; }
      return { k: 'ident', name: tk.v, line: tk.line };
    }
    if (tk.t === 'op' && tk.v === '(') { this.next(); const e = this.parseExpr(); this.expect('op', ')'); return e; }
    if (tk.t === 'op' && tk.v === '[') { this.next(); const e = this.parseExpr(); this.expect('op', ']'); return { k: 'hist', e: { k: 'ident', name: '__prev__' }, idx: e }; }
    this.err(tk, 'unexpected token ' + (tk.v !== null ? String(tk.v) : tk.t));
    this.next();
    return { k: 'num', v: NaN };
  }
}

function dottedStr(e) {
  if (e.k === 'ident') return e.name;
  if (e.k === 'enum') return dottedStr(e.base) + '.' + e.name;
  return '';
}

function parse(src, errs) {
  const p = new Parser(src, errs);
  return p.parseProgram();
}

module.exports = { parse };
