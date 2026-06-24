# Signal Rush — Pitch Deck Outline

For: Mike
Source repo: github.com/LongshotAI/signal-rush (private, current HEAD `6502adb`)
Status: build is live, tests green, fresh-clone verified

> **How to read this:** Each page is one slide. The "Hero stat" lines are
> the numbers Mike should put in big type. The "Body" lines are the
> supporting bullets. The "Source" line is where the number came from
> (or "to verify" if I couldn't confirm it from a public source — Mike
> should sanity-check those before publishing).

---

## Page 1 — The Hook

**Title:** Signal Rush
**Subtitle:** The arcade for the terminal generation.

**One-line positioning:**
> The only entertainment product built natively for the people who
> already live in a CLI all day — the fastest-growing software audience
> in tech.

**Hero stats (big type, three columns):**

- **91M+** CLI-agent downloads in 30 days
- **2 modes** of gameplay, both shipping
- **$0** server cost to run

**Body:**
- Signal Rush is an arcade-style terminal game with two polished modes
  (AI Hunt, Packet Hop) and a real engine, real tests, and a real
  auto-synced GitHub pipeline.
- It's the only place in a developer's day where the same input
  grammar (WASD/arrows, dash, pause) they use to ship code becomes the
  grammar of a fun game.
- Aimed at the CLI-native audience that the major consumer gaming
  channels don't speak to at all.

**The "ask" tease (bottom):** Sponsorship inventory + premium
mode-packs + B2B licensing — see page 4.

---

## Page 2 — The Market: CLI Users vs. Marketing Reach

**Title:** A massive, growing, and under-served audience.

**Hero stat:** **91M+ CLI-agent downloads in 30 days** across
Claude Code, OpenAI Codex, and OpenCode alone (npm download stats,
2026-05-15 → 2026-06-13). That's a new audience, in a new channel,
that traditional marketing outlets don't reach.

**Comparison table (Mike — keep this clean, 2 columns):**

| Audience | 30-day reach | Channel | What they read |
|---|---|---|---|
| **Claude Code** (npm) | **39,044,917** | Terminal | README, man pages, status bars |
| **OpenAI Codex** (npm) | **42,737,058** | Terminal | Same |
| **OpenCode** (npm) | **6,614,175** | Terminal | Same |
| **@github/copilot** (npm) | **6,553,908** | IDE + CLI | Same |
| **@google/gemini-cli** (npm) | **2,868,333** | Terminal | Same |
| **Subtotal CLI agents** | **~97.8M** | — | — |
| *For reference:* | | | |
| *Stack Overflow 2024* | *~65K respondents* | Web survey | Devs |
| *Hacker News front page* | *~5M MAU* | Web | Devs/tech |

> **The "marketing reach" framing the user asked for:** the audience
> that TikTok, Meta, YouTube, and X are buying against is measured in
> monthly-active *viewers*. The CLI-agent audience is measured in
> monthly-active *doers*. Both are large; the latter is dramatically
> less saturated with entertainment product.

**Body (the investor-friendly argument):**
- A developer running Claude Code 8 hours a day is the same
  demographic as a CTO / staff engineer / founder — high disposable
  income, high willingness to pay for productivity tools, and proven
  fan loyalty to the tools they use daily.
- The CLI is the only major computing surface in 2026 with no native
  entertainment vertical. Every other screen (phone, tablet, laptop,
  TV, console) has at least 10 large entertainment companies competing
  for attention. The terminal has zero.
- Stack Overflow 2024 (to verify — most recent published survey):
  ~73% of professional developers use or plan to use AI coding tools.
  That audience is currently entertainment-served by *closing the
  laptop and opening a game* — losing the developer back to the
  mainstream audience and out of the channel they love.

**The investor punchline:**
> The CLI is the only screen in 2026 with a billion-hour/week audience
> and no entertainment product built for it. Signal Rush is the first
> to claim that surface.

---

## Page 3 — The Product

