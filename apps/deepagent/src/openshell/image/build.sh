#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
TOOLS="${TOOLS:-search_instruments,get_ltp,get_ohlc_quote,historical_candles,intraday_candles,option_chain,market_status,read_candles,company_profile,news}"
PORT="${PORT:-7777}"
rm -rf wrappers && mkdir -p wrappers
bun run ../wrappers.ts --out wrappers --tools "$TOOLS" --port "$PORT"
docker build -t harnesh/agent-sandbox:ubuntu-lts .