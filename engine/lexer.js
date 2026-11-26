// PineWASM Desktop - Pine Script lexer (v5/v6 subset)
// Tracks NEWLINE + INDENT/DEDENT like Pine requires for if/for/function blocks.
'use strict';

const OPS = ['==', '!=', '<=', '>=', ':=', '=>', '+=', '-=', '*=', '/=', '?', ':', '<', '>', '+', '-', '*', '/', '%', '=', '(', ')', '[', ']', ',', ':', '.', "'", '"'];

function isIdStart(c) { return /[A-Za-z_]/.test(c); }
function isId(c) { return /[A-Za-z0-9_]/.test(c); }
function isNum(c) { return /[0-9.]/.test(c); }

function tokenize(src, errs) {
  const toks = [];
  const indents = [0];
  let i = 0, line = 1, col = 1;
  const n = src.length;
  let atLineStart = true;
  let parenDepth = 0;

  function push(t, v) { toks.push({ t, v, line, col }); }
  function adv(k) { for (let q = 0; q < (k || 1); q++) { if (src[i] === '\n') { line++; col = 1; } else col++; i++; } }

  while (i < n) {
    const c = src[i];
    if (atLineStart && parenDepth === 0) {
      let w = 0;
      let j = i;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) { w += (src[j] === '\t' ? 4 : 1); j++; }
      if (src[j] === '\n') { adv(j - i + 1); continue; } // blank line
      if (src[j] === undefined) break;
      // comment-only line
      if (src[j] === '/' && src[j + 1] === '/') { while (j < n && src[j] !== '\n') j++; adv(j - i); continue; }
      atLineStart = false;
      if (w > indents[indents.length - 1]) { indents.push(w); push('indent', w); }
      else while (w < indents[indents.length - 1]) { indents.pop(); push('dedent', w); }
      if (w < indents[indents.length - 1] || w > indents[indents.length - 1]) {
        // inconsistent indent - clamp
        indents[indents.length - 1] = w;
      }
      continue;
    }
    if (c === '\n') {
      if (parenDepth === 0) { push('nl', '\\n'); atLineStart = true; }
      adv(); continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { adv(); continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') adv(); continue; }
    if (c === '"' || c === "'") {
      const q = c; let s = ''; adv();
      while (i < n && src[i] !== q && src[i] !== '\n') { s += src[i]; adv(); }
      if (src[i] !== q) errs.push({ line, msg: 'unterminated string' });
      else adv();
      push('str', s); continue;
    }
    if (/[0-9]/.test(c)) {
      let s = '';
      let dots = 0;
      while (i < n && (/^[0-9]$/.test(src[i]) || (src[i] === '.' && !dots && /^[0-9]$/.test(src[i + 1] || '')))) {
        if (src[i] === '.') dots = 1;
        s += src[i]; adv();
      }
      push('num', parseFloat(s)); continue;
    }
    if (isIdStart(c)) {
      let s = ''; while (i < n && isId(src[i])) { s += src[i]; adv(); }
      push('id', s); continue;
    }
    // multi-char ops
    let matched = null;
    for (const op of OPS) { if (src.startsWith(op, i)) { matched = op; } if (matched) break; }
    if (!matched) { errs.push({ line, msg: 'unexpected char ' + JSON.stringify(c) }); adv(); continue; }
    if (matched === '(' || matched === '[') parenDepth++;
    if (matched === ')' || matched === ']') parenDepth = Math.max(0, parenDepth - 1);
    push('op', matched); adv(matched.length); continue;
  }
  if (toks.length && !atLineStart) push('nl', '\\n');
  while (indents.length > 1) { indents.pop(); push('dedent', 0); }
  push('eof', null);
  return toks;
}

module.exports = { tokenize };
