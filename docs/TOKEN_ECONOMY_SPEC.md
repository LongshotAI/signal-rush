# Signal Rush Token Economy — MVP Spec v2

> **⚠️ DEPRECATION NOTICE (2026-06-21):** The legacy credit economy described below
> (`state.credits`, credit diffing, `/internal/ingest`, gameplay credits) has been
> **fully removed**. `forwardStep()` was deleted from eventBridge.js. The engine no
> longer modifies `state.credits`. The only redeemable value comes from the **20%
> ad-funded rewards pool**. See `docs/AD_PORTAL_SPEC.md` and the reward pool
> implementation in `economy/ledger.js` (functions: `earnPlayerReward`,
> `claimReward`, `allocateToRewardsPool`) for the current system.
>
> This document is kept for historical reference only. Do not use as a guide for
> new development.

## Purpose
A closed-loop token distribution system for the Signal Rush game. Players earn credits through gameplay, tracked in a separate SQLite ledger. A separate ad portal lets advertisers manage campaigns. Everything runs on the Z440 — no external cloud dependencies.

**Key principle: The game engine is never imported by the economy service.** The CLI/frontend sits in the middle, calls `engine.step()`, then forwards the resulting events + credit diff to the economy service via HTTP. No shared mutable state.

---

## Architecture

```
signal-rush/
├── src/
│   ├── core/
│   │   ├── engine.js          # NO CHANGES — emits events, mutates state.credits
│   │   └── eventBridge.js     # NEW: CLI/frontend calls this after each step()
│   ├── cli/                   # Modified: index.js gets bridge call
│   ├── config/
│   ├── content/
│   ├── state/
│   └── ...
├── economy/                   # NEW — token distribution service (Fastify, port 8720)
│   ├── service.js             # Fastify HTTP API
│   ├── ledger.js              # SQLite operations (better-sqlite3)
│   └── schema.sql             # DB schema
├── ads/                       # NEW — advertiser portal (Fastify, port 8730)
│   ├── service.js             # Fastify HTTP API
│   ├── schema.sql             # DB schema
│   ├── templates/             # HTML templates
│   └── uploads/               # Creative asset storage
└── dashboard/                 # NEW — read-only tracking dashboard (Fastify, port 8740)
    ├── service.js             # Fastify HTTP API
    └── templates/             # HTML templates
```

### Tech Stack

All services are **Node.js** (same runtime as the game engine):
- **Fastify 5.x** — HTTP server (lightweight, fast, Node-native)
- **better-sqlite3 12.x** — SQLite driver (synchronous, fast, no async overhead)
- Zero new runtime dependencies beyond what npm can install

### Port Map (all localhost only)

| Service | Port | Purpose |
|---------|------|---------|
| Game engine | (library) | No server — called by CLI or web frontend |
| Economy | 8720 | Credit ledger, award/spend, player accounts |
| Ad Portal | 8730 | Advertiser CRUD, campaign config, approval queue |
| Dashboard | 8740 | Read-only view of tokens, ads, transactions |

**Port conflict check:** 8720, 8730, 8740 are verified free on Z440. Port 8760 (Pong Screener) and 18700 (AOS) are unrelated and untouched.

---

## Data Flow

```
┌─────────────────────────────────────────────────────┐
│                  CLI / Web Frontend                  │
│                                                     │
│  1. engine.step(input)                              │
│  2. Read engine.state.lastEvents                    │
│  3. Diff engine.state.credits (before vs after)     │
│  4. Call eventBridge.forward()                      │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP POST localhost:8720
                       ▼
              ┌─────────────────┐
              │  ECONOMY SERVICE │  port 8720
              │  (Fastify)       │
              └────────┬────────┘
                       │ writes to
                       ▼
              ┌─────────────────┐
              │  economy.db      │  ~/.signal-rush/economy.db
              │  (SQLite/WAL)    │
              └────────┬────────┘
                       │ reads from
                       ▼
              ┌─────────────────┐
              │  AD PORTAL       │  port 8730  (separate DB: ads.db)
              │  DASHBOARD       │  port 8740  (read-only views)
              └─────────────────┘
```

---

## Credit Tracking Strategy (Critical Design Decision)

The engine modifies `state.credits` in several places. Only ONE of them emits a `credits_awarded` event:

| Engine Location | What Happens | Credits | Event Emitted |
|----------------|-------------|---------|---------------|
| Pickup collected (AI Hunt, line 600-601) | `state.credits += Math.max(1, Math.floor(gained / 25))` | ✅ | `credits_awarded` with amount |
| Frogger slot filled (line 261) | `state.credits += Math.max(1, Math.floor(slotScore / 50))` = 2 | ✅ | `home_slot_filled` (NO credits field) |
| Frogger level cleared (line 268) | `state.credits += Math.max(1, Math.floor((timeBonus + levelBonus) / 50))` | ✅ | `level_cleared` (NO credits field) |
| Reset/restart (lines 127, 159, 333) | `state.credits = 0` | Reset to 0 | None |
| Near-miss (line 90-111) | Score only, no credit interaction | ❌ None | `near_miss` (score-only) |

**The problem:** 2 out of 3 credit award paths don't emit a `credits_awarded` event.

**The solution — Credit Diffing in the event bridge:**

The bridge sends ONE payload per step with a single `credits_delta` field. This is the **authoritative** credit change for that step. The events array is for analytics only — the economy service does NOT sum credit amounts from individual events (which would double-count).

```javascript
// eventBridge.js — called by CLI/frontend after each step()
async function forwardStep(playerId, sessionId, engine, events, creditsBefore) {
  const creditsAfter = engine.state.credits;
  const delta = creditsAfter - creditsBefore;

  // Detect reset: credits went to 0 (new game / restart)
  // A reset is NOT a spend — just ignore for economy tracking
  const isReset = (creditsAfter === 0 && creditsBefore > 0);

  const payload = {
    player_id: playerId,
    session_id: sessionId,
    credits_delta: isReset ? 0 : delta,  // 0 for resets, actual delta otherwise
    is_reset: isReset,
    events: events,                       // for analytics only
    timestamp: new Date().toISOString(),
  };

  try {
    await fetch('http://localhost:8720/internal/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(500), // 500ms timeout — don't block game loop
    });
  } catch (err) {
    // Service down or slow — queue locally, never block the game
    queueForRetry(payload);
  }
}
```

**Why this is correct:**
- `credits_delta` is the single source of truth for credit changes — no double-counting
- AI Hunt pickups emit `credits_awarded` events AND increment `state.credits`. The diff catches it once.
- Frogger slots/level clears increment `state.credits` silently. The diff catches these too.
- Reset detection: `creditsAfter === 0 && creditsBefore > 0` is unambiguous — the engine only sets credits to 0 on reset/restart
- Future spends (Phase 2) will produce a negative delta with `creditsAfter > 0` — handled naturally
- No engine changes required
- Idempotent: the economy service deduplicates by `(player_id, session_id, timestamp)`

---

## Event Types Ingested by Economy Service

These are the events from `engine.state.lastEvents` that the economy service processes:

| Event Type | Fields | Economy Action |
|------------|--------|----------------|
| `credits_awarded` | `{ credits }` | Analytics only (amount already captured by diff) |
| `pickup_collected` | `{ value }` | Track for analytics |
| `near_miss` | `{ count, score, streak }` | Track for analytics (no credit award — score only) |
| `home_slot_filled` | `{ slotIndex }` | Track for analytics (credits already captured by diff) |
| `level_cleared` | `{ level }` | Track for analytics (credits already captured by diff) |
| `run_ended` | `{ deathState }` | Snapshot final stats (deathState includes finalCredits) |
| `run_restarted` | `{}` | New session tracking |
| `sponsor_impression` | `{}` (bare) | Log impression against active campaign |
| `pause_toggled` | `{ paused }` | Track session pauses |
| `forward_progress` | `{ rows, score }` | Frogger analytics |
| `player_hop`, `player_moved`, `dash_used`, `hazard_spawned`, `pickup_spawned`, `combo_changed`, `player_hit`, `level_started` | various | Track for analytics (no credit impact) |

**Important:** The economy service awards credits based solely on `credits_delta` from the bridge payload. Individual event credit fields (like `credits_awarded.credits`) are NOT summed — doing so would double-count. Events are for analytics/context only.

---

## Near-Miss Credits (Design Decision)

The engine does NOT award credits for near-misses. They are score-only.

**For the MVP economy, near-misses should NOT award credits.** Rationale:
1. Near-miss scoring is already generous (12 points per near miss, up to 3 per tick, with combo bump)
2. Adding credit awards on top would inflate the economy unpredictably
3. Skillful play is already rewarded through score → existing credit conversion on pickups
4. Adding near-miss credits is a Phase 2 economy tuning decision that requires playtesting data

The near_miss event IS tracked in the economy DB for analytics. When we have playtime data, we can make an informed decision about whether to add a small near-miss credit bonus.

---

## Sponsor Impressions → Ad Campaign Mapping

The engine emits bare `sponsor_impression` events with no campaign context. The engine cycles through 3 hardcoded sponsor labels (indices 0-2).

