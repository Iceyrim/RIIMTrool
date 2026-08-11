# RIIMTrool — Standing Context for Claude Code

Read this first, every session. Full architecture spec is in `SPEC.md` — read it fully before any structural work; don't re-derive decisions already made there.

## What this is

A unified, multi-market, multi-exchange trading bot, built fresh to replace two separate single-market bots that had real, expensive production incidents. Every design decision in SPEC.md exists because of a specific incident on the predecessor system — don't simplify away the "why" sections.

## Standing constraints (non-negotiable, every session)

- Never touch `.env`. No real credentials exist in this project yet (paper-mode only, `N1_PRIVATE_KEY` deliberately not configured). When it eventually is, that's set manually by the human operator, never by Claude Code.
- Never attempt live order placement or any authenticated exchange action. This project is greenfield / paper-mode only until explicitly told otherwise.
- Show plans before implementing structural changes — get explicit approval on design before writing code, especially for anything touching the adapter interface, engine core, or isolation guarantees.
- Full test suite (`npm test`, `npx tsc --noEmit`, lint) must pass before anything is considered done. Report results, don't just claim success.
- Commit only when told to — the human runs `git add/commit/push` themselves in terminal, every time, immediately after verification. Never leave verified work uncommitted across multiple steps.

## Current status (update this section as steps complete)

Per SPEC.md Section 10 build order:
- [x] Step 1 — ExchangeAdapter interface + N1 implementation
- [x] Step 2 — Single-market core engine (Section 5a/5b/5c fixes built in from the start)
- [x] Step 3 — Proven end-to-end: real paper soak test, 89 cycles, zero anomalies (found and fixed a real reconciliation deadlock bug along the way — see git log)
- [x] Step 4 — Multi-market with tested isolation guarantees (independent per-market timers, fake-timer tests proving a hung/degraded market can't block another)
- [x] Step 5 — Unified dashboard (live exposure calc from position data, not a session counter — this was a real bug in the old system, deliberately avoided here)
- [x] Step 6 — Trade logging (durable JSONL, deduped by tradeId, wired into shared engine code so it works identically across adapters)
- [x] Step 7 — Validated the exchange abstraction: `StubAdapter` (`src/adapters/stub/`), a second, independent, deliberately-differently-shaped adapter (dual long/short position legs instead of a signed scalar, seeded synthetic price-walk fill timing instead of real-tape replay, synchronous placeOrder() fills, divergent error shapes in getOrderFills()/cancelOrder(), no MarketRegistry-style id indirection). Ran a real soak (`scripts/run-stub-paper.ts`, 71 cycles, zero anomalies) through the unmodified MarketEngine/RiskManager/Reconciliation/OrderLifecycle/TradeLog/PaperRunner/DashboardService stack. `git diff` scoped to `src/engine/`, `src/dashboard/`, `src/paperRunner/` is empty — the literal SPEC.md acceptance bar. Only expected touchpoint outside the adapter's own directory: `"stub"` added to `src/config/schema.ts`'s exchange enum.
- [ ] Step 8 (in progress) — RISEx adapter, a real second exchange (perps DEX on RISE L2, EVM), not just a synthetic one. Full plan, design decisions, and live-readiness gate are in SPEC.md Section 11 — read it before touching this. Key facts: RISEx has no public testnet (the chain-level testnet is private-beta/access-gated), so the authenticated order-placement surface can only be fixture/contract-tested against documented schemas, not live-soaked like N1/Stub were — that is explicitly a lower proof bar and must not be reported as equivalent.
  - [x] Phase 1 — `RiseXMarketDataSource` (`src/adapters/risex/`): public, unauthenticated REST only (markets, orderbook, public trades, OHLCV candles, funding rate history). Holds only a base URL string, structurally cannot hold a private key, mirroring `RealN1MarketDataSource`. Verified live against real RISEx mainnet (`https://api.rise.trade` — not documented explicitly anywhere as "the mainnet REST base URL", inferred from the ws.rise.trade/ws.testnet.rise.trade naming pattern and confirmed by curl; BTC/USDC = market_id 1, ETH/USDC = market_id 2, matching this bot's configured BTCUSD/ETHUSD). Real response shapes diverge from the hosted docs in several ways (envelope is `{data, request_id}` not bare; trade `id` is a composite hex string, not a sortable integer, so `getRecentTrades` cursors on time not id; `trading-view-data` double-nests `data.data`) — built and tested against captured real responses, not the docs. `scripts/probe-risex-market-data.ts` is a one-shot live connectivity proof (not a soak test). WS explicitly deferred (REST-only, matching N1MarketDataSource's own precedent; would need a new `ws` dependency since Node 20 has no stable global WebSocket) — a future enhancement, not required for Phase 2.
  - [ ] Phase 2 — `RiseXPaperAdapter`: real market data (Phase 1) + fully local simulated positions/orders/fills/margin, same shape as `N1PaperAdapter`. Not yet started.
  - [ ] Phase 3 — `RiseXAdapter` authenticated surface (placeOrder/cancelOrder/getOrderFills/positions/margin/getAccountVolume), fixture/contract-tested only per the live-readiness gate. Not yet started.

## Key architectural facts worth remembering

- One process, N markets — not one process per market (that was the old, painful model).
- Market isolation within the shared process is the single most important guarantee (SPEC.md Section 4). Every new feature touching scheduling, state, or risk needs to be checked against: "can a problem in one market ever affect another?"
- Exchange-specific code lives only inside adapter implementations (`src/adapters/n1/`). Engine, risk, reconciliation code talks only to the normalized `ExchangeAdapter` interface types.
- Config is per-market YAML (`config/markets.yaml`), not `.env` — this was a deliberate move away from flat `.env` config for trading parameters specifically, since `.env` heredoc/append mistakes caused real config corruption on the old system multiple times.
- Currently two markets configured: BTCUSD, ETHUSD, using the proven live parameters from the old bots (spread, sizing, session loss caps — ETH's cap is deliberately tighter than BTC's, per an old incident).

## When eventually going live

Wallet to use: `2ZUbwKwirxbkSsWH8nFkCAEHtgR8QUpXYYB5p6yqyeDV` (same as the old BTC/ETH bots). This gets set manually in `.env` by the human, never by Claude Code, and only after step 7 and a real live-readiness review — not automatically once paper mode looks good.
