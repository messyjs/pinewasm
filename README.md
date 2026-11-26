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

## Features (v0.1)

- Pine v5/v6 subset compiler -> real WASM (see [docs/COVERAGE.md](docs/COVERAGE.md))
- Backtest: entries/exits, reverse-on-entry, stop/limit exits, percent-of-equity or fixed
  sizing, percent commissions, equity curve, PF / MDD / win rate / trade list
- Parameter sweep: compile once, run N parameter sets in milliseconds
- Chart: candles, plots, hlines, plotshapes, trade markers
- Data: synthetic sample, CSV, OKX public klines (no key needed)
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
```

Live mode POSTs `{"action":"buy"|"sell"|"close","symbol":...,"qty":1,"price":...}`
to the webhook in config.json (Tradovate bridge format).

## License

MIT. See [LICENSE](LICENSE).