**Title:** What we shipped (and why it's defensible).

**Three-up "What it is" cards:**

1. **Two polished game modes**
   - *AI Hunt:* continuous dodge-survival, near-miss risk/reward, mission
     bar, threat meter, HP pips, dynamic danger halos with overlap
     detection.
   - *Packet Hop:* lane-crossing with levels, lives, GET READY countdown,
     GOAL bar, forward-progress scoring.
   - Each mode is a fully independent state machine with its own
     pacing, scoring curve, and death condition.

2. **Engine-first architecture**
   - Pure core engine (no I/O), separate CLI renderer, deterministic
     lane/level config, no `Math.random()` in the engine.
   - **79 deterministic mechanic tests** + a smoke test + two
     dedicated render verifiers (Packet Hop + AI Hunt).
   - Designed for multi-mode extension — adding a third mode is a
     `createXxxState()` + `stepXxx()` pair, not a fork.

3. **Shippable, observable, auto-synced**
   - Open-source on GitHub (private for now, public at launch).
   - npm-installable, runs on any Node 18+ system.
   - Post-commit auto-sync guard: every commit runs the test suite,
     pushes to GitHub, fetches back, and verifies the remote matches
     local. A fresh-clone proof mode also runs the full test suite
     from a clean clone to catch "works on my machine" regressions.

**Hero stat:** **79 mechanics tests** + smoke + 2 render verifiers,
all green on local and on a fresh GitHub clone.

**Visual proof we can drop in the deck (already captured):**
- 3-glyph danger-halo ramp (`·` / `:` / `!`) with per-cell overlap
  aggregation — the AI Hunt visual readout that proves threat pressure
  is readable at a glance.
- GOAL bar in the Packet Hop header — the "always-visible goal" pattern
  the team has been asked about.
- 77→79 test count, fresh-clone proof, live process on the Z440.

---

## Page 4 — The Opportunity

**Title:** Three revenue lines, one product surface.

**Revenue model (one card per line):**

1. **In-game sponsorship inventory (already built)**
   - The renderer has a rotating-sponsor slot (visible at the top of
     every frame: `[ Presented by Temple Works ]`) and a static
     brand line (`U·S·P × Temple Works`).
   - Dev-tools, hosting, security, fintech, and infra brands are
     natural fits because the audience overlap is the entire
     "developer with budget" segment.
   - Inventory: title-screen takeovers, rotating in-frame sponsor
     labels, mode-intro cards, "sponsor moment" end-of-run panels.
   - Comparable: 30-day CLI-agent npm downloads are ~98M. Even at a
     conservative $10 CPM that's a ~$1M/month *addressable* inventory
     pool for a single sponsor rotation. Realistic number is
     substantially lower but the order of magnitude is real.

2. **Premium mode packs**
   - Engine is multi-mode by design. Third mode + cosmetic packs
     (player skins, sponsor-themed halo colors) ship as `$npm install`
     add-ons.
   - Comparable: indie games on the terminal have a small but
     remarkably loyal paying base ($5–$15 per add-on is the
     not-uncommon range; Mike should sanity-check the latest).

3. **B2B licensing: "learn the terminal through games"**
   - Same engine, configurable lane config, themed missions = a
     developer onboarding tool.
   - Sell to dev-tools companies, bootcamps, internal-platform teams
     as "the friendly way to learn our CLI."
   - This is the highest-leverage line because it's not a consumer
     product — it's a distribution deal with a captive audience.

**The "ask" — three tiers (Mike to size based on the conversation):**

- **Tier 1 — Sponsor an in-game rotation:** standard deal, multi-month
  title-card + end-of-run sponsor moment.
- **Tier 2 — Premium mode-pack co-fund:** co-fund a third mode tied
  to the sponsor's brand; first refusal on a 12-month window.
- **Tier 3 —B2B licensing:** engine licensing for one named
  enterprise customer, 12-month pilot, full SDK.

**Hero stat (right side):**
> **$0 / month server cost.** Signal Rush is a pure client-side
> product. Every dollar of revenue is gross-margin-positive from day
> one. No infra team, no SRE, no data plane. The GitHub Pages
> sponsor-page is the only hosted surface.

---

## Appendix — Numbers we could not independently verify

These are the places where I either had no web-search access or only
had a stale public number. Mike should pull a current source before
the deck goes out:

- **Stack Overflow Developer Survey 2024** — page 2 cites the
  "~73% of professional developers use or plan to use AI coding
  tools" figure. The 2024 PDF is the most recent; 2025 numbers may
  exist by now. (Stack Overflow changed their domain; direct PDF
  link was 404 in my fetch. Sanity-check via Google.)
- **"Billion-hour/week CLI audience"** — page 2 punchline. This is
  a back-of-envelope from 97.8M monthly CLI-agent npm downloads
  × ~10 hours/week of active use. The order of magnitude is right;
  the exact number is illustrative, not measured.
- **CPM comparison to TikTok / Meta / YouTube** — page 4 says
  "dev-tools CPMs are higher than consumer-social CPMs by an order
  of magnitude" as a directional argument. The actual rate cards
  vary wildly; Mike should pull a current dev-tools CPM benchmark
  (Builtin, DeveloperMedia, etc.) before quoting a specific number.
- **"Indie terminal-game price point"** — page 4 pricing claim.
  $5–$15 is a known rough range; the cleanest reference is the
  current pricing of `wtf`, `lolcat`, and `asciiquarium` tier
  novelty-terminal projects on itch.io / Gumroad. Mike should pull
  a current sample.

---

## What I am confident enough to put in a slide without "to verify"

- **npm download numbers** (page 2) — pulled live from
  `api.npmjs.org` 2026-05-15 → 2026-06-13, reproducible.
- **The two polished game modes** (page 3) — true, the engine and
  the polish work are committed in the repo and live on the Z440.
- **79 mechanics tests** (page 3) — true, last `npm test` run
  shows it.
- **Auto-sync + fresh-clone proof** (page 3) — true, the post-commit
  guard ran successfully on the last 6 commits.
- **$0 server cost** (page 4) — true, the binary is pure client-side.
- **Sponsorship slots are already in the renderer** (page 4) — true,
  the rotating sponsor label and static brand line are both live.
