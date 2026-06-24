# ppq.ai Credit Distribution Setup

This document explains how to set up and use the ppq.ai credit distribution system for the Signal Rush economy service.

## Overview

The Signal Rush economy service includes a **player rewards pool** that receives 20% of all advertiser impression charges. Players earn skill-based rewards from this pool and can claim them as ppq.ai credits.

The claim flow works as follows:

1. **Ad impressions** → 20% allocated to the rewards pool (in `ledger.chargeCampaign()`)
2. **Skill-based gameplay** → `earnPlayerReward()` awards micros to the player
3. **POST /rewards/claim** → Creates a pending claim record
4. **POST /credits/transfer** → Attempts the actual ppq.ai credit transfer and completes the claim

## What Justin Needs

1. **ppq.ai Account** — Sign up at [https://ppq.ai](https://ppq.ai)
2. **API Key** — Generate from the ppq.ai dashboard
3. **Credits** — Add credits to the ppq.ai account (these are what get distributed to players)
4. **`PPQ_API_KEY` environment variable** — Set this on the production server

## How to Get the API Key

1. Log in to [https://ppq.ai](https://ppq.ai)
2. Navigate to **Settings → API Keys**
3. Click **Create New Key**
4. Copy the generated key (it starts with `ppq-` or similar)
5. Store it securely — it will only be shown once

## Setting the Environment Variable

### Local Development

```bash
export PPQ_API_KEY="your-ppq-api-key-here"
```

### Production (systemd service)

Add to the service's environment file (e.g., `/etc/signal-rush/economy.env`):

```
PPQ_API_KEY=your-ppq-api-key-here
```

### Docker

Pass as an environment variable:

```bash
docker run -e PPQ_API_KEY=your-ppq-api-key-here -p 8720:8720 signal-rush-economy
```

## Test Mode vs Production Mode

The system supports two modes, determined automatically by the presence of `PPQ_API_KEY`:

### Test Mode (`PPQ_API_KEY` is NOT set)

- **No actual ppq.ai API calls are made**
- The transfer is simulated with a `"test-mode-simulated"` reference
- All database operations (claim creation, completion, pool updates) work normally
- Perfect for development and CI testing
- The response includes `"mode": "test"`

### Production Mode (`PPQ_API_KEY` IS set)

- A real ppq.ai API call (chat completion) is made as proof-of-activity
- The provider model name is stored as the `ppq_tx_id` reference
- On failure, the claim is refunded (player + pool)
- The response includes `"mode": "production"`

## How to Run the Test Harness

The test harness at `scripts/test-ppq-claim-flow.js` exercises the full claim flow end-to-end.

### Prerequisites

1. The economy service must be running on port 8720
2. Node.js 18+

### Start the Economy Service

```bash
# From the signal-rush project root
node economy/service.js
```

### Run in Test Mode (no API key)

```bash
node scripts/test-ppq-claim-flow.js
```

This runs the full test suite without making actual ppq.ai API calls.

### Run in Production Mode (with API key)

```bash
PPQ_API_KEY=your-actual-key node scripts/test-ppq-claim-flow.js
```

This runs the same tests but makes a real ppq.ai chat completion call.

### What the Test Harness Does

1. Creates a test advertiser, campaign, and player
2. Charges impressions → 20% flows to the rewards pool
3. Awards skill-based rewards to the player
4. Calls `POST /rewards/claim` — verifies the claim is `pending`
5. Calls `POST /credits/transfer` — verifies the transfer completes
6. Verifies the claim status is `completed` in the database
7. Verifies pool stats are updated
8. Tests error cases (insufficient rewards, invalid amounts, missing fields, rate limiting)
9. Verifies the audit log is written

### Expected Output

In **test mode**, you should see:

```
  ✓ Transfer completed (test mode)
  ✓ ppq_ref: test-mode-simulated
  ✓ mode: test
```

In **production mode**, you should see:

```
  ✓ Transfer completed (production mode)
  ✓ ppq_ref: gpt-4o-mini
  ✓ mode: production
```

## API Reference

### POST /rewards/claim

Creates a pending reward claim.

**Request:**
```json
{
  "player_id": "uuid",
  "ppq_account": "player@email.com",
  "amount_micros": 5000
}
```

**Response (200):**
```json
{
  "ok": true,
  "id": "uuid",
  "player_id": "uuid",
  "amount_micros": 5000,
  "ppq_account": "player@email.com",
  "status": "pending",
  "claimed_at": "2025-01-01T00:00:00.000Z"
}
```

### POST /credits/transfer

Creates AND completes a reward claim in one step. Requires shared-secret auth (under `/credits/*` prefix).

**Request:**
```json
{
  "player_id": "uuid",
  "ppq_account": "player@email.com",
  "amount_micros": 5000
}
```

**Response (200, test mode):**
```json
{
  "ok": true,
  "claim_id": "uuid",
  "status": "completed",
  "amount_micros": 5000,
  "ppq_account": "player@email.com",
  "ppq_ref": "test-mode-simulated",
  "mode": "test",
  "ppq_response": {
    "content": "Test mode — no actual ppq.ai call was made",
    "model": "test-mode",
    "usage": {}
  }
}
```

**Response (200, production):**
```json
{
  "ok": true,
  "claim_id": "uuid",
  "status": "completed",
  "amount_micros": 5000,
  "ppq_account": "player@email.com",
  "ppq_ref": "gpt-4o-mini",
  "mode": "production",
  "ppq_response": {
    "content": "...",
    "model": "gpt-4o-mini",
    "usage": { ... }
  }
}
```

### GET /rewards/pool-stats

Returns the current state of the rewards pool.

**Response:**
```json
{
  "ok": true,
  "total_deposited_micros": 50000,
  "total_claimed_micros": 15000,
  "available_micros": 35000
}
```

## Security Features

### Input Validation

| Field | Rule | Purpose |
|-------|------|---------|
| `player_id` | Must be valid UUID v4 | Prevents injection |
| `ppq_account` | 1-128 characters | Prevents DoS |
| `amount_micros` | 1,000 - 100,000 micros | Anti-fraud caps |

### Rate Limiting

- **Per-player cooldown:** 60 seconds between claims
- **Daily cap:** 3 claims per player (enforced by ledger via daily redemption cap)
- **Global rate limit:** Sliding window per IP + path

### Audit Logging

Every claim attempt is logged to `~/.signal-rush/claim-audit.log` as JSONL:

```json
{"timestamp":"2025-01-01T00:00:00.000Z","player_id":"uuid","ppq_account":"user@ppq.ai","amount_micros":5000,"result":"completed","mode":"test","claim_id":"uuid","ppq_ref":"test-mode-simulated"}
```

Fields:
- `timestamp` — when the claim was processed
- `player_id` — the player claiming
- `ppq_account` — the ppq.ai account
- `amount_micros` — the amount
- `result` — `pending`, `completed`, `failed`, `rate_limited`, `transfer_failed`, `complete_failed`
- `mode` — `test` or `production`
- `ppq_ref` — the ppq.ai reference (if completed)
- `reason` — error message (if failed)