**Solution:** The economy service maintains the currently active campaign for each placement type. When a `sponsor_impression` arrives:

```
1. Look up active campaign for placement_type = 'hud_frame'
2. If active campaign exists:
   - Log impression against that campaign
   - Deduct cost from campaign's spent_micros
   - If campaign budget exhausted → mark completed
3. If no active campaign:
   - Log as "house impression" (no charge, tracked for fill rate stats)
```

This keeps the engine completely decoupled from advertising. The engine doesn't know or care which campaign is running.

---

## Economy API (port 8720) — Fastify

### Player Accounts

```
POST   /players                    # { display_name } → { player_id, balance }
GET    /players/{id}               # → { id, display_name, balance, total_earned, total_spent }
GET    /players/{id}/transactions  # ?page=1&limit=50 → { transactions[], total }
```

### Internal (called by event bridge only)

```
POST   /internal/ingest           # { player_id, session_id, event }
                                  # Idempotent — deduplicates by event_id
```

### Credit Operations (manual / Phase 2)

```
POST   /credits/award    # { player_id, amount, reason, idempotency_key }
POST   /credits/spend    # { player_id, amount, reason, idempotency_key } — fails if insufficient balance
```

### Tracking

```
GET    /tracking/events?player_id={id}&type={type}&since={iso}  → { events[] }
GET    /tracking/summary?player_id={id}  → { total_earned, total_spent, balance, impressions }
```

---

## Ad Portal API (port 8730) — Fastify

### Advertiser Accounts

```
POST   /advertisers/register  # { email, password, company_name, contact_name }
POST   /advertisers/login     # { email, password }  # → { token }  (MVP: simple bearer)
GET    /advertisers/me        # → { id, email, company_name }  (requires auth)
```

### Campaigns (require advertiser auth)

```
POST   /campaigns             # { name, placement_type, budget_micros, daily_cap_micros, start_date, end_date }
GET    /campaigns             # List my campaigns
GET    /campaigns/{id}        # Campaign details + stats
POST   /campaigns/{id}/pause
POST   /campaigns/{id}/resume
POST   /campaigns/{id}/creative  # multipart upload → { creative_id }
```

### Approval Queue (admin)

```
GET    /admin/pending              # List pending creatives
POST   /admin/approve/{creative_id}
POST   /admin/reject/{creative_id} # { reason }
```

### Reporting

```
GET    /campaigns/{id}/report  # { impressions, spend, pacing, ctr }
```

---

## SQLite Schema

### Economy DB (`~/.signal-rush/economy.db`)

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    total_earned INTEGER DEFAULT 0,
    total_spent INTEGER DEFAULT 0,
    balance INTEGER DEFAULT 0 CHECK(balance >= 0)
);

CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    type TEXT NOT NULL CHECK(type IN ('award', 'spend')),
    amount INTEGER NOT NULL CHECK(amount > 0),
    reason TEXT NOT NULL,
    event_id TEXT UNIQUE,          -- idempotency key from bridge
    source_event_types TEXT,       -- JSON array of engine event types that triggered this
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_events (
    id TEXT PRIMARY KEY,
    player_id TEXT REFERENCES players(id),
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    credits_delta INTEGER DEFAULT 0,
    metadata TEXT,                 -- JSON blob with event-specific fields
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ad_impressions (
    id TEXT PRIMARY KEY,
    campaign_id TEXT,              -- NULL = house impression (no campaign)
    player_id TEXT REFERENCES players(id),
    placement_type TEXT DEFAULT 'hud_frame',
    cost_micros INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_player ON transactions(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_event ON transactions(event_id);
CREATE INDEX IF NOT EXISTS idx_game_events_session ON game_events(session_id);
CREATE INDEX IF NOT EXISTS idx_game_events_player ON game_events(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ad_impressions_campaign ON ad_impressions(campaign_id, created_at);
```

### Ad Portal DB (`~/.signal-rush/ads.db`)

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS advertisers (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    company_name TEXT NOT NULL,
    contact_name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    is_active INTEGER DEFAULT 1 CHECK(is_active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    advertiser_id TEXT NOT NULL REFERENCES advertisers(id),
    name TEXT NOT NULL,
    placement_type TEXT NOT NULL CHECK(placement_type IN ('hud_frame', 'interstitial')),
    budget_micros INTEGER NOT NULL CHECK(budget_micros > 0),
    spent_micros INTEGER DEFAULT 0 CHECK(spent_micros >= 0),
    daily_cap_micros INTEGER,
    start_date TEXT NOT NULL,      -- ISO 8601
    end_date TEXT NOT NULL,        -- ISO 8601
    status TEXT DEFAULT 'pending'
        CHECK(status IN ('pending', 'active', 'paused', 'completed', 'rejected')),
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS creatives (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id),
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    status TEXT DEFAULT 'pending'
        CHECK(status IN ('pending', 'approved', 'rejected')),
    rejection_reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_campaigns_advertiser ON campaigns(advertiser_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_creatives_campaign ON creatives(campaign_id);
CREATE INDEX IF NOT EXISTS idx_creatives_status ON creatives(status);
```

---

## Integration Points (Zero Engine Changes)

Two files are modified/added in the Signal Rush project:

### 1. `src/core/eventBridge.js` (NEW)

Called by the CLI after `engine.step()`. Responsibilities:
- Diffs `engine.state.credits` (captured before/after step)
- POSTs a single payload to `http://localhost:8720/internal/ingest` with `credits_delta`
- **Graceful degradation:** if economy service is down, log to a local queue file and retry later. Gameplay is NEVER blocked by economy service availability.
- **No double-counting:** sends one `credits_delta` per step, not per event. Events array is for analytics context only.

```javascript
// Pseudocode — actual implementation handles edge cases
async function forwardStep(playerId, sessionId, engine, events, creditsBefore) {
  const creditsDelta = engine.state.credits - creditsBefore;
  const payload = {
    player_id: playerId,
    session_id: sessionId,
    credits_delta: creditsDelta,
    events: events,
    timestamp: new Date().toISOString(),
  };
  try {
    await fetch('http://localhost:8720/internal/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(500), // 500ms timeout — don't block game loop
    });
  } catch (err) {
    // Service down or slow — queue locally, never block the game
    queueForRetry(payload);
  }
}
```

### 2. `src/cli/index.js` — Modified (minimal)

One change: after `engine.step(input)` on line 145, capture the events and call the bridge:

```javascript
// Before step:
const creditsBefore = engine.state.credits;

// Existing line 145:
engine.step(input);

// After step (new):
const events = engine.state.lastEvents;
eventBridge.forwardStep(playerId, sessionId, engine, events, creditsBefore)
  .catch(() => {}); // already handled inside bridge
```

The CLI needs a `playerId` and `sessionId`. For MVP:
- `playerId` = generated on first run, stored in `~/.signal-rush/player.json`
- `sessionId` = UUID per run (generated on engine start or restart)

---

## Pre-Existing Bug Note

`persistence.js` has a `recordCredits(state, credits)` function (line 152-154) that tracks `totalCredits` in `~/.signal-rush/state.json`. This function is **never called** from `embedded.js` or `index.js`. The engine modifies `state.credits` in-memory but `totalCredits` in the JSON state file will always be 0.

**Our economy.db SQLite ledger REPLACES this.** We do not fix the old bug — we supersede it with a proper ledger.

---

## MVP Build Order (No Regressions)

Baseline: 111 tests pass. This must remain true after every step.

| Step | What | Verify | Regression Check |
|------|------|--------|-----------------|
| 1 | Create `economy/schema.sql` + `economy/ledger.js` | Unit tests: create player, award, spend, balance | `npm test` still 111 |
| 2 | Create `economy/service.js` (Fastify) | `curl` endpoints return correct data | `npm test` still 111 |
| 3 | Create `src/core/eventBridge.js` with credit diffing | Unit test: diff picks up slot credits, level credits, pickup credits | `npm test` still 111 |
| 4 | Wire eventBridge into `src/cli/index.js` (minimal) | Play a run, check economy.db has transactions | `npm test` still 111 |
| 5 | Create `ads/schema.sql` + `ads/service.js` | Advertiser can register, create campaign, upload creative | `npm test` still 111 |
| 6 | Create `ads/templates/` portal UI | Browser: signup → campaign → report | `npm test` still 111 |
| 7 | Create `dashboard/` read-only views | Dashboard shows live economy + ad data | `npm test` still 111 |
| 8 | End-to-end: play → earn → ledger → dashboard | Full loop verified with real data | `npm test` still 111 |

---

## MVP Non-Goals

- Real token provider integration (Phase 2)
- Fraud detection (instrument now, detect later)
- Real payment processing (payment stub only)
- Near-miss credit awards (Phase 2 economy tuning)
- Multi-machine sync (single Z440 only)
- WebSocket real-time updates (polling is fine)
- Ad creative auto-approval (manual only for MVP)

---

## Security Notes

- All services bind to `localhost` only — no external exposure
- Economy ingest API has no auth for MVP (local only) — add API keys before any external exposure
- Ad portal uses bcrypt password hashing
- SQLite WAL mode for concurrent read safety
- All API inputs validated
- Campaign spending is checked atomically (spent + cost <= budget)**
