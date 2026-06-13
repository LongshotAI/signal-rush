# Signal Rush Project Plan

## 1. Objective
Build a technically credible, highly replayable reflex minigame that can:
- Capture user attention with short, skillful sessions
- Generate ad impressions without degrading gameplay
- Reward players with redeemable platform credits
- Support a web-based advertiser portal for partner onboarding and campaign management
- Eventually work inside CLI agent chat surfaces like Codex CLI or Claude Code style environments

This plan supersedes any implication that the project is already "done". What exists today is only a first MVP scaffold, not a production-ready product.

## 2. Current State
Already built:
- A lightweight placeholder MVP in `signal-rush-mvp/`
- Basic gameplay loop prototype
- Placeholder monetization surfaces
- MVP notes and asset backlog

Not yet built:
- Production architecture
- Advertiser portal
- Real economy logic
- Analytics
- Fraud prevention
- CLI-chat integration layer
- Live ad serving
- Asset pipeline
- Deployment and ops
- Robust mobile support
- Backend APIs

## 3. Product Thesis
Signal Rush is a short-session reflex game with a strong skill gradient.
Players enter fast rounds, dodge hazards, collect signal, and optimize combo chains.
Advertisers pay for inventory exposure.
Players earn platform credits redeemable toward AI usage or other utility inside the broader ecosystem.

Core principle:
Ads must feel embedded around the loop, not pasted over the fun.
If gameplay is not smooth, the business model fails.

## 4. Experience Design Goals
### Player goals
- Learn in under 10 seconds
- Feel immediate control precision
- Want one more run
- Understand reward logic clearly
- Trust that earning is fair

### Advertiser goals
- Fast sign-up
- Clear inventory options
- Transparent reporting
- Campaign controls without complexity
- Brand-safe placement definitions

### System goals
- Low-friction web MVP first
- Architecture that can later extend to chat-native and mobile contexts
- Strong telemetry from day one
- Safe separation between gameplay, ads, rewards, and admin systems

## 5. Recommended Game Design Direction
### Working concept
A neon-grid survival reflex game.
The player controls a node that moves through a bounded arena.
Hazards, pickups, and timing windows create overlapping pressure.

### Core mechanics
- Movement with keyboard first, touch later
- Short dash or burst move with cooldown
- Hazard avoidance
- Signal pickup collection
- Combo multiplier for clean routing
- Progressive wave intensity
- Session duration target: 20 to 45 seconds

### Why this works
- Easy to learn
- High skill ceiling via routing and risk timing
- Strong replay loop
- Easy to instrument analytically
- Good fit for short ad-trigger windows

## 6. Smooth Playability Requirements
Before calling the game viable, it should meet these standards:
- Tight input latency
- Framerate stable at 60fps on ordinary laptops
- Predictable collision handling
- Clear telegraphing of hazards and pickups
- No clutter obscuring the player hitbox
- Readable UI at small sizes
- Dash/recovery timing tuned so mistakes feel fair
- Session restart under 1 second

### Playtest checklist
- Does movement feel exact?
- Does the player always understand why they got hit?
- Are pickups satisfying to route toward?
- Is difficulty ramping too early or too late?
- Does the combo system reward skill instead of luck?
- Are ads interrupting flow too aggressively?

## 7. Monetization Model
### Initial player economy
- Internal platform credits only
- Credits earned from score, survival time, combo, and daily bonuses
- Optional rewarded actions later for bonus credits
- Credits redeemable for AI API token credits

### Initial ad model
- Light passive display in HUD frame or shell
- Interstitial between runs only, never during active play
- Frequency-capped
- Future rewarded placements optional

### Guardrails
- No ad overlay on the core playfield
- No forced mid-run interruptions
- No misleading reward wording
- No exploit path where bots farm credits cheaply

## 8. Advertiser Portal MVP
A separate web portal for ad partners should include:

### Core features
- Partner signup / login
- Create campaign
- Upload creative assets
- Choose placement types
- Set budget and dates
- View basic reporting
- Pause / resume campaign

