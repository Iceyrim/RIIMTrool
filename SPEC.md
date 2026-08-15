# N1 Unified Multi-Market Trading Bot — Architecture Spec

**Purpose of this document:** a complete build spec for a brand-new, single-codebase trading bot that natively supports multiple markets (starting with BTCUSD and ETHUSD, extensible to more). This is written from the accumulated, hard-won lessons of running two separate single-market bots (`n1-trading-assistant` for BTC, `n1-trading-eth` for ETH) in production. Every safety mechanism below exists because a real incident happened without it. Do not simplify away any of the "why" sections — they are the actual cost of the lesson.

**How to use this doc:** hand this to a fresh Claude Code (or Cowork) session in a brand-new, empty repository. Build incrementally, section by section, with a full paper-mode test suite and a soak test (minimum 5 minutes, ideally longer) before any live deployment. Never skip the paper→soak→commit→live sequence, for any change, ever.

---

## 1. Core Architecture Decision

**One process, N markets**, not N processes for N markets (the old model). Each market is configured as an entry in a markets array/config, and the engine loops over all configured markets each cycle — placing, cancelling, and reconciling per-market, but sharing one process, one risk-manager instance (with per-market sub-limits), and one dashboard.

**Why:** the old model (separate process per market) caused real, repeated pain:
- Every fix had to be manually ported between repos, and repeatedly drifted (found the exact same bug present in one repo and missing in the other, multiple times)
- Config values (env vars) had to be duplicated and kept in sync manually, and frequently weren't
- No single view of total account risk across markets without a separate aggregator service
- Wasted engineering time porting identical fixes twice, every time, all night

**What must be preserved from the old model despite unifying:** market-level isolation of *state*, even though the process is shared. A bug or a stuck reconciliation on ETH must never be able to block, corrupt, or delay BTC's trading loop. This is the single most important non-negotiable design constraint — see Section 4.

---

## 1b. Exchange Abstraction (Future Multi-DEX Support)

**This system will eventually connect to perp DEXs beyond N1.** This must be designed in from the start, not retrofitted — retrofitting an exchange abstraction after code has N1-specific assumptions baked throughout (order formats, position query shapes, reconciliation logic, SDK types) is a much larger and riskier job than building the seam up front.

**Design requirement:** the engine, risk manager, reconciliation logic, and dashboard must all operate against an **exchange-agnostic interface**, not against N1's SDK types directly. Concretely:

- Define a thin `ExchangeAdapter` interface (naming illustrative, adjust as needed) with the minimal set of operations every perp DEX integration must implement: `placeOrder`, `cancelOrder`, `getPositions`, `getOpenOrders`, `getBalances`, `getAccountVolume`, `getMarketPrice` (mark/index), and whatever authentication/connection lifecycle each exchange needs.
- N1's actual SDK (`@n1xyz/nord-ts`) calls live **only inside the N1 adapter implementation** — nowhere else in the codebase should import or reference N1-specific types.
- The engine, risk manager, and reconciliation logic work purely against the adapter interface's normalized types (a generic `Position`, `Order`, `Balance` shape), not against N1's raw response shapes. This was actually a real, live bug pattern in the old two-bot system even within a *single* exchange — code that assumed N1's specific object-keyed-by-accountId shape broke when a slightly different array-shaped response came from a different code path. An explicit normalization layer at the adapter boundary prevents this class of bug entirely, and becomes essential (not just nice-to-have) once a second exchange with genuinely different response shapes is added.
- Each market's config (Section 2) gains an `exchange` field identifying which adapter it uses, so the market-config loop can route to the correct adapter per market — this means, from day one, the system supports "BTCUSD on N1" and "BTCUSD on SomeOtherDex" as two independent, simultaneously-running market entries, without any special-casing.
- **Do not build a second adapter yet.** Build the N1 adapter fully, prove the whole system works end-to-end on N1 alone (per the build order in Section 10), and only then validate the abstraction is real by implementing a second, even a stub/testnet one, to confirm the interface boundary actually holds and nothing N1-specific leaked through. An abstraction that's never actually been used for a second implementation is unverified and likely wrong in some detail — treat "successfully add a second adapter" as the real test of whether Section 1b was done correctly, not just "the interface compiles."

**Why this matters more than it might seem:** every one of tonight's real bugs (Sections 5-6) came from subtle mismatches between what the code assumed about N1's behavior and what N1 actually did. Multiply "subtle exchange-specific assumption baked into shared code" across two or more genuinely different exchanges, each with their own SDK quirks, and the bug surface grows fast unless the boundary is real and enforced from the start.

