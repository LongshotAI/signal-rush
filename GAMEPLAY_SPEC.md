# Signal Rush Gameplay Spec

## Core Fantasy
You are routing a signal node through a hostile data field.
Survive, collect signal, and chain precision movement under pressure.

## MVP Loop
- Start run instantly
- Move through arena
- Avoid hazards
- Collect signal pickups
- Build combo multiplier
- Survive as long as possible
- Convert performance into platform credits
- Restart fast

## Controls
### Web MVP
- WASD / arrow keys to move
- Space or shift to dash
- Mouse/touch support later

### Design targets
- Immediate acceleration response
- Predictable deceleration
- Dash with short cooldown
- No sluggish controls

## Arena Design
- Single bounded arena
- Clean geometry
- High contrast background grid
- No scrolling camera in MVP

## Objects
### Player node
- Small readable hitbox
- Bright outline
- State feedback for damage/dash

### Hazards
- Distinct visuals
- Telegraph before spawn when possible
- Multiple hazard classes later

### Pickups
- Clear attractor visuals
- Reward pathing skill
- Support combo chain logic

## Difficulty Curve
- Start gentle
- Ramp every few seconds
- Increase spawn density and pattern overlap
- Introduce pressure without unreadable clutter

## Skill Depth Sources
- Route planning under pressure
- Dash timing
- Greedy pickup risk decisions
- Maintaining combo streaks
- Recovery after mistakes

## Failure Rules
- Health depletion or survival fail condition
- Run ends immediately with summary screen
- Restart in under 1 second

## MVP Success Criteria
- Feels good in first 30 seconds
- Players understand rules almost instantly
- High-score chase feels natural
- Skill improvement is visible across runs
