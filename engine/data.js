// PineWASM Desktop - data loading (CSV + synthetic sample)
'use strict';

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  let rows = lines.map(l => l.split(/[,\t;]/).map(s => s.trim()));
  if (rows.length && rows[0].some(c => /[a-df-zA-DF-Z]/.test(c) && !/^[-+]?[0-9.eE]+$/.test(c))) {
    rows = rows.slice(1); // header
  }
  const T = [], O = [], H = [], L = [], C = [], V = [];
  for (const r of rows) {
    if (r.length < 5) continue;
    let ts = r[0];
    let t;
    if (/^[-+]?\d+$/.test(ts)) { t = Number(ts); if (t > 1e12) t = t / 1000; else if (t > 1e10) t = t / 1000; }
    else {
      const d = Date.parse(ts.replace(' ', 'T'));
      if (Number.isNaN(d)) continue;
      t = d / 1000;
    }
    const o = Number(r[1]), h = Number(r[2]), ll = Number(r[3]), c = Number(r[4]);
    const v = r.length > 5 ? Number(r[5]) : 0;
    if (![o, h, ll, c].every(Number.isFinite)) continue;
    T.push(t); O.push(o); H.push(h); L.push(ll); C.push(c); V.push(Number.isFinite(v) ? v : 0);
  }
  return toData(T, O, H, L, C, V);
}

function toData(T, O, H, L, C, V) {
  return {
    t: Float64Array.from(T), o: Float64Array.from(O), h: Float64Array.from(H),
    l: Float64Array.from(L), c: Float64Array.from(C), v: Float64Array.from(V),
  };
}

// deterministic synthetic market: trend regimes + noise + mean reversion
function genSample(n = 3000, seed = 42) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const T = [], O = [], H = [], L = [], C = [], V = [];
  let px = 100;
  let t0 = Date.UTC(2024, 0, 1) / 1000;
  let regime = 0, regimeLeft = 200;
  for (let k = 0; k < n; k++) {
    if (--regimeLeft <= 0) { regime = rnd() < 0.5 ? 1 : (rnd() < 0.5 ? -1 : 0); regimeLeft = 150 + Math.floor(rnd() * 300); }
    const drift = regime * 0.0006;
    const mr = (100 - px) * 0.002;
    // occasional 2-4% shock bars (news candles) so stops/losses exist
    const shock = rnd() < 0.02 ? (rnd() < 0.5 ? -1 : 1) * (0.02 + rnd() * 0.02) : 0;
    const ret = drift + mr + (rnd() - 0.5) * 0.012 + shock;
    const open = px;
    const close = px * (1 + ret);
    const hi = Math.max(open, close) * (1 + rnd() * 0.006 + Math.abs(shock) * 0.4);
    const lo = Math.min(open, close) * (1 - rnd() * 0.006 - Math.abs(shock) * 0.4);
    const vol = 500 + rnd() * 1500 + (shock ? 5000 : 0);
    T.push(t0 + k * 900); O.push(open); H.push(hi); L.push(lo); C.push(close); V.push(vol);
    px = close;
  }
  return toData(T, O, H, L, C, V);
}

function dataToCsv(data, nbars) {
  const out = ['time,open,high,low,close,volume'];
  for (let k = 0; k < nbars; k++) {
    out.push(`${Math.round(data.t[k])},${data.o[k]},${data.h[k]},${data.l[k]},${data.c[k]},${data.v[k]}`);
  }
  return out.join('\n');
}

module.exports = { parseCsv, genSample, dataToCsv, toData };
