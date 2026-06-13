# Signal Rush Architecture

## Goal
Design the system so the game is smooth, monetizable, and adaptable across browser and CLI-chat environments without rewriting core logic.

## Architecture Principle
Separate:
1. Core game logic
2. Rendering layer
3. Rewards/economy
4. Ad decisioning and reporting
5. Advertiser/admin portal

## Proposed Layers

### 1. Game Engine
Responsibility:
- Player state
- Arena state
- Hazards
- Pickups
- Collision logic
- Combo logic
- Difficulty ramp
- Session end conditions

Requirements:
- Deterministic or mostly deterministic state stepping
- No direct dependency on DOM
- Reusable by browser and CLI renderers

### 2. Web Renderer
Responsibility:
- Canvas rendering
- Input handling
- HUD display
- Passive ad frame placement
- Interstitial transitions between runs

### 3. CLI Renderer / Adapter
Responsibility:
- Translate engine state into terminal-friendly display
- Accept constrained input modes
- Handle lower-fidelity interaction loops
- Present ads in compliant, readable ways

### 4. Economy Service
Responsibility:
- Credit earnings rules
- Reward calculation
- Redemption logic
- Fraud prevention flags
- Ledger persistence

### 5. Ad Service
Responsibility:
- Placement inventory definitions
- Campaign targeting rules
- Frequency caps
- Impression logging
- Basic reporting aggregation

### 6. Advertiser Portal
Responsibility:
- Partner onboarding
- Creative management
- Campaign creation/editing
- Spend/status dashboard

### 7. Admin Layer
Responsibility:
- Creative review
- Partner approval
- Abuse monitoring
- Manual overrides

## High-Level Flow
1. Player starts run
2. Game engine simulates session
3. Renderer displays play state
4. Events emitted during play
5. Session ends
6. Reward calculation performed
7. Eligible interstitial slot may render
8. Impression and reward events stored

## Event Types to Track
- session_started
- session_ended
- pickup_collected
- hazard_hit
- combo_changed
- credits_awarded
- ad_passive_viewed
- interstitial_served
- campaign_clicked
- credits_redeemed

## Why This Matters
If we mix rendering, ads, and game rules in one layer, the game gets brittle and CLI adaptation becomes painful.
A separated architecture gives us smoother iteration and safer future integration.
