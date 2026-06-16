# Signal Rush MVP Spec

## Product Positioning

`Signal Rush` is a web-first reflex survival game with a crypto-native visual language and platform-credit rewards redeemable for AI utility.

## MVP Goals

- Prove the core loop is fun in sessions under 45 seconds
- Validate that score, combo, and credit gain create replay pressure
- Establish ad placement without contaminating gameplay readability
- Create a prototype shell that can be reskinned and extended later

## Core Loop

1. User lands on the game page.
2. User starts a run immediately with no onboarding wall.
3. User dodges hazards and collects signal pickups.
4. User earns score and platform credits during the run.
5. Run ends, interstitial placeholder appears, restart is one click.

## MVP Systems

### Gameplay

- Top-down arena survival
- Enemy orbs spawn from edges and track toward the player
- Pickups spawn in-risk positions to create route decisions
- Dash adds burst expression and recoverability
- Combo increases when pickups are chained without taking damage

### Economy

- Credits awarded per pickup and survival score
- No wallet, no account system, no on-chain logic in MVP
- Redeem flow remains mocked in this stage

### Monetization Surfaces

- Passive ad slot in HUD frame
- Interstitial placeholder after failed run
- No rewarded video flow in MVP yet

### UX

- One-screen presentation
- Instant restart
- Desktop keyboard first
- Mobile deferred until control model is proven

## Post-MVP Priorities

1. Add daily challenge and streak systems
2. Add enemy types and pattern waves
3. Add mocked store or redeem panel for credits
4. Port to Phaser for cleaner collision, scenes, and mobile input
5. Add analytics events for retention and run quality
