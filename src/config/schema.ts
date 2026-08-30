import { z } from "zod";

/**
 * Market configuration shape (SPEC.md Section 2), extended with `exchangeSymbol`: the config's
 * `symbol` is a logical/display symbol (e.g. "BTCUSD"); `exchangeSymbol` is the literal symbol
 * string the exchange itself uses (e.g. N1's markets are quoted in USDC, not USD, so the real
 * N1 symbol is something like "BTCUSDC"). Keeping this mapping explicit in config avoids the
 * adapter having to guess or fuzzy-match symbols at connect time.
 */
export const riskLimitsSchema = z.object({
  maxLongPosition: z.number().positive(),
  maxShortPosition: z.number().positive(),
  maxOrderSize: z.number().positive(),
  maxOrderNotionalUsd: z.number().positive(),
  maxOpenOrders: z.number().int().positive(),
});

export const spreadBpsSchema = z.object({
  normal: z.number().positive(),
  min: z.number().positive(),
  max: z.number().positive(),
});

export const orderSizeSchema = z.object({
  min: z.number().positive(),
  max: z.number().positive(),
});

/**
 * SPEC.md Section 5c only states these as prose ("45 seconds minimum hold, 5 minutes maximum
 * ceiling") rather than as part of Section 2's config example — but per Section 6's "never leave
 * a hardcoded literal alongside a configurable system" lesson, they belong here as real,
 * overridable config, not a bare literal buried in engine code. Defaults are the proven values.
 */
export const reduceOnlyExitSchema = z.object({
  minHoldMs: z.number().int().positive().default(45_000),
  maxHoldMs: z.number().int().positive().default(300_000),
});

export const marketConfigSchema = z
  .object({
    symbol: z.string().min(1),
    // "stub" is not a real exchange — it exists only to validate the ExchangeAdapter boundary
    // itself (SPEC.md Section 10 step 7, src/adapters/stub/StubAdapter.ts). "risex" is RISEx
    // (SPEC.md Section 11, src/adapters/risex/), the real second exchange. Adding either here is
    // the one expected, SPEC-sanctioned touchpoint outside the adapter's own directory; nothing in
    // src/engine/, src/dashboard/, or src/paperRunner/ needs to know these literals exist.
    exchange: z.enum(["n1", "stub", "risex", "perpl"]),
    exchangeSymbol: z.string().min(1),
    enabled: z.boolean(),
    /** Explicit order leverage. Defaults to 1 for existing N1/RiseX configurations. */
    leverage: z.number().int().positive().max(100).optional(),
    orderSize: orderSizeSchema,
    spreadBps: spreadBpsSchema,
    exitSpreadBps: z.number().positive(),
    quoteLevels: z.number().int().positive(),
    levelSpacingBps: z.array(z.number().positive()).min(1),
    inventoryReductionThresholdBase: z.number().positive(),
    riskLimits: riskLimitsSchema,
    reduceOnlyExit: reduceOnlyExitSchema.default({}),
    /** Normal (non-reduce-only) quote refresh policy. Kept separate from reduce-only exit
     * timing so the two order classes cannot accidentally share lifecycle semantics. */
    quoteMinimumLifetimeMs: z.number().int().nonnegative().default(30_000),
    quoteRepriceThresholdBps: z.number().positive().default(1),
    quoteMaximumLifetimeMs: z.number().int().nonnegative().default(120_000),
  })
  .strict(
    "Unknown market configuration key (sessionLossCapUsd is now accountRisk.sessionLossCapUsd)",
  )
  .refine((m) => m.levelSpacingBps.length === m.quoteLevels, {
    message: "levelSpacingBps length must match quoteLevels",
    path: ["levelSpacingBps"],
  })
  .refine((m) => m.orderSize.min <= m.orderSize.max, {
    message: "orderSize.min must be <= orderSize.max",
    path: ["orderSize"],
  })
  .refine((m) => m.spreadBps.min <= m.spreadBps.normal && m.spreadBps.normal <= m.spreadBps.max, {
    message: "spreadBps must satisfy min <= normal <= max",
    path: ["spreadBps"],
  })
  .refine((m) => m.reduceOnlyExit.minHoldMs < m.reduceOnlyExit.maxHoldMs, {
    message: "reduceOnlyExit.minHoldMs must be < reduceOnlyExit.maxHoldMs",
    path: ["reduceOnlyExit"],
  })
  .refine((m) => m.quoteMaximumLifetimeMs >= m.quoteMinimumLifetimeMs, {
    message: "quoteMaximumLifetimeMs must be >= quoteMinimumLifetimeMs",
    path: ["quoteMaximumLifetimeMs"],
  })
  .refine((m) => m.quoteLevels * 2 + 1 <= m.riskLimits.maxOpenOrders, {
    message: "two-sided quoteLevels plus one permitted exit slot must not exceed maxOpenOrders",
    path: ["riskLimits", "maxOpenOrders"],
  });

export const accountRiskSchema = z.object({
  sessionLossCapUsd: z.number().positive(),
});

export const marketsConfigSchema = z
  .object({
    accountRisk: accountRiskSchema,
    markets: z.array(marketConfigSchema).min(1),
  })
  .transform(({ accountRisk, markets }) => ({
    accountRisk,
    markets: markets.map((market) => ({
      ...market,
      accountSessionLossCapUsd: accountRisk.sessionLossCapUsd,
    })),
  }));

export type RiskLimits = z.infer<typeof riskLimitsSchema>;
export type MarketConfig = z.infer<typeof marketConfigSchema>;
export type MarketsConfig = z.infer<typeof marketsConfigSchema>;