---

## 2. Market Configuration

Each market is a config entry, not a separate `.env` file:

```
markets:
  - symbol: BTCUSD
    exchange: n1
    enabled: true
    orderSize: { min: 0.00155, max: 0.00232 }
    spreadBps: { normal: 5, min: 4, max: 7.5 }
    exitSpreadBps: 2.5
    quoteLevels: 5
    levelSpacingBps: [2, 3, 4, 7, 10]
    inventoryReductionThresholdBase: 0.003
    riskLimits: { maxLongPosition: 0.005, maxShortPosition: 0.005, maxOrderSize: 0.0025, maxOrderNotionalUsd: 160, maxOpenOrders: 12 }

  - symbol: ETHUSD
    exchange: n1
    enabled: true
    orderSize: { min: 0.045, max: 0.068 }
    spreadBps: { normal: 5, min: 4, max: 7.5 }
    exitSpreadBps: 2.5
    quoteLevels: 5
    levelSpacingBps: [2, 3, 4, 7, 10]
    inventoryReductionThresholdBase: 0.09
    riskLimits: { maxLongPosition: 0.15, maxShortPosition: 0.15, maxOrderSize: 0.075, maxOrderNotionalUsd: 160, maxOpenOrders: 12 }
```

The N1 realized-PnL policy is account-wide. Configuration has one top-level source of truth:
`accountRisk: { sessionLossCapUsd: 6 }`. It is enforced across every N1 market, and the N1 ledger
uses one account-wide cursor so an event cannot be consumed once per market. Per-market loss-cap
keys are invalid. Paper/stub/RISEx runners use the same account-risk abstraction against their own
local/shared account source; they do not use N1 ledger semantics.

**Current session loss cap:** one account-wide $6 cap. It is never displayed or enforced as
independent BTC and ETH PnL.

**Adding a new market** should be: add one entry to this config, no code changes required, restart. This was the whole point of unifying — verify this actually works before calling the unification complete.

---

## 3. Order Sizing & Spread — Current Proven Values

These are the values running live and validated through a full night of iteration, not starting guesses:

- **Multi-level quoting: 5 bids + 5 asks per market** (10 orders per market, 20 total across 2 markets)
- **Level spacing: 2, 3, 4, 7, 10 bps** from reservation price — deliberately tight cluster near mid (levels 1-3) then wider outer levels (4-5) to catch bigger moves. Equal size per level, not growing size — this was a deliberate first-version choice to keep risk bounded and easy to reason about; growing size at outer levels is a legitimate future refinement, not a starting point.
- **Literal (non-adaptive) per-level spacing** — the existing single-level adaptive-spread mechanism (widens spread when mark/index price gap grows) was deliberately NOT applied to the multi-level ladder in v1. This was a considered choice to keep the new ladder mechanism isolated and easier to debug on its first deployment. Switching to adaptive-per-level spacing is a planned, explicit follow-up once literal spacing is proven stable — do not silently combine these two behaviors without deciding to.
- **Normal spread: 5 bps** (halved from an original 10 bps after observing poor fill rates)
- **Exit spread: 2.5 bps** (half of normal spread) — but see Section 6, this alone is NOT sufficient; the refresh-cadence fix in Section 6 is what actually made exits work.
- **`N1_LIVE_MAX_OPEN_ORDERS` = 12** for a 5+5 ladder (10 needed, +2 headroom for transient overlap during whole-book cancel/replace cycles — this headroom was a deliberate choice, not an oversight, to avoid the hard cap itself becoming a race condition trigger)

---

## 4. Market Isolation Within a Shared Process — Non-Negotiable

This is the hardest and most important part of the unification. The old two-process model got this "for free" via OS-level process isolation; the new single-process model must deliberately rebuild it.

**Required isolation guarantees, all independently testable:**

1. **Reconciliation must be scoped per-market.** This was a real bug in the old system: a single shared reconciliation engine, if not filtered by market, will see the *other* market's positions/orders as "unknown" or "mismatched" and incorrectly block trading. The fix that was built: the reconciliation engine takes a `marketId` and filters the exchange snapshot to only that market's orders/positions before comparing. **This must exist from day one in the unified build, not be discovered as a bug again.**

