/** One explicitly armed RISEx session-signer placement/cancellation canary. */
import { pathToFileURL } from "node:url";
import type { ExchangeAdapter, PlaceOrderResult } from "../src/adapters/ExchangeAdapter.js";
import { RealRiseXMarketDataSource, type RiseXMarket, type RiseXOrderbook } from "../src/adapters/risex/RiseXMarketDataSource.js";
import { RiseXPermitExecutionTransport } from "../src/adapters/risex/RiseXPermitExecutionTransport.js";
import { EthersRiseXPermitSigner } from "../src/adapters/risex/RiseXPermitSigner.js";
import { RiseXSessionAdapter } from "../src/adapters/risex/RiseXSessionAdapter.js";

const BASE_URL = process.env.RISEX_API_BASE_URL ?? "https://api.rise.trade";
export const RISEX_CANARY_SIZE = 0.00018;
export const RISEX_CANARY_MAX_NOTIONAL_USD = 15;

export function planRiseXCanary(market: RiseXMarket, book: RiseXOrderbook) {
  const bestBid = Math.max(...book.bids.map((level) => level.price));
  const bestAsk = Math.min(...book.asks.map((level) => level.price));
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= bestBid)
    throw new Error("RISEx BTC order book is invalid");
  const sizeSteps = Math.round(RISEX_CANARY_SIZE / market.stepSize);
  const size = sizeSteps * market.stepSize;
  if (sizeSteps < 1 || Math.abs(size - RISEX_CANARY_SIZE) > 1e-12 || size < market.minOrderSize)
    throw new Error("RISEx BTC canary size is not valid on the current market step grid");
  const priceTicks = Math.floor((bestBid - market.stepPrice) / market.stepPrice + 1e-9);
  const price = priceTicks * market.stepPrice;
  const notionalUsd = price * size;
  if (!Number.isSafeInteger(priceTicks) || priceTicks < 1 || price >= bestBid)
    throw new Error("RISEx BTC canary price is not deliberately passive");
  if (notionalUsd > RISEX_CANARY_MAX_NOTIONAL_USD)
    throw new Error(`RISEx BTC canary exceeds the $${RISEX_CANARY_MAX_NOTIONAL_USD} notional cap`);
  return { bestBid, bestAsk, price, size, notionalUsd };
}

export async function executeRiseXCanary(adapter: ExchangeAdapter, plan: ReturnType<typeof planRiseXCanary>) {
  await adapter.refreshAccountState();
  const beforeOrders = adapter.getOpenOrders();
  const beforePositions = adapter.getPositions();
  if (beforeOrders.length || beforePositions.some((position) => position.baseSize !== 0))
    throw new Error("RISEx canary requires an initially flat, order-free account");
  const actionBase = BigInt(Date.now()) * 10n;
  let placement: PlaceOrderResult;
  try {
    placement = await adapter.placeOrder({ market: "BTCUSD", side: "buy", type: "postOnly", price: plan.price, size: plan.size, isReduceOnly: false, clientOrderId: actionBase.toString() });
  } catch (error) {
    throw new Error(`RISEx placement outcome is ambiguous: ${String(error)}`);
  }
  if (!placement.success) {
    if (placement.reason === "UNRESOLVED_NOT_CONFIRMED")
      throw new Error(`RISEx placement outcome is ambiguous: ${placement.message}`);
    throw new Error(`RISEx placement was rejected: ${placement.message}`);
  }
  if (placement.order.state !== "open" || placement.order.filledSize !== 0)
    throw new Error("RISEx post-only canary did not confirm as an unfilled resting order");
  await adapter.refreshAccountState();
  const exact = adapter.getOpenOrders("BTCUSD").find((order) => order.exchangeOrderId === placement.order.exchangeOrderId);
  if (!exact) throw new Error("RISEx placed order is absent from authoritative open-order evidence");
  try {
    const cancelled = await adapter.cancelOrder(exact.exchangeOrderId, "BTCUSD");
    if (!cancelled.success) throw new Error("cancellation was not confirmed");
  } catch (error) {
    throw new Error(`RISEx cancellation outcome is ambiguous for ${exact.exchangeOrderId}: ${String(error)}`);
  }
  await adapter.refreshAccountState();
  const finalOrders = adapter.getOpenOrders();
  const finalPositions = adapter.getPositions();
  const completedFlat = finalOrders.length === 0 && finalPositions.every((position) => position.baseSize === 0);
  return { placement: { state: "confirmed", exchangeOrderId: exact.exchangeOrderId }, cancellation: { state: "confirmed", exchangeOrderId: exact.exchangeOrderId }, finalEvidence: { openOrders: finalOrders, positions: finalPositions }, finalStatus: completedFlat ? "completed-flat" : "manual-review-required" };
}

async function main(): Promise<void> {
  if (!process.argv.includes("--arm=EXECUTE ONE RISEX CANARY"))
    throw new Error("missing exact --arm=EXECUTE ONE RISEX CANARY");
  const account = process.env.RISEX_ACCOUNT_ADDRESS;
  const privateKey = process.env.RISEX_SESSION_SIGNER_PRIVATE_KEY;
  const expectedSigner = process.env.RISEX_SESSION_SIGNER_ADDRESS;
  if (!account || !/^0x[0-9a-fA-F]{40}$/.test(account)) throw new Error("RISEX_ACCOUNT_ADDRESS is missing or invalid");
  if (!privateKey || !expectedSigner) throw new Error("RISEx session signer credentials are missing");
  const signer = new EthersRiseXPermitSigner(privateKey);
  if (signer.address.toLowerCase() !== expectedSigner.toLowerCase()) throw new Error("RISEx session signer key does not match its configured address");
  const marketData = new RealRiseXMarketDataSource(BASE_URL);
  const markets = await marketData.getMarkets();
  const btc = markets.find((market) => market.symbol === "BTC/USDC");
  if (!btc || !btc.active) throw new Error("RISEx BTC/USDC market is unavailable");
  const plan = planRiseXCanary(btc, await marketData.getOrderbook(btc.marketId, 20));
  const configured = [{ symbol: "BTCUSD", exchangeSymbol: "BTC/USDC" }];
  const execution = new RiseXPermitExecutionTransport(marketData, signer, { baseUrl: BASE_URL, account, markets: configured });
  const adapter = new RiseXSessionAdapter(marketData, execution, { baseUrl: BASE_URL, account, markets: configured });
  await adapter.connect();
  try {
    const report = await executeRiseXCanary(adapter, plan);
    console.log(JSON.stringify({ mode: "risex-session-signer-one-shot-canary", ...plan, ...report }, null, 2));
    if (report.finalStatus !== "completed-flat") process.exitCode = 1;
  } finally { await adapter.disconnect(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  void main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
