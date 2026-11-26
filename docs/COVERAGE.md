# Pine Script coverage (v0.2)

## Supported
- //@version=5/6 comments, indicator()/strategy() declarations with core kwargs
  (title, overlay, default_qty_type/value, commission_type/value, capital, pyramiding)
- var / varip declarations (varip treated as var - no intrabar model yet), := reassignment
- typed declarations (float/int/bool/... prefixes), if/else, for loops
- user-defined functions (single or multi-line), inlined per call site (correct var/ta state)
- ternary, and/or/not, arithmetic (+ - * / % with na-preserving divide-by-zero),
  comparisons, history operator [] on series identifiers (bounds-checked, na before start)
- built-in series: open high low close volume time hl2 hlc3 ohlc4 bar_index last_bar_index
- ta: sma ema rma wma rsi tr/trueRange atr stdev highest lowest change mom cum
  crossover crossunder cross valuewhen
- math: abs floor ceil sqrt round(x[,p]) max min sum avg pow log exp sign pi e
- na(x), nz(x[,y]), int(x), float(x), input.int/float/bool/source/string
- plot (line), plotshape/plotchar (markers), hline, bgcolor/fill/alertcondition (no-op)
- strategy: entry (long/short, qty kw, reverse behavior), close, close_all,
  exit with stop/limit, strategy.position_size, strategy.position_avg_price
- fills: market orders at next bar open, stop/limit intrabar with gap-aware fills,
  percent-of-equity / fixed qty sizing, percent commissions
- max concurrent positions (slot broker): up to N simultaneous independent positions via
  runtime `max_concurrent` (toolbar MAX POS / QUANT goal / `--maxpos` bot flag).
  Same-sid same-direction entries are skipped; an opposite-direction entry closes
  conflicting slots first (netting guard); each slot keeps its own stop/limit bracket,
  MAE/MFE and entry equity. `max_concurrent: 1` reproduces the classic netting broker
  bit-identically (tested: bandflip 3000-bar run unchanged under cap 2).

## Not yet (roadmap M2)
- ta: macd, bb, supertrend, linreg, hma, vwap, stoch, cci, mfi, obv, dmi, pivots,
  barssince, pivothigh/low, highestbars
- strategy.exit trailing stops, strategy.order, plotcandle, labels, tables, alerts,
  multi-timeframe security(), varip true intrabar semantics, while loops, switch,
  string/color arithmetic, series int lengths beyond input scalars
