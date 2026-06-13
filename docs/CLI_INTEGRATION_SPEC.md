# Signal Rush CLI Integration Spec

## Objective
Support a version of Signal Rush that can run meaningfully inside CLI agent chat environments such as Codex CLI or Claude Code style interfaces.

## Important Constraint
A browser reflex game and a CLI-chat game are not identical products.
We should share core logic where possible, but interaction design must adapt to the medium.

## Strategy
Build a shared game engine and separate renderers.

## Shared Layer
- Session rules
- Hazard spawning
- Pickup logic
- Combo and score logic
- Reward calculation

## CLI-Specific Challenges
- Limited real-time input fidelity
- Terminal rendering constraints
- Potential latency in streamed interfaces
- Harder ad presentation rules
- Lower precision compared with browser keyboard play

## CLI MVP Approaches
### Option A: Turn-sliced reflex simulation
Short windows where the player chooses moves rapidly from constrained options.

### Option B: Terminal arcade mode
Use keyboard input in a local terminal app with text or ASCII rendering.

### Recommendation
Start with browser as the primary live-reflex experience.
For CLI support, prioritize terminal-native mode over pure conversational chat mode, because real-time gameplay will otherwise feel weak.

## Ad Implications
- Passive sponsorship banners in terminal frame or splash state
- Interstitial text cards between runs
- Must remain clearly separated from gameplay state

## Success Criteria
- Shared rules engine works in both browser and terminal contexts
- CLI mode still feels skill-based, not random
- Ads do not break command readability
