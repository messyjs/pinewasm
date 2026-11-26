# verify per-trade enrichment UI: run script, open TRADES tab, check new columns + hover detail
from playwright.sync_api import sync_playwright
import json

JS = """
() => new Promise((resolve, reject) => {
  const btn = document.getElementById('btnRun');
  if (!btn) return resolve({err: 'no btnRun'});
  btn.click();
  const wait = setInterval(() => {
    const tbl = document.getElementById('trades');
    if (!tbl || !tbl.querySelector('tr')) return;
    const ths = [...tbl.querySelectorAll('th')].map(t => t.textContent);
    if (!ths.includes('MAE')) return; // old render, keep waiting
    clearInterval(wait);
    const tr = tbl.querySelector('tr:nth-child(2)');
    const tds = [...tr.querySelectorAll('td')].map(t => t.textContent.trim());
    const hdr = {};
    ths.forEach((h, i) => hdr[h] = tds[i]);
    resolve({
      headers: ths.join('|'),
      qty: hdr['QTY'], eqPct: hdr['EQ%'], bars: hdr['BARS'], mae: hdr['MAE'], mfe: hdr['MFE'], pnl: hdr['PNL'],
      hover: (tr.getAttribute('title') || '').split('\\n').join(' || '),
      tradesCount: tbl.querySelectorAll('tr').length - 1,
      err: null
    });
  }, 100);
  setTimeout(() => { clearInterval(wait); resolve({err: 'timeout waiting enriched render'}); }, 30000);
})
"""

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp('http://localhost:9230')
    ctx = b.contexts[0]
    page = [pg for pg in ctx.pages if 'index.html' in pg.url][0]
    r = page.evaluate(JS)
    print(json.dumps(r, indent=1))
    b.close()
