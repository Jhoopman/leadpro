#!/usr/bin/env bash
# smoke.sh — start LeadPro locally and run curl checks against it.
# Run from the project root: bash .claude/skills/run-leadpro/smoke.sh
# Pass PORT=XXXX to override (default 3000).

set -euo pipefail

PORT=${PORT:-3000}
BASE="http://localhost:$PORT"
PASS=0; FAIL=0

# ── helpers ──────────────────────────────────────────────────────────────────

ok()   { echo "  ✅  $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌  $1"; FAIL=$((FAIL + 1)); }

check_status() {
  local label="$1" url="$2" want="$3"
  local got
  got=$(curl -s -o /dev/null -w "%{http_code}" "$url")
  [ "$got" = "$want" ] && ok "$label → $got" || fail "$label → $got (expected $want)"
}

check_json_key() {
  local label="$1" url="$2" key="$3"
  local body
  body=$(curl -s "$url")
  echo "$body" | grep -q "\"$key\"" && ok "$label ($key present)" \
    || fail "$label ($key missing) — body: ${body:0:120}"
}

check_post() {
  local label="$1" url="$2" payload="$3" want_key="$4"
  local body
  body=$(curl -s -X POST "$url" -H "Content-Type: application/json" -d "$payload")
  echo "$body" | grep -q "\"$want_key\"" && ok "$label ($want_key present)" \
    || fail "$label ($want_key missing) — body: ${body:0:200}"
}

# ── launch server if not already listening ───────────────────────────────────

SERVER_PID=""
if ! curl -s --max-time 1 "$BASE/health" >/dev/null 2>&1; then
  echo "Starting server on port $PORT…"
  node server.js &
  SERVER_PID=$!
  for i in $(seq 1 10); do
    sleep 1
    curl -s --max-time 1 "$BASE/health" >/dev/null 2>&1 && break
    [ $i -eq 10 ] && { echo "Server did not start in 10 s"; kill "$SERVER_PID" 2>/dev/null; exit 1; }
  done
  echo "Server up (PID $SERVER_PID)"
else
  echo "Server already running on port $PORT"
fi

# ── smoke checks ─────────────────────────────────────────────────────────────

echo ""
echo "── Static endpoints ─────────────────────────────────────────────────────"
check_status   "/health"           "$BASE/health"           200
check_status   "/"                 "$BASE/"                 200
check_status   "/config"           "$BASE/config"           200
check_status   "/widget.js"        "$BASE/widget.js"        200
check_status   "/widget-chat.html" "$BASE/widget-chat.html" 200

echo ""
echo "── JSON shape checks ────────────────────────────────────────────────────"
check_json_key "/health"   "$BASE/health"   "ok"
check_json_key "/config"   "$BASE/config"   "supabaseUrl"

echo ""
echo "── Anthropic diagnostic ─────────────────────────────────────────────────"
DIAG=$(curl -s "$BASE/api/admin/anthropic-test?token=leadpro-diag-2024")
echo "  Key prefix : $(echo "$DIAG" | grep -o '"keyPrefix":"[^"]*"' | head -1)"
echo "  Anthropic  : $(echo "$DIAG" | grep -o '"anthropicStatus":[0-9]*' | head -1)"
# 200 = working key, 401 = invalid/revoked key — both are valid responses from the server itself
echo "$DIAG" | grep -q '"anthropicStatus"' && ok "diagnostic endpoint reachable" \
  || fail "diagnostic endpoint unreachable"

echo ""
echo "── Widget-API (marketing widget, expects Anthropic response) ────────────"
WIDGET=$(curl -s -X POST "$BASE/widget-api" \
  -H "Content-Type: application/json" \
  -d '{"widgetId":"lp_rdzvuqld","messages":[{"role":"user","content":"ping"}]}')
# Content depends on key validity — just confirm the server responded with JSON
echo "$WIDGET" | python3 -c "import sys,json; json.load(sys.stdin); print('  valid JSON')" 2>/dev/null \
  && ok "widget-api returned JSON" || fail "widget-api returned non-JSON: ${WIDGET:0:100}"

echo ""
echo "── Auth guard ───────────────────────────────────────────────────────────"
got=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api" \
  -H "Content-Type: application/json" -d '{}')
[ "$got" = "401" ] && ok "POST /api (no token) → 401" || fail "POST /api (no token) → $got (expected 401)"

# ── cleanup ──────────────────────────────────────────────────────────────────

echo ""
[ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null; echo "Server stopped."; }

echo ""
echo "Result: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] && exit 0 || exit 1