### Admin review layer
- Manual approval queue for creatives and partners
- Placement policy definitions
- Brand safety review
- Fraud / anomaly monitoring dashboard later

### MVP reporting
- Impressions
- Estimated unique sessions
- CTR if clickable surfaces exist
- Spend pace
- Campaign status

## 9. CLI Agent Chat Integration Direction
This needs its own track. A web game and a chat-native game are related but not identical.

### Likely architecture
1. Core game logic as a deterministic engine module
2. Web renderer for browser play
3. Chat adapter for CLI/agent surfaces
4. Reward and ad service layer shared across both

### Chat-native constraints
- Text UI or lightweight terminal graphics
- Input latency depends on chat shell behavior
- Need turn-safe or stream-safe controls
- Ad presentation must be non-intrusive and explicit
- Sessions may be asynchronous rather than real-time

### Recommendation
Do not treat chat-native support as a trivial port.
Design the gameplay engine separately from rendering so the same systems can power:
- Browser version
- Terminal/CLI version
- Future mobile client

## 10. Technical Architecture Recommendation
### Frontend
- Phase 1 prototype: plain JS or Phaser in browser
- Production lean: Phaser + React shell
- Mobile later via responsive web or wrapper

### Backend
- Node/TypeScript service
- Auth
- Campaign management APIs
- Rewards ledger
- Analytics/event pipeline
- Admin moderation tools

### Data domains
- Players
- Sessions
- Scores
- Credit ledger
- Campaigns
- Creatives
- Placements
- Impression events
- Redemption events

## 11. Delivery Phases
### Phase 0: Product and system design
- Lock game loop
- Define ad surfaces
- Define credit economy
- Define portal requirements
- Define chat-native architecture boundary

### Phase 1: Gameplay vertical slice
- Tighten core movement and collisions
- Add deterministic spawn tuning
- Add score and reward tuning
- Add restart flow and polish
- Add telemetry hooks

### Phase 2: Backend foundation
- Player session storage
- Credit ledger
- Redemption stub
- Analytics event ingestion

### Phase 3: Advertiser portal MVP
- Signup/login
- Campaign creation
- Creative upload
- Basic dashboard

### Phase 4: Ad serving integration
- Serve passive placements
- Interstitial scheduling
- Frequency caps
- Reporting hooks

### Phase 5: CLI/terminal adaptation
- Engine extraction if needed
- Text/terminal renderer
- Input design for chat-native usage
- Reward/placement policy adaptation

### Phase 6: Production hardening
- Anti-abuse checks
- Performance testing
- Security review
- Deployment pipeline
- Observability

## 12. Immediate Next Actions
1. Review the current `signal-rush-mvp/` scaffold against this plan
2. Refactor into a cleaner project structure instead of calling the placeholder build complete
3. Separate game engine, rendering, economy stubs, and portal requirements
4. Add a dedicated architecture doc for CLI-chat compatibility
5. Decide whether to continue in vanilla JS or move now to Phaser + React shell

## 13. Risks
- Overstating MVP completeness too early
- Ads harming retention if inserted badly
- Reward economy being botted or exploited
- Building portal and game without shared metrics model
- Assuming browser interaction patterns translate directly to CLI chat
- Web3 aesthetic becoming gimmicky instead of clean and legible

## 14. Surgical Recommendation
Treat the current MVP as a concept proof, not the finished build.
Create a dedicated project directory, keep the existing scaffold untouched, and evolve the project in clearly separated layers so nothing in the workspace gets broken.

## 15. Proposed Dedicated Project Directory on Z440
`signal-rush-project/`

Suggested structure:
- `signal-rush-project/PROJECT_PLAN.md`
- `signal-rush-project/ARCHITECTURE.md`
- `signal-rush-project/GAMEPLAY_SPEC.md`
- `signal-rush-project/AD_PORTAL_SPEC.md`
- `signal-rush-project/CLI_INTEGRATION_SPEC.md`
- `signal-rush-project/ROADMAP.md`
- `signal-rush-project/ASSETS/`
- `signal-rush-project/RESEARCH/`

This keeps the work isolated and reduces break risk.
