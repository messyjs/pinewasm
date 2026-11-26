// ANATOMY port of AURORA M16 pine-v4to5 (pre-v5 bridge + full normalize + overlay-aware engine seam).
// vela-pinets refuses version < 5 — the catalog/archive tiers are heavily pre-v5/untagged,
// so chart LOAD runs the same mechanical bridge AURORA proved with an A/B battery.

const VERSION_RE = /^\/\/\s*@version\s*=\s*(\d+)\s*$/m;

const RENAMES = [
  [/\bsecurity\b/g, 'request.security'],
  [/\btostring\b/g, 'str.tostring'],
  [/\btonumber\b/g, 'str.tonumber'],
  [/\babs\b/g, 'math.abs'],
  [/\bceil\b/g, 'math.ceil'],
  [/\bexp\b/g, 'math.exp'],
  [/\bfloor\b/g, 'math.floor'],
  [/\blog\b/g, 'math.log'],
  [/\blog10\b/g, 'math.log10'],
  [/\bmax\b/g, 'math.max'],
  [/\bmin\b/g, 'math.min'],
  [/\bpow\b/g, 'math.pow'],
  [/\bround\b/g, 'math.round'],
  [/\bsign\b/g, 'math.sign'],
  [/\bsqrt\b/g, 'math.sqrt'],
  [/\bsum\b/g, 'math.sum'],
  [/\bavg\b/g, 'math.avg'],
  [/\bbarssince\b/g, 'ta.barssince'],
  [/\bbars_since\b/g, 'ta.barssince'],
  [/\bpercentrank\b/g, 'ta.percentrank'],
  [/\bpercentile\b/g, 'ta.percentile'],
  [/\bcrossover\b/g, 'ta.crossover'],
  [/\bcrossunder\b/g, 'ta.crossunder'],
  [/\bvaluewhen\b/g, 'ta.valuewhen'],
  [/\bpivothigh\b/g, 'ta.pivothigh'],
  [/\bpivotlow\b/g, 'ta.pivotlow'],
  [/\bsupertrend\b/g, 'ta.supertrend'],
  [/\bpercentile_linear_interpolation\b/g, 'ta.percentile_linear_interpolation'],
  [/\bcorrelation\b/g, 'ta.correlation'],
  [/\bhighestbars\b/g, 'ta.highestbars'],
  [/\blowestbars\b/g, 'ta.lowestbars'],
  [/\bvariance\b/g, 'ta.variance'],
  [/\bstdev\b/g, 'ta.stdev'],
  [/\bskewness\b/g, 'ta.skewness'],
  [/\bkurtosis\b/g, 'ta.kurtosis'],
  [/\bmedian\b/g, 'ta.median'],
  [/\bmode\b/g, 'ta.mode'],
  [/\brising\b/g, 'ta.rising'],
  [/\bfalling\b/g, 'ta.falling'],
  [/\bcum\b/g, 'ta.cum'],
  [/\bdev\b/g, 'ta.dev'],
  [/\bchange\b/g, 'ta.change'],
  [/\blinreg\b/g, 'ta.linreg'],
  [/\bsar\b/g, 'ta.sar'],
  [/\btr\b/g, 'ta.tr'],
  [/\baroon\b/g, 'ta.aroon'],
  [/\bcci\b/g, 'ta.cci'],
  [/\bcmos\b/g, 'ta.cmo'],
  [/\bdmi\b/g, 'ta.dmi'],
  [/\bema\b/g, 'ta.ema'],
  [/\bhma\b/g, 'ta.hma'],
  [/\balma\b/g, 'ta.alma'],
  [/\bswma\b/g, 'ta.swma'],
  [/\bvwma\b/g, 'ta.vwma'],
  [/\bwma\b/g, 'ta.wma'],
  [/\bsma\b/g, 'ta.sma'],
  [/\batr\b/g, 'ta.atr'],
  [/\bbbands?\b/g, 'ta.bb'],
  [/\bbbw\b/g, 'ta.bbw'],
  [/\bkc\b/g, 'ta.kc'],
  [/\bkcw\b/g, 'ta.kcw'],
  [/\bbar_index\b/g, 'bar_index'],
  [/\bmacd\b/g, 'ta.macd'],
  [/\bmfi\b/g, 'ta.mfi'],
  [/\bmom\b/g, 'ta.mom'],
  [/\bobv\b/g, 'ta.obv'],
  [/\brsi\b/g, 'ta.rsi'],
  [/\bstoch\b/g, 'ta.stoch'],
  [/\btsi\b/g, 'ta.tsi'],
  [/\bvwap\b/g, 'ta.vwap'],
  [/\bwpr\b/g, 'ta.wpr'],
  [/\bhighest\b/g, 'ta.highest'],
  [/\blowest\b/g, 'ta.lowest'],
  [/\bcross\b/g, 'ta.cross'],
];

function withGuard(re) {
  const src = re.source.startsWith('(?<!') ? re.source : '(?<![\\w.$])' + re.source.replace(/^\\b|\\b$/g, '');
  return new RegExp(src + (re.source.includes('\\b') ? '' : '\\b'), re.flags);
}

