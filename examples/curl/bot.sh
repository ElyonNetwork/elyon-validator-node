#!/usr/bin/env bash
# Minimal Elyon bot with curl (+ jq for reading the JSON answers).
# Start the client first:  elyon serve
# Then:                    ELYON_TOKEN=$(elyon api-token show) ./bot.sh
# Set ELYON_TRADE=1 to really open and close a tiny position (1 wUSDT margin, 2x).
set -euo pipefail
URL="${ELYON_URL:-http://127.0.0.1:7457}"
: "${ELYON_TOKEN:?Set ELYON_TOKEN (run: elyon api-token show)}"

get()  { curl -sS "$URL$1" -H "Authorization: Bearer $ELYON_TOKEN"; }
post() { curl -sS -X POST "$URL$1" -H "Authorization: Bearer $ELYON_TOKEN" -H "Content-Type: application/json" -d "$2"; }
must() { # prints .result, or the error and exits
  local a; a=$(cat)
  if [ "$(jq -r .ok <<<"$a")" != "true" ]; then jq -r '"elyon error \(.error.code): \(.error.message) \(.error.hint // "")"' <<<"$a" >&2; exit 1; fi
  jq .result <<<"$a"
}

get /v1/status | must | jq -r '"wallet \(.wallet.address) | ELN \(.wallet.eln) | wUSDT \(.wallet.wusdt)"'
LAST=$(get "/v1/futures/price?market=BTC" | must | jq -r .market.last)
echo "BTC last price $LAST"
get /v1/portfolio | must | jq -r '"equity estimate \(.totals.total_equity_estimate_wusdt) wUSDT"'

if [ "${ELYON_TRADE:-}" = "1" ]; then
  SL=$(awk -v p="$LAST" 'BEGIN { printf "%d", p * 0.9 }')
  POS=$(post /v1/futures/open "{\"side\":\"long\",\"market\":\"BTC\",\"margin\":\"1\",\"leverage\":2,\"stop_loss\":\"$SL\"}" | must)
  ID=$(jq -r .position_id <<<"$POS")
  echo "opened position $ID at $(jq -r .entry_price <<<"$POS")"
  post /v1/futures/close "{\"id\":\"$ID\"}" | must | jq -r '"closed, paid back \(.payout) wUSDT"'
fi

# Several commands in one request:
post /v1/batch '{"stop_on_error":false,"commands":[{"command":"futures price","params":{"market":"ETH"}},{"command":"futures positions"}]}' \
  | jq -r '.steps[] | "batch step \(.index) \(.command) \(if .ok then "ok" else .error.code end)"'