2. **A stuck/crashed reconciliation loop for one market must not block another market's loop.** If BTC's reconciliation is retrying or degraded, ETH's quoting must continue unaffected. This likely means either separate async loops per market, or a per-market state machine that the shared scheduler treats independently.

3. **Risk limits are per-market, but the account/margin is shared** (this is real — N1 uses one cross-margined account for both markets). The risk manager needs: per-market position/order-size limits (hard-coded ceilings per market config), AND an awareness that margin usage is a shared, account-wide resource that both markets draw from. A large position in one market reduces available margin for the other — this must be visible to whatever computes "can I place this order," not assumed away.

4. **A single-instance lock must exist per-market OR per-process** — decide deliberately which. If per-process (recommended, simpler), the whole unified bot is one locked instance; if you ever need to run a second instance for testing against the same account, that's blocked entirely, which is probably fine and simpler to reason about.

5. **Order registries (local tracking state) must be keyed by market**, never a single flat list assumed to be one market's orders. Every "local positions/orders" data structure needs a market key, always, no exceptions — the old bugs (Section 5) were repeatedly caused by state files that didn't cleanly separate markets or that went stale independently per market without a clean per-market reset path.

**Test this explicitly before calling it done:** deliberately break one market (e.g., feed it bad/stale local state) and confirm the other market keeps trading normally, unaffected, in the paper test suite. This exact scenario caused real, expensive confusion in the old two-process system and must have a regression test in the new one.

---

## 5. Bugs Found and Fixed (Must Not Regress)

These three bugs were each found live, each cost real money before being caught, and each is now fixed and soak-tested in the old codebases. The unified build must include equivalent fixes from the start — do not rebuild the naive versions and rediscover these.

### 5a. Live position-tracking race condition (fill lost during cancel)
**Symptom:** local position tracking silently drifted from the real exchange position during live operation, specifically under rapid order replacement (worse at multi-level scale, since more orders = more replace cycles = more race windows).

**Root cause:** when cancelling an order to replace it, there's a race window where the order might have just filled on the exchange moments before the cancel request lands. The old code unconditionally marked the order "cancelled" without checking whether a fill happened in that gap — permanently losing that fill from the local position count, since a "cancelled" order is never re-checked.

**Fix required in the unified build:** before finalizing any order cancellation as `CANCELLED`, replay the order's trade history from the exchange first. If that replay reveals the order actually filled (fully or partially) in the race window, resolve it as `FILLED` (or partially filled) instead of blindly marking cancelled. This check must fail open (if the trade-history lookup itself errors, e.g. network hiccup, proceed with the original cancel rather than blocking cancellation — a fix for a race condition must never introduce a new stuck-order failure mode).

### 5b. Silent placement failure reported as success
**Symptom:** the bot logged "Placed N new quote(s)" every cycle, appearing to succeed, while a reduction-mode exit order never actually landed on the exchange — confirmed by reconciliation immediately after showing zero orders resting. This caused a real position to sit stuck, unmanaged, for roughly 12 hours before being caught.

**Root cause, two parts:**
- `placeOrder()`'s exchange-call wrapper: when the exchange call resolved *without throwing* but with no `orderId` and no `fills` (a silent no-op response), the code correctly marked the local order state `UNKNOWN` but still returned `success: true` to the caller — a straightforward logic bug, the opposite of what the state itself said.
- The caller-side logging: order-placement result arrays were logged by raw `.length` (e.g. `Placed ${results.length} new quote(s)`) without checking whether each individual result actually had `success: true`. This meant even a correctly-reported failure (`success: false`) still counted toward a falsely reassuring "Placed N" log line.

**Fix required in the unified build, from day one:**
- Any placement path where the exchange call resolves without throwing but returns no confirmation data must return `success: false` with a clear "UNRESOLVED, not confirmed on exchange" message — never assume success from the absence of an error.
- Every log line that reports "placed N orders" (or refreshed/requoted/recovered variants) must count only entries where `success === true`, and should report as `placed/attempted` (e.g. "3/10") so a partial failure is visible in the log itself, not hidden behind a raw array length.
- Add a specific automated test for the non-throwing-but-empty-response case — this exact scenario had zero test coverage in the old codebase (only the "exchange call throws" case was tested), which is exactly how it shipped unnoticed.

### 5c. Reduction-mode exit orders never getting a chance to fill
**Symptom:** once a market entered inventory-reduction mode (trying to exit an unwanted position), the exit order was being replaced every 2-3 seconds, at a slightly different price each time, indefinitely — the position never moved because the order was never given a realistic chance to be crossed by a real market order.

