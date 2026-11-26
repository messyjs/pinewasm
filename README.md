# PineWASM Desktop

**Compile Pine Script to WebAssembly. Backtest at near-native speed. Export Python bots from perfected TradingView strategies.**

PineWASM Desktop is a Windows app inspired by the
[PineWASM](https://github.com/artificial-intelligence-edge/PineWASM) compiler concept
(an independent Rust compiler for Pine Script v6 targeting WebAssembly) and reimplemented
from scratch in JavaScript + WAT + WebAssembly, with two things the original does not do:

1. **Windows desktop app** - paste a Pine strategy, run backtests and parameter sweeps locally.
2. **Python bot export** - one click turns a *perfected* strategy (tuned + backtested in
   TradingView) into a standalone `bot.py` with identical math, live data polling, and
   Tradovate-style webhook execution.

> Not affiliated with TradingView or AI Edge. Pine Script is a trademark of TradingView.

## How it works

```
Pine source -> lexer -> parser (AST) -> function inlining -> series materialization
           -> WAT emission (explicit history in linear memory, na = NaN)
           -> wabt assembler -> standalone .wasm module
           -> host runtime (ta library + broker emulator imports)
```

- Every series lives in linear memory; `close[3]` is a bounds-checked load. No interpreter.
- `na` is real IEEE NaN, so comparisons and `nz`/`na` behave like Pine.
- The WASM module is compiled once and instantiated per run: the sweep pays compile cost
  once and re-runs the module with fresh state (same trick PineWASM uses for fast sweeps).
- The Python transpiler re-uses the SAME lowered AST, so the generated bot shares
  semantics with the WASM engine. Parity is tested in CI-style self-tests.

## Features (v0.2)

- Pine v5/v6 subset compiler -> real WASM (see [docs/COVERAGE.md](docs/COVERAGE.md))
- Backtest: entries/exits, reverse-on-entry, per-entry stop/limit exits (TP/SL drawn on
  chart, LEVELS toggle), percent-of-equity or fixed sizing, percent commissions,
  equity curve, PF / MDD / win rate / trade list
- **Max concurrent positions**: slot-based broker holds up to N independent positions,
  each with its own stop/limit bracket (toolbar MAX POS, or "3 concurrent positions" in
  QUANT). Max 1 keeps classic TV netting behavior - single-pos runs are bit-identical.
- **Per-trade stats**: MAE/MFE excursion ($ and % of entry equity, with timestamps),
  duration (bars + wall time), qty, position size vs equity at entry - table columns plus
  hover row detail
- **QUANT chat**: type targets ("max drawdown 5% with at least 20 trades") -> constraint
  optimizer sweeps inputs + sizes into the DD budget; "3 concurrent positions" supported.
  LLM loop mode rewrites the source itself (self-healing compile) and APPLY swaps the
  editor. Trades off net%/PF/DD with hard vs soft penalties.
- **Second-engine cross-check**: the LuxAlgo vela-pinets engine runs the same script on
  the same bars (CROSS-CHECK chip) and compares net/trades/win rate/PF. DD lines are not
  comparable (lux DD is per-trade positional, pinewasm is equity-ledger peak-trough).
- Parameter sweep: compile once, run N parameter sets in milliseconds
- Chart: candles, plots, hlines, plotshapes, trade markers, TradingView-style
  wheel-zoom (cursor-anchored) / drag-pan / axis-drag zoom / double-click fit
- Data: synthetic sample (with 2% shock bars), CSV, OKX public klines (no key needed)
- Python bot builder: `bot.py` + `config.json` + `requirements.txt` + README,
  backtest parity-checked against the WASM engine, live mode + webhook

## Quickstart

```
npm install
npm start          # opens the app on your left display
npm test           # engine self-tests incl. python parity
```

The app boots with a working Bollinger+RSI mean-reversion strategy. Press RUN.

## Python bots

Bot builder page -> BUILD PYTHON BOT. Output in `bots/<strategy>/`:

```
bot.py          standalone, no deps beyond stdlib (webhook uses urllib)
config.json     copy of the strategy inputs - edit and re-run
README.md       run instructions
```

```
python bot.py --okx BTC-USDT-SWAP --tf 15m             # backtest
python bot.py --okx BTC-USDT-SWAP --live               # poll + fire signals
python bot.py --csv data.csv --trades-csv trades.csv   # parity vs TradingView export
python bot.py --csv data.csv --maxpos 3                # max concurrent positions
```

Live mode POSTs `{"action":"buy"|"sell"|"close","symbol":...,"qty":1,"price":...}`
to the webhook in config.json (Tradovate bridge format).
Trades CSV columns: dir, entryTime, entryPx, qty, eqPct, sl, tp, exitTime, exitPx,
pnl, pnlPct, mae, mfe, durBars, durMin, reason.

## License

MIT for PineWASM Desktop's own code. See [LICENSE](LICENSE).

Vendored third-party code in `vendor/` (kept out of npm; node_modules links there):

| Package | What | License |
|---|---|---|
| `vendor/@luxalgo/vela` | LuxAlgo chart workspace host (cross-check harness) | Apache-2.0 |
| `vendor/@luxalgo/vela-ui` | its UI layer | Apache-2.0 |
| `vendor/@luxalgo/vela-pinets` | LuxAlgo Pine-in-JS engine (cross-check engine #2) | **AGPL-3.0-only** |
| `vendor/pinets` | Pine-in-JS engine (same family) | **AGPL-3.0-only** |
| `vendor/@zag-js`, `vendor/@floating-ui`, `vendor/@internationalized`, `vendor/proxy-compare` | transitive UI deps | per-package OSS |

The AGPL-3.0 packages are used as unmodified vendored dependencies with attribution;
if you distribute builds that link them, the AGPL terms apply to the combined work.
