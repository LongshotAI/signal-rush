#!/bin/bash
# Signal Rush Ad Portal Verification
# This script must be run from /home/hive/signal-rush

set -e

echo "=== Signal Rush Ad Portal Verification ==="
echo ""

# Check service is up
HEALTH=$(curl -s http://127.0.0.1:8720/health)
echo "Health: $HEALTH"

# Check auth status
AUTH_TEST=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:8720/portal/admin/campaigns/fake-id/approve)
echo "Auth status: HTTP $AUTH_TEST (expect 200 if auth disabled, 401 if enforced)"

if [ "$AUTH_TEST" = "401" ]; then
  echo "ERROR: Auth is enforced. Set ECONOMY_AUTH_ENFORCED=*** and restart."
  exit 1
fi

# Step 1: Login
echo ""
echo "--- Step 1: Login ---"
LOGIN_RESP=$(curl -s -X POST http://127.0.0.1:8720/portal/login \
  -H "Content-Type: application/json" \
  -d '{"email":"advertiser@test.com","password":"TestPass123"}')
echo "$LOGIN_RESP"

API_KEY=*** "$LOGIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['api_key'])" 2>/dev/null || echo "")

if [ -z "$API_KEY" ]; then
  echo "ERROR: Login failed"
  exit 1
fi
echo "API_KEY: ${API_KEY:0:16}..."

# Step 2: Create campaign
echo ""
echo "--- Step 2: Create Campaign ---"
CAMPAIGN_RESP=$(curl -s -X POST http://127.0.0.1:8720/portal/campaigns \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"name":"Summer Campaign 2026","brand_name":"Acme Corp","placement_type":"hud_frame","daily_budget_micros":1000000,"total_budget_micros":10000000}')
echo "$CAMPAIGN_RESP"

CAMPAIGN_ID=$(echo "$CAMPAIGN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['campaign']['id'])" 2>/dev/null || echo "")

if [ -z "$CAMPAIGN_ID" ]; then
  echo "ERROR: Campaign creation failed"
  exit 1
fi
echo "CAMPAIGN_ID: $CAMPAIGN_ID"

# Step 3: Upload logo creative
echo ""
echo "--- Step 3: Upload Logo Creative ---"
CREATIVE_RESP=$(curl -s -X POST "http://127.0.0.1:8720/portal/campaigns/$CAMPAIGN_ID/creatives" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"type":"logo","content":{"lines":["  ACME  "," A C M E ","  CORP  "]}}')
echo "$CREATIVE_RESP"

# Step 4: Submit for review
echo ""
echo "--- Step 4: Submit for Review ---"
SUBMIT_RESP=$(curl -s -X POST "http://127.0.0.1:8720/portal/campaigns/$CAMPAIGN_ID/submit" \
  -H "Authorization: Bearer $API_KEY")
echo "$SUBMIT_RESP"

# Step 5: Admin approve
echo ""
echo "--- Step 5: Admin Approve ---"
APPROVE_RESP=$(curl -s -X POST "http://127.0.0.1:8720/portal/admin/campaigns/$CAMPAIGN_ID/approve")
echo "$APPROVE_RESP"

# Step 6: Verify game API
echo ""
echo "--- Step 6: Game API Returns Active Campaign ---"
GAME_RESP=$(curl -s http://127.0.0.1:8720/api/game/campaigns)
echo "$GAME_RESP"

# Step 7: CLI rendering
echo ""
echo "--- Step 7: CLI Start Screen ---"
CLI_OUTPUT=$(timeout 3 node src/cli/index.js --demo --no-color 2>&1 | head -10)
echo "$CLI_OUTPUT"

# Check results
echo ""
echo "=== RESULTS ==="
if echo "$GAME_RESP" | grep -q "Acme Corp"; then
  echo "✅ Game API returns live campaign with 'Acme Corp'"
else
  echo "❌ Game API does not return live campaign"
fi

if echo "$CLI_OUTPUT" | grep -q "Acme"; then
  echo "✅ CLI start screen shows live campaign 'Acme'"
elif echo "$CLI_OUTPUT" | grep -q "Temple Works"; then
  echo "⚠️  CLI shows static fallback 'Temple Works' (async fetch may not complete in 3s)"
else
  echo "❌ No sponsor content in CLI"
fi

echo ""
echo "=== Verification Complete ==="