**Root cause:** the reduction-mode exit order was subject to the exact same aggressive refresh cadence (`minimumQuoteLifetimeMs` ~2s, triggered by any small price movement) that's correctly tuned for capturing spread on normal two-sided quoting — but is fatally wrong for a reduce-only order that needs to rest and wait. Additionally, the exit price was re-derived from the live mark price on every single cycle rather than anchored once at placement, meaning even a "held" order was constantly being repriced to chase a moving target.

**Fix required in the unified build:**
- Reduction/reduce-only exit orders need their own, separately configurable minimum resting time before they're eligible for cancellation — decoupled entirely from the normal two-sided quoting refresh cadence. (Values proven in production: 45 seconds minimum hold, 5 minutes maximum ceiling before one forced reprice if the market has genuinely moved away.)
- The exit price must be anchored once at placement, not re-derived on every cycle while the order is still resting and within its minimum hold window.
- A duplicate-placement guard: before placing a new reduce-only exit order, check whether one is already open for that market and skip if so — this closes a related gap where nothing previously prevented a second exit order from stacking on top of a still-resting one.
- Tag orders with a `reduceOnly` bookkeeping flag (internal tracking only, not necessarily sent to the exchange as an exchange-enforced reduce-only order — that's a separate, larger decision requiring its own dedicated testing, not bundled into this fix) so the engine can identify and specially handle these orders wherever needed (the duplicate-guard and the decoupled refresh logic both key off this flag).

**General lesson underlying all three bugs:** every one of these was caught only by insisting on close, skeptical reading of live logs against ground-truth exchange state (`verify-clean`-style direct queries), not by trusting a log line that claimed success. Build the unified system with the assumption that any "it worked" signal needs independent verification against the exchange before being trusted, especially right after a change.

---

## 6. Other Real Config/Operational Bugs Worth Preventing By Design

- **A hardcoded risk-manager limit (`0.002`) silently overrode the configurable env-var version** in one of the old repos for a long time, blocking all scaled-up orders with a confusing rejection message ("position is 0 and order size is X" — the real issue was the *limit*, not the order). **Design lesson:** never leave a hardcoded literal alongside a "configurable" system for the same value — if a limit is meant to be configurable, there should be exactly one source of truth for it, enforced by a test that fails if a hardcoded literal reappears.

- **A live-risk startup preflight check failed at exactly-at-capacity states** (e.g. exactly `N1_LIVE_MAX_OPEN_ORDERS` worth of the bot's own, already-reconciled orders resting) — treating normal steady-state as a startup failure and crash-looping. **Design lesson:** a "we are at capacity" state that reconciliation has already confirmed as healthy/expected must not be treated identically to "we are at capacity with something unexplained." The preflight check should trust a prior HEALTHY reconciliation result rather than independently re-deriving failure from a raw count.

- **Local order-registry files went stale or corrupted repeatedly**, requiring manual clearing after nearly every restart. Root causes found: (a) non-atomic file writes meant a crash mid-write could leave a corrupted/empty file, and the loader had no graceful fallback — it just crashed retrying forever; (b) the registry accumulated thousands of historical entries unbounded over time with no pruning, causing slow restores and bloat. **Design lesson for the unified build:** all local state persistence must (a) write atomically (temp file + rename, never write-in-place), (b) load with a try/catch that falls back to an empty/safe state with a loud warning on any corruption, rather than retrying indefinitely or crashing, and (c) prune/rotate old entries on some schedule so files don't grow unbounded.

- **`.env`-style shell heredocs silently corrupted config files** multiple times (missing trailing newlines caused two values to merge onto one line, e.g. `N1_RISK_MAX_SHORT_POSITION=0.005N1_MM_EXIT_SPREAD_BPS=2.5`), each requiring manual detection and repair. **Design lesson:** if config is being unified into a single structured file (YAML/JSON/TOML per Section 2) rather than a flat `.env`, this entire class of bug likely disappears, since structured formats fail loudly on malformed syntax rather than silently merging adjacent values. This is a good argument for moving away from `.env`-style flat config in the unified build, at least for per-market trading parameters (secrets like the private key can stay in a genuinely separate, still-flat `.env` that the app never writes to programmatically).

---

## 7. Trade Logging (Known Gap, Must Be Built Correctly This Time)

**Old-system gap:** live fills were never written to the trade history log/CSV at all — only paper-mode fills were. This meant there was no reliable data source to answer basic questions like "how many times did each market fill today" without reconstructing it awkwardly from raw order-registry files or the exchange's own UI.

**Required in the unified build:** every real fill, live or paper, must be logged to a durable, append-only trade history store with at minimum: timestamp, market, side, size, price, and whether it came from normal quoting or a reduce-only exit. This should be wired directly into wherever fills are actually detected (not bolted on separately per market), so it can't silently diverge between markets the way it did in the old two-repo system.

---

## 8. Dashboard Requirements

- **Single dashboard for all markets** (this was already partially solved with an aggregator service in the old system, polling each bot's separate `/api/status` — in the unified single-process build, this becomes trivial: one process, one status endpoint, all markets included natively, no polling/aggregation needed at all)
- **Total exposure must correctly sum `|position size| × mark price` across all markets** — a real bug in the old aggregator computed this from a per-session trade counter that reset on every restart, rather than from the live exchange-derived position, and silently showed $0.00 despite real open positions. Compute this from live position data, always, never from a resettable session counter.
- **Per-market cards/sections**, each showing: account value contribution, available margin, session PnL, live-risk status and proximity to limits, reconciliation status and streak
- **Control actions** (start/pause/shutdown) should work per-market AND all-markets-at-once, from one control surface — this was explicitly requested and partially built in the old aggregator; carry the same UX intent into the unified build
- **Real N1 volume data** (24h/7d/30d/all-time, per market) pulled directly from N1's own account-volume API, not reconstructed from local logs — this was built and proven to work in the old aggregator (`Nord.getAccountVolume()`), reuse that approach

---

## 9. Non-Negotiable Operational Discipline (Applies to Building This, Not Just the Bot Itself)

These aren't code requirements, they're process requirements for however this gets built:

1. **Never touch the real private key or `.env` from within an AI coding session.** All `.env`/secret handling happens manually, in a plain terminal, by the human operator only.
2. **Every code change gets a full paper-mode test suite run, then committed immediately** — not batched, not "I'll commit after the next thing too." Commit before moving to the next step, every time, without exception. (A real fix was silently lost once in the old system's development because this discipline was skipped once.)
3. **A soak test (sustained paper-mode run, minimum several minutes) is required before any change goes live**, especially anything touching order placement, reconciliation, or risk limits.
4. **Never restart a live (or soon-to-be-live) trading process while it holds an open position without first confirming genuinely flat state directly against the exchange** (not assumed from local files).
5. **When something looks wrong, verify against the exchange directly before trusting any log line, dashboard number, or "it succeeded" message.** This was the single most repeated, most valuable habit of the whole development process that led to this spec existing.

---

## 10. Suggested Build Order

1. Build the `ExchangeAdapter` interface (Section 1b) and the N1 implementation of it together — the interface should emerge from what the N1 adapter actually needs, not be designed in the abstract first
2. Core engine: single market, single process, talking only to the adapter interface, with all Section 5/6 fixes built in from the start (not retrofitted later)
3. Prove one market works end-to-end: paper test suite, soak test, then a real live deployment, watched closely
4. Extend to N markets on N1: add the market-config loop (Section 2), build and rigorously test the isolation guarantees (Section 4) with the explicit "break one market, confirm the other is unaffected" test
5. Unified dashboard (Section 8)
6. Trade logging (Section 7)
7. Validate the exchange abstraction is real: implement a second adapter (even a minimal/testnet one) and confirm a market can run on it with zero changes to engine/risk/reconciliation code — treat any required change outside the adapter itself as a sign the boundary in step 1 wasn't drawn correctly, and fix the abstraction, not just the symptom
8. Only once all of the above is proven stable: consider adding a third market/exchange, or revisiting deferred items like adaptive per-level spacing (Section 3) or exchange-enforced reduce-only orders (Section 5c)

Do not skip step 3 to save time — proving isolation (step 4) is much easier to get right and to test when you already trust the single-market core completely. Likewise, do not skip step 7 — an abstraction layer that has only ever had one implementation behind it is unverified, no matter how clean it looks.

---

## 11. RISEx Adapter — Second Real-Exchange Validation (Live-Readiness Gate)

Step 7 validated the `ExchangeAdapter` abstraction against a synthetic second implementation (`StubAdapter`) with no real-exchange characteristics behind it. RISEx (perpetuals DEX on RISE L2) is the real second exchange, and a much stronger test of the interface boundary than Stub's synthetic differences: a genuinely different chain family (EVM vs N1's Solana/Nord app-chain), a different auth model (EIP-712/JWT vs raw keypair), integer tick/step price representation instead of decimals, and native per-position isolated margin instead of N1's account-wide-only cross margin.

### No public testnet

RISEx's own docs still generically reference a "RISE Testnet" environment, but the underlying L2 testnet (chain id 11155931) is private-beta / access-gated (builder form or Discord request) — not an open sandbox. There is currently no way to exercise the authenticated order-placement surface against a funds-free live environment. This changes the proof bar for this adapter relative to N1 (step 3's real paper soak) and Stub (step 7's real soak): both of those got a live soak test before being considered proven; RiseXAdapter's authenticated surface currently cannot get the same treatment.

### Build plan

1. `RiseXMarketDataSource` — public, unauthenticated REST/WS only (markets, orderbook, public trades, OHLCV, funding history). Built and soak-tested against real RISEx mainnet data — no funds or credentials involved, matching `RealN1MarketDataSource`'s structural guarantee of holding no private key.
2. `RiseXPaperAdapter` — real market data feed plus fully local simulated positions/orders/fills/margin, same shape as `N1PaperAdapter`. This is the real proof of the abstraction against RISEx's actual market structure (tick/step sizing, real price action, real funding), run as a soak test the same way N1 and Stub were.
3. `RiseXAdapter` (authenticated surface: placeOrder/cancelOrder/getOrderFills/positions/margin/getAccountVolume) — built against RISEx's documented REST schema, verified only via fixture/contract-level tests against documented request/response shapes. This is explicitly a lower proof bar than steps 1-2 and must never be reported or treated as equivalent to a live soak.

### Design decisions locked for v1

- **Margin**: RiseXAdapter operates cross-margin only. RISEx natively supports per-position isolated margin, which `NormalizedMarginStatus` (deliberately account-wide, Section 4.3) doesn't represent. Rather than extend the shared interface for this, v1 scopes to cross-margin and documents isolated-margin support as deferred future work — not a silent gap.
- **Order types**: v1 supports market/limit + reduce-only only, mapped onto RISEx's orthogonal `order_type`/`time_in_force`/`post_only` fields entirely inside the adapter's own mapper layer — no `ExchangeAdapter` interface change required. RISEx's native TP/SL conditional-order subsystem is out of scope for v1.
- **`getAccountVolume()`**: implemented by aggregating RISEx's Account Trade History endpoint (nanosecond timestamps, offset/page pagination) over the requested `since`/`until` window — the same approach `N1PaperAdapter.getAccountVolume()` already uses by precedent — rather than RISEx's dedicated Volume Stats endpoint, which only supports fixed relative windows (1h-2w max) and cannot serve an arbitrary-range query.
- **Auth**: JWT bearer (one-time EIP-712 `Login` signature at `connect()`, refreshed periodically) is the default, not per-call EIP-712 permit signing. This fits the adapter's existing `connect()`/`disconnect()` lifecycle (matching how `N1Adapter` establishes its session once rather than signing per call), keeps private-key signing off the order-placement hot path, and keeps a single, auditable point where real credentials get exercised. RISEx also offers delegated Session Keys and OperatorHub spend-limited allowances, purpose-built for bots — worth revisiting as a future enhancement once this adapter is live, but out of scope for the initial implementation.

### Live-readiness gate (do not skip)

Fixture/contract tests passing against documented schemas prove RiseXAdapter sends and parses what the docs describe — they prove nothing about RISEx's actual matching behavior, fill timing, or error/edge cases under real conditions, which is exactly what N1's step-3 soak and Stub's step-7 soak were for. RiseXAdapter passing its test suite does **not** clear it for live use. Before any live trading on RISEx:

(a) **Preferred** — obtain access to RISEx's gated testnet (builder form / Discord) and run a real soak there first, same discipline as N1's dev-vs-mainnet split.
(b) **Fallback, only if (a) is not obtainable in reasonable time** — a human-operator-supervised, minimal-size, closely-watched first live session, restarted and re-verified after every fix rather than left running unattended, mirroring how the predecessor bots were run after incidents. This session is run by the human operator directly, on their own machine and schedule; per Section 9, an AI coding session never places live orders, regardless of test coverage.
