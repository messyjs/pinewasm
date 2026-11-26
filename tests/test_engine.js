// PineWASM Desktop engine tests: compile -> wasm -> backtest -> sweep -> python parity
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const rt = require('../engine/runtime');
const dataMod = require('../engine/data');
const pygen = require('../engine/pygen');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  PASS ' + name + (extra ? '  (' + extra + ')' : ''));
  else { failures++; console.log('  FAIL ' + name + (extra ? '  (' + extra + ')' : '')); }
}

async function main() {
  const src = fs.readFileSync(path.join(ROOT, 'samples', 'bandflip.pine'), 'utf8');

  console.log('[1] compile pine -> wasm');
  const comp = await rt.compileScript(src);
  check('no compile errors', comp.ok, (comp.errs || []).map(e => 'L' + e.line + ': ' + e.msg).join(' | '));
  check('wasm bytes > 0', comp.ok && comp.wasmSize > 0, comp.wasmSize + 'B');
  check('compile < 2000ms', comp.compileMs < 2000, comp.compileMs + 'ms');
  check('inputs detected', (comp.inputs || []).length === 3, JSON.stringify((comp.inputs || []).map(i => i.title)));

  console.log('[2] backtest on sample data');
  const data = dataMod.genSample(3000);
  const r = rt.runBacktest(comp, data);
  check('run ok', r.ok);
  check('trades > 0', r.stats.trades > 0, r.stats.trades + ' trades');
  check('run < 1500ms for 3000 bars', r.runMs < 1500, r.runMs + 'ms');
  check('stats sane', Number.isFinite(r.stats.netProfit) && Number.isFinite(r.stats.maxDDPct),
    'net=' + r.stats.netProfit.toFixed(2) + ' pf=' + r.stats.profitFactor.toFixed(2) + ' mdd%=' + r.stats.maxDDPct.toFixed(2));
  check('plots produced', r.plots.length === 3, r.plots.map(p => p.title).join(','));

  console.log('[2b] per-trade enrichment (mae/mfe/duration/qty%)');
  const trs = r.trades;
  const bad = trs.filter(t => !(t.durationBars >= 1) || !Number.isFinite(t.mae) || !Number.isFinite(t.mfe)
    || t.mae > 0 || t.mfe < 0 || !(t.eqPct > 0) || !Number.isFinite(t.entryEq) || !(t.durationMs >= 0));
  check('all trades carry enrichment invariants', trs.length > 0 && bad.length === 0,
    bad.length ? bad.length + ' bad: ' + JSON.stringify(bad[0]).slice(0, 200) : trs.length + ' trades ok');
  const exc = trs.filter(t => t.mae === 0 && t.mfe === 0);
  check('excursions not all zero', exc.length < trs.length, 'flat: ' + exc.length + '/' + trs.length);
  const first = trs[0];
  check('sample mae/mfe magnitude sane', Number.isFinite(first.maePct) && Number.isFinite(first.mfePct),
    `mae $${first.mae.toFixed(2)} (${first.maePct.toFixed(2)}%) mfe $${first.mfe.toFixed(2)} (${first.mfePct.toFixed(2)}%) dur ${first.durationBars}b eqpct ${first.eqPct.toFixed(2)}%`);

  console.log('[3] sweep (compile once, N runs)');
  const t0 = Date.now();
  const rows = rt.sweep(comp, data, {}, { name: 'Length', values: [5, 10, 15, 20, 25, 30, 40, 60] });
  const ms = Date.now() - t0;
  check('sweep rows', rows.length === 8, ms + 'ms total, ' + (ms / 8).toFixed(1) + 'ms/run');

  console.log('[4] python bot generation + parity');
  const out = pygen.generateBot(src);
  check('pygen no errors', out.errs.length === 0, out.errs.map(e => e.msg).join(' | '));
  const botDir = path.join(ROOT, 'bots', '_test');
  fs.mkdirSync(botDir, { recursive: true });
  const botPath = path.join(botDir, 'bot.py');
  fs.writeFileSync(botPath, out.bot);
  fs.writeFileSync(path.join(botDir, 'data.csv'), dataMod.dataToCsv(data, 3000));
  let pyOut = '';
  try {
    pyOut = execFileSync('python', [botPath, '--csv', path.join(botDir, 'data.csv')], { encoding: 'utf8', timeout: 60000 });
  } catch (ex) { pyOut = (ex.stdout || '') + '\nERR ' + (ex.stderr || ex.message); }
  const mN = pyOut.match(/NETPCT (-?[\d.]+)/);
  const mT = pyOut.match(/TRADES (\d+)/);
  check('python bot runs', !!mN, pyOut.slice(0, 300).replace(/\n/g, ' | '));
  if (mN && mT) {
    const pyNet = Number(mN[1]);
    const pyTr = Number(mT[1]);
    const jsNet = r.stats.netProfitPct;
    const diff = Math.abs(pyNet - jsNet);
    check('python net% within 0.5 of wasm engine', diff < 0.5, `py=${pyNet.toFixed(3)} wasm=${jsNet.toFixed(3)} diff=${diff.toFixed(3)}`);
    const trDiff = Math.abs(pyTr - r.stats.trades);
    check('python trade count within 5', trDiff <= 5, `py=${pyTr} wasm=${r.stats.trades}`);
  }

  console.log(failures ? `\n${failures} FAILURES` : '\nALL TESTS PASS');
  process.exit(failures ? 1 : 0);
}

main().catch(ex => { console.error('test crash:', ex); process.exit(2); });
