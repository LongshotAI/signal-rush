# Signal Rush — Payment & Token Redemption Architecture (Phase 2)

## Overview

Phase 1 (current): Closed-loop credit economy. Players earn credits by playing,
spend credits on in-game features. No real money or external tokens involved.

Phase 2 (this document): Token redemption. Players convert earned credits into
API tokens from external providers (OpenRouter, Nous, etc.) using the x402
payment protocol.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  CLI Game    │────▶│  Economy     │────▶│  Provider API   │
│  (player)    │     │  Service     │     │  (OpenRouter,   │
│              │◀────│  (Fastify)   │◀────│   Nous, etc.)   │
└─────────────┘     └──────┬───────┘     └─────────────────┘
                           │
                    ┌──────▼───────┐
                    │  SQLite DB   │
                    │  - players   │
                    │  - credits   │
                    │  - redemptions│
                    │  - tokens    │
                    └──────────────┘
```

## Credit Flow (Phase 1 — Live)

1. Player plays game → engine awards credits
2. Event bridge diffs credits before/after each step
3. Economy service ingests credit deltas → updates player balance
4. All operations idempotent, atomic, auditable

## Redemption Flow (Phase 2 — Planned)

1. Player requests redemption: `POST /redemptions`
   - `{ provider: "openrouter", amount_micros: 5000 }`
   - Economy service validates: sufficient balance, within limits
   - Deducts credits atomically
   - Creates redemption record (status: 'pending')

2. Economy service calls provider API via x402:
   - Sends payment + receives API key/token
   - On success: updates redemption (status: 'completed'), creates token_balance record
   - On failure: refunds credits (status: 'refunded')

3. Player can query token balance: `GET /tokens/balance`
   - Returns per-provider token balances

4. Player can spend tokens for API calls:
   - `POST /tokens/spend` → deducts from token_balance
   - Actual API call made by the game/service using the provider key

## Security Considerations

### API Key Storage
- Provider API keys stored in environment variables ONLY
- Never in database, never in code, never in logs
- `.env` file in `.gitignore` (already configured)
- `.env.example` has placeholder values only

### Redemption Limits
- Per-transaction min/max (configurable per provider)
- Per-player daily limit (anti-fraud)
- Rate limited endpoint (already implemented)

### Audit Trail
- Every redemption creates an audit log entry
- Provider responses stored for debugging
- Failed redemptions auto-refund credits

### Idempotency
- Each redemption has a unique idempotency key
- Duplicate requests return the original result
- Prevents double-spend on network retries

## x402 Integration

x402 is a payment protocol for AI services. Our integration:

1. **As a buyer** (spending credits for API tokens):
   - Use x402 client to pay provider
   - Receive API key or token credit
   - Store token balance locally

2. **As a seller** (Phase 3 — other players buy our game tokens):
   - Accept x402 payments for credit packs
   - Credits added to player balance on payment confirmation

## Environment Variables (Phase 2 additions)

```bash
# Provider API keys (NEVER commit these)
OPENROUTER_API_KEY=
NOUS_API_KEY=

# x402 configuration
X402_PROVIDER_URL=
X402_API_KEY=
X402_WALLET_ADDRESS=

# Redemption limits
MAX_REDEMPTION_PER_DAY=100000
MIN_REDEMPTION_AMOUNT=100
```

## Database Schema

See `economy/redemption-schema.sql` for the full Phase 2 schema.

Key tables:
- `redemptions` — redemption requests and status
- `token_balances` — per-provider token balances per player
- `providers` — provider configuration (non-secret)
- `redemption_audit` — append-only audit log

## Implementation Order

1. Create redemption ledger functions (redeem, refund, getBalance)
2. Add redemption endpoints to economy service
3. Integrate x402 client for provider payments
4. Add redemption UI to dashboard
5. End-to-end test: earn credits → redeem → verify tokens