function applyTable(text) {
  let t = text;
  for (const [re, replacement] of RENAMES) {
    if (replacement === undefined) continue;
    t = t.replace(withGuard(re), () => replacement);
  }
  return t;
}

function renameOutsideStrings(line) {
  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      let j = i + 1;
      let lit = '';
      while (j < n && line[j] !== q) {
        if (line[j] === '\\') { lit += line[j] + (line[j + 1] ?? ''); j += 2; continue; }
        lit += line[j]; j++;
      }
      out += q + lit + q;
      i = j + 1;
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') {
      out += applyTable(line.slice(i));
      break;
    }
    out += ch;
    i++;
  }
  return out;
}

function splitTopLevel(s) {
  const parts = [];
  let depth = 0, start = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

function stripIff(code) {
  let changed = 0;
  const convert = (input) => {
    const idx = input.search(/(?<![\w.$])iff\s*\(/);
    if (idx < 0) return input;
    const open = input.indexOf('(', input.indexOf('iff', idx));
    let depth = 0; let end = open;
    for (let i = open; i < input.length; i++) {
      const c = input[i];
      if (c === '"' || c === "'") {
        const q = c; i++;
        while (i < input.length && input[i] !== q) { if (input[i] === '\\') i++; i++; }
        continue;
      }
      if (c === '(') depth++;
      if (c === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    const inner = input.slice(open + 1, end);
    const args = splitTopLevel(inner);
    if (args.length === 3) {
      changed++;
      const a = convert(args[0].trim());
      const b = convert(args[1].trim());
      const c2 = convert(args[2].trim());
      return input.slice(0, idx) + `(${a} ? ${b} : ${c2})` + convert(input.slice(end + 1));
    }
    return input.slice(0, end + 1) + convert(input.slice(end + 1));
  };
  const text = convert(code);
  return { text, changed };
}

function bridgePreV5(source) {
  const notes = [];
  const m = VERSION_RE.exec(source);
  const original = m ? Number(m[1]) : null;
  if (original !== null && original >= 5) return { source, bridged: false, version: String(original), notes };
  let src = source.includes('@version=')
    ? source.replace(/^\/\/\s*@version\s*=\s*\d+\s*$/m, '//@version=5')
    : '//@version=5\n' + source;
  if (original === null) notes.push('untagged legacy — bridged as v4-shaped');
  else notes.push(`v${original} → v5 bridge`);
  const DOT = '\u30fb';
  src = src
    .split('\n')
    .map((l) => (l.includes(DOT) && !l.trimStart().startsWith('//') ? '// anatomy-scrub: ' + l.trim() : l))
    .join('\n');
  src = src
    .split('\n')
    .map((line) => {
      let q = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '/' && line[i + 1] === '/') {
          const comment = line.slice(i).replace(/[^\x00-\x7f]/g, '_').replace(/[&^~`$%]/g, '_');
          return line.slice(0, i) + comment;
        }
      }
      return line;
    })
    .join('\n');
  src = src.split('\n').map(renameOutsideStrings).join('\n');
  src = src.replace(/(?<![\w.$])study\s*\(/g, 'indicator(');
  const iff = stripIff(src);
  src = iff.text;
  if (iff.changed) notes.push(`${iff.changed} iff→ternary`);
  return { source: src, bridged: true, version: original === null ? 'legacy' : String(original), notes };
}

function needsBridge(source) {
  const m = VERSION_RE.exec(source);
  return !(m && Number(m[1]) >= 5);
}

// Full M16 normalize (head-cut, NBSP family, lone surrogates, comment-prose sanitize).
function normalizePineFull(source) {
  const tagIdx = source.search(/^\/\/\s*@version\s*=\s*\d+/m);
  if (tagIdx > 0) source = source.slice(tagIdx);
  const DOT = '\u30fb';
  const BS = String.fromCharCode(92);
  const spacing = source.replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, ' ')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '_')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '_');
  return spacing
    .split('\n')
    .map((line) => {
      if (line.trimStart().startsWith('//')) {
        return line.replace(/[^\x00-\x7f]/g, '_').replace(/[&^~`$%]/g, '_');
      }
      let q = null;
      let nonAscii = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === BS) { i++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === DOT || c.charCodeAt(0) > 0x7f) { nonAscii = true; break; }
      }
      if (nonAscii) return '// anatomy-scrub: ' + line.trim();
      q = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === BS) { i++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '/' && line[i + 1] === '/') {
          const comment = line.slice(i).replace(/[^\x00-\x7f]/g, '_').replace(/[&^~`$%]/g, '_');
          return line.slice(0, i) + comment;
        }
      }
      return line;
    })
    .join('\n');
}

const OVERLAY_RE = /(?<![\w.$])overlay\s*[:=]\s*true(?:\s*[,)\n]|\s*$)/m;
module.exports = { applyTable, bridgePreV5, needsBridge, normalizePineFull, renameOutsideStrings, splitTopLevel, stripIff, withGuard };
