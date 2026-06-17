# Signal Rush Token Economy — MVP Spec

## Purpose
A closed-loop token distribution system for the Signal Rush game. Players earn credits through gameplay, tracked in a ledger. A separate ad portal lets advertisers manage campaigns. Everything runs on the Z440 — no external cloud dependencies.

**Key principle: The game engine NEVER imports the token system.** It emits events. The economy service consumes them. No shared mutable state.

---

## Architecture

```
signal-rush/
├── src/
│   ├── core/
│   │   ├── engine.js          # Already emits events — NO CHANGES
│   │   └── eventBridge.js     # NEW: forwards events to economy service
│   └── economy/               # NEW — token distribution service
│       ├── service.js         # FastAPI app, port 8720
│       ├── ledger.js          # SQLite operations
│       ├── schema.sql         # DB schema
│       └── tracking.js        # Analytics event logging
├── ads/                       # NEW — advertiser portal
│   ├── service.js             # FastAPI app, port 8730
│   ├── schema.sql             # DB schema
│   ├── templates/             # Jinja2 HTML templates
│   └── static/                # CSS/JS
└── dashboard/                 # NEW — read-only tracking dashboard
    ├── service.js             # FastAPI app, port 8740
    └── templates/
```

### Port Map (all localhost)

| Service | Port | Purpose |
|---------|------|---------|
| Game engine | (library) | No server — called by CLI or web frontend |
| Economy | 8720 | Credit ledger, award/spend, player accounts |
| Ad Portal | 8730 | Advertiser CRUD, campaign config, approval queue |
| Dashboard | 8740 | Read-only view of tokens, ads, transactions |

---

## Data Flow

```
                    ┌──────────────┐
                    │  GAME ENGINE  │  emits events (no import)
                    │  (engine.js)  │
                    └──────┬───────┘
                           │ events array returned by step()
                           ▼
                    ┌──────────────┐
                    │ EVENT BRIDGE  │  HTTP POST to economy
                    │(eventBridge.js│  port 8720
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  LEDGER   │ │ TRACKING │ │  AD MGR  │
        │ (SQLite)  │ │ (SQLite) │ │ port 8730│
        └──────────┘ └──────────┘ └──────────┘
              │            │            │
              └────────────┼────────────┘
                           ▼
                    ┌──────────────┐
                    │ DASHBOARD     │
                    │ port 8740     │
                    └──────────────┘
```

---

## Event Types (from engine.js — already emitted)

These are the events the engine already produces that the economy service cares about:

| Event Type | When | Credit Relevance |
|------------|------|------------------|
| `credits_awarded` | Player collects pickup in AI Hunt | Already has `credits` field |
| `pickup_collected` | Player touches pickup | Score value → credit conversion |
| `near_miss` | Player dodges hazard at range 1 | Near-miss bonus credits |
| `home_slot_filled` | Frogger slot cleared | Already adds credits to state |
| `level_cleared` | All 5 Frogger slots filled | Time bonus → credits |
| `run_ended` | Game over (death) | Final score snapshot |
| `sponsor_impression` | Every N ticks | Ad impression → advertiser billing |
| `run_restarted` | Player presses R | New session tracking |

**Key insight:** The engine already credits `state.credits` on pickups (line 600-601) and home slots (line 261, 268). We just need to **capture and persist** these events externally.

---

## Economy API (port 8720)

### Player Accounts

```
POST   /players                    # Register player
GET    /players/{id}               # Get player + balance
GET    /players/{id}/transactions  # Paginated transaction history
```

### Credit Operations

```
POST   /credits/award    # { player_id, amount, reason, event_id, metadata }
POST   /credits/spend    # { player_id, amount, reason, event_id }
POST   /credits/redeem   # { player_id, amount, token_provider, metadata }
```

### Tracking

```
GET    /tracking/events   # Query events (player, type, time range)
GET    /tracking/summary  # Aggregates: total earned, spent, ad impressions
```

---

## Ad Portal API (port 8730)

### Advertiser Accounts

```
POST   /advertisers/register
POST   /advertisers/login
GET    /advertisers/{id}/profile
```

### Campaigns

