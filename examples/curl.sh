#!/usr/bin/env bash
# Brainy Prices: MCP v2 + REST v2 with curl, Python 3 for JSON-RPC parsing, and shell utilities (no jq).
#   bash examples/curl.sh
# Steps: initialize -> notifications/initialized -> tools/list (follows nextCursor) -> tools/call fuel_prices
# -> GET /api/v2/transport/fuel-prices. Prints a short summary of each answer (three fuel prices, dates and source), never raw JSON or rows.
# Requests are at least 1.1 s apart (anonymous limit: 30/min, 500/day, shared by REST and MCP); HTTP 429 stops the script.
# Exit codes: 0 ok, 1 HTTP/network error, 2 JSON-RPC error, 3 tool returned isError, 4 rate limited (429), 5 timeout.
set -euo pipefail

BASE="https://prices.brainy.ae"
MCP_URL="$BASE/mcp/v2"
REST_URL="$BASE/api/v2/transport/fuel-prices"
PROTOCOL="2025-11-25"
MAX_PAGES=20

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BODY="$WORK/body" HEADERS="$WORK/headers"
FIRST=1

# send LABEL CURL_ARGS... : paced request; leaves the body in $BODY and headers in $HEADERS; stops on 429/HTTP/timeout errors.
send() {
  local label="$1"; shift
  if [ "$FIRST" -eq 0 ]; then sleep 1.1; fi
  FIRST=0
  local code rc=0
  code="$(curl -sS --connect-timeout 10 --max-time 20 -o "$BODY" -D "$HEADERS" -w '%{http_code}' "$@")" || rc=$?
  if [ "$rc" -eq 28 ]; then echo "$label: timeout after 20 s" >&2; exit 5; fi
  if [ "$rc" -ne 0 ]; then echo "$label: network error (curl exit $rc)" >&2; exit 1; fi
  if [ "$code" = "429" ]; then
    echo "$label: HTTP 429 rate limited; stopping. Retry-After: $(header retry-after) s" >&2; exit 4
  fi
  case "$code" in
    2??) ;;
    *) echo "$label: HTTP $code $(field code)" >&2; exit 1 ;;
  esac
  HTTP_CODE="$code"
}

# header NAME : value of a response header (case-insensitive), or "not given".
header() { local v; v="$(grep -i "^$1:" "$HEADERS" | head -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//' || true)"; echo "${v:-not given}"; }
# field KEY : first "KEY":"value" string in the body (summary use only; escaped quotes end the value).
# A missing key yields an empty string, never an errexit/pipefail stop.
field() { grep -o "\"$1\":\"[^\"]*" "$BODY" | head -1 | sed "s/^\"$1\":\"//" || true; }

# rpc LABEL JSON : one JSON-RPC message per POST (plain JSON or text/event-stream answer); stops on a JSON-RPC error.
rpc() {
  local label="$1" payload="$2"
  local extra=()
  if [ -n "${NEGOTIATED:-}" ]; then extra=(-H "MCP-Protocol-Version: $NEGOTIATED"); fi
  send "$label" -X POST "$MCP_URL" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' ${extra[@]+"${extra[@]}"} -d "$payload"
  # Inspect only the envelope: tool schemas can also have an "error" property.
  python3 - "$BODY" "$label" <<'PYRPC'
import json, sys
body = open(sys.argv[1], encoding="utf-8").read()
candidates = [body]
if body.lstrip().startswith(("event:", "data:")):
    candidates = ["\n".join(line[5:].lstrip() for line in event.splitlines() if line.startswith("data:"))
                  for event in body.replace("\r\n", "\n").split("\n\n")]
for text in candidates:
    try:
        answer = json.loads(text)
    except ValueError:
        continue
    if isinstance(answer, dict) and "error" in answer:
        error = answer["error"] or {}
        print("%s: JSON-RPC error %s: %s" % (sys.argv[2], error.get("code"), str(error.get("message", ""))[:200]), file=sys.stderr)
        sys.exit(2)
PYRPC
}