```
POST   /campaigns                          # Create campaign
GET    /campaigns?advertiser_id={id}       # List campaigns
GET    /campaigns/{id}                     # Get campaign details
POST   /campaigns/{id}/creative            # Upload creative asset
POST   /campaigns/{id}/pause               # Pause campaign
POST   /campaigns/{id}/resume              # Resume campaign
```

### Approval Queue (game operator)

```
GET    /admin/pending           # List pending creatives
POST   /admin/approve/{id}      # Approve creative
POST   /admin/reject/{id}       # Reject with reason
```

### Reporting

```
GET    /campaigns/{id}/report   # Impressions, spend, pacing
```

---

## SQLite Schema

### Economy DB (`~/.signal-rush/economy.db`)

```sql
CREATE TABLE players (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    total_earned INTEGER DEFAULT 0,
    total_spent INTEGER DEFAULT 0,
    total_redeemed INTEGER DEFAULT 0,
    balance INTEGER DEFAULT 0 CHECK(balance >= 0)
);

CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    type TEXT NOT NULL CHECK(type IN ('award', 'spend', 'redeem')),
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    event_id TEXT,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE game_events (
    id TEXT PRIMARY KEY,
    player_id TEXT,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    score_delta INTEGER DEFAULT 0,
    credits_delta INTEGER DEFAULT 0,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE ad_impressions (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    player_id TEXT,
    placement_type TEXT NOT NULL CHECK(placement_type IN ('hud_frame', 'interstitial')),
    cost_micros INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_transactions_player ON transactions(player_id, created_at);
CREATE INDEX idx_game_events_session ON game_events(session_id);
CREATE INDEX idx_ad_impressions_campaign ON ad_impressions(campaign_id, created_at);
```

### Ad Portal DB (`~/.signal-rush/ads.db`)

```sql
CREATE TABLE advertisers (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    company_name TEXT NOT NULL,
    contact_name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    is_active INTEGER DEFAULT 1
);

CREATE TABLE campaigns (
    id TEXT PRIMARY KEY,
    advertiser_id TEXT NOT NULL REFERENCES advertisers(id),
    name TEXT NOT NULL,
    placement_type TEXT NOT NULL CHECK(placement_type IN ('hud_frame', 'interstitial')),
    budget_micros INTEGER NOT NULL,
    spent_micros INTEGER DEFAULT 0,
    daily_cap_micros INTEGER,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'paused', 'completed', 'rejected')),
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE creatives (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id),
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
    rejection_reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
```

---

## Integration Points (Zero Engine Changes)

The engine already returns `state.lastEvents` after every `step()` call. The event bridge is a thin wrapper:

```javascript
// eventBridge.js — called by CLI or web frontend after each step()
const EVENTS = require('./src/core/engine');

async function forwardEvents(playerId, sessionId, events) {
  for (const event of events) {
    await fetch('http://localhost:8720/events/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: playerId, session_id: sessionId, event })
    });
  }
}
```

**The engine itself is never imported by the economy service.** The CLI/frontend sits in the middle and forwards events.

---

## MVP Build Order (No Regressions)

| Step | What | Verify |
|------|------|--------|
| 1 | Create `src/economy/` — schema + ledger.js | Unit tests for award/spend/redeem |
| 2 | Create `src/economy/service.js` — FastAPI app | `curl` endpoints return correct data |
| 3 | Create `src/core/eventBridge.js` | Bridge forwards events, handles service-down gracefully |
| 4 | Wire CLI to call eventBridge after each step | Play a run, check ledger updates |
| 5 | Create `ads/` — schema + service.js | Advertiser can register, create campaign |
| 6 | Create `ads/templates/` — portal UI | Browser test: signup → campaign → report |
| 7 | Create `dashboard/` — read-only views | Dashboard shows live data from economy + ads |
| 8 | End-to-end test: play → earn → spend → dashboard | Full loop verified |

---

## MVP Non-Goals

- Real token provider integration (Phase 2)
- Fraud detection (instrument now, detect later)
- Real payment processing (payment stub only)
- Multi-machine sync (single Z440 only)
- Real-time WebSocket updates (polling is fine for MVP)

---

## Security Notes

- All services bind to `localhost` only — no external exposure
- Economy API has no auth for MVP (local only) — add API keys before any external exposure
- Ad portal uses bcrypt password hashing
- SQLite WAL mode for concurrent read safety
- Input validation on all API endpoints