# provenance : dates of meta.dataset (only the fields present; never taken from data rows) and the envelope attribution.
provenance() {
  local txt ds out="" v
  txt="$(tr -d '\n' < "$BODY")"
  ds="${txt#*'"dataset":{'}"; ds="${ds%%'"sources":['*}"
  v="$(printf '%s' "$ds" | grep -o '"reference_period":{[^}]*' | grep -o '"label":"[^"]*' | head -1 | sed 's/"label":"//' || true)"; [ -n "$v" ] && out="period $v"
  for pair in published:published_on published:published_at observed:observed_on observed:observed_at compiled:compiled_at; do
    case "$out" in *"${pair%%:*} "*) continue ;; esac
    v="$(printf '%s' "$ds" | grep -o "\"${pair#*:}\":\"[^\"]*" | head -1 | sed "s/^\"${pair#*:}\":\"//" || true)"
    [ -n "$v" ] && out="${out:+$out, }${pair%%:*} $v"
  done
  echo "${out:-no date fields in this response}; $(field attribution | cut -c1-240)"
}

# 1. initialize
rpc initialize "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"$PROTOCOL\",\"capabilities\":{},\"clientInfo\":{\"name\":\"brainy-prices-example-curl\",\"version\":\"1.0.0\"}}}"
NEGOTIATED="$(field protocolVersion)"; NEGOTIATED="${NEGOTIATED:-$PROTOCOL}"
echo "initialize: $(field name) $(field version), MCP protocol $NEGOTIATED"

# 2. notifications/initialized (no id, no result)
rpc notifications/initialized '{"jsonrpc":"2.0","method":"notifications/initialized"}'
echo "notifications/initialized: HTTP $HTTP_CODE"

# 3. tools/list, following nextCursor
TOTAL=0 PAGES=0 CURSOR="" NAMES="" SEEN=""
while :; do
  PAGES=$((PAGES + 1))
  if [ "$PAGES" -gt "$MAX_PAGES" ]; then echo "tools/list: more than $MAX_PAGES pages" >&2; exit 1; fi
  if [ -n "$CURSOR" ]; then PARAMS=",\"params\":{\"cursor\":\"$CURSOR\"}"; else PARAMS=""; fi
  rpc tools/list "{\"jsonrpc\":\"2.0\",\"id\":$((PAGES + 1)),\"method\":\"tools/list\"$PARAMS}"
  COUNT="$(grep -o '"inputSchema"' "$BODY" | wc -l | tr -d ' ' || true)"
  TOTAL=$((TOTAL + COUNT))
  if [ -z "$NAMES" ]; then NAMES="$(grep -o '"name":"[a-z0-9_]*","' "$BODY" | head -5 | sed 's/"name":"//; s/","$//' | tr '\n' ' ' || true)"; fi
  NEXT="$(field nextCursor)"
  if [ -z "$NEXT" ]; then break; fi
  case " $SEEN " in *" $NEXT "*) echo "tools/list: repeated nextCursor (incomplete list)" >&2; exit 1 ;; esac
  SEEN="$SEEN $NEXT" CURSOR="$NEXT"
done
echo "tools/list: $TOTAL tools in $PAGES page(s), e.g. $NAMES"

# 4. tools/call fuel_prices
rpc "tools/call fuel_prices" "{\"jsonrpc\":\"2.0\",\"id\":$((PAGES + 2)),\"method\":\"tools/call\",\"params\":{\"name\":\"fuel_prices\",\"arguments\":{}}}"
FIRST_LINE="$(field text | sed 's/\\n.*//' | cut -c1-240 || true)"
if grep -q '"isError":true' "$BODY"; then echo "tools/call fuel_prices: tool error: $FIRST_LINE" >&2; exit 3; fi
echo "tools/call fuel_prices: status $(grep -o '"dataset_id":"[^"]*","status":"[^"]*"' "$BODY" | head -1 | sed 's/.*"status":"//; s/"$//'), month $(field month)"
echo "  $FIRST_LINE"
echo "  $(provenance)"

# 5. REST GET /api/v2/transport/fuel-prices
send "GET /api/v2/transport/fuel-prices" "$REST_URL" -H 'Accept: application/json'
UNIT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("data", {}).get("unit", ""))' "$BODY")"
echo "REST fuel-prices: HTTP $HTTP_CODE, status $(grep -o '"dataset_id":"[^"]*","status":"[^"]*"' "$BODY" | head -1 | sed 's/.*"status":"//; s/"$//'), month $(field month), $UNIT"
# First three grades of the current prices object (no raw JSON).
PRICES="$(grep -o '"prices":{[^}]*}' "$BODY" | head -1 | sed 's/"prices":{//; s/}$//; s/"//g; s/:/ /g' | tr ',' '\n' | head -3 | paste -sd ',' - | sed 's/,/, /g' || true)"
echo "  ${PRICES:-no prices published}"
echo "  $(provenance)"
echo "  RateLimit: $(header ratelimit)"
