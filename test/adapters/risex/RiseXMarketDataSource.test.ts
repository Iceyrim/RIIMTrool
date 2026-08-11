import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExchangeAdapterError } from "../../../src/adapters/AdapterError.js";
import { RealRiseXMarketDataSource } from "../../../src/adapters/risex/RiseXMarketDataSource.js";

const BASE_URL = "https://api.rise.trade";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("RealRiseXMarketDataSource", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("getMarkets", () => {
    it("unwraps the envelope and converts decimal strings to numbers", async () => {
      // Real shape captured from a live GET https://api.rise.trade/v1/markets call.
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            markets: [
              {
                market_id: "1",
                config: {
                  name: "BTC/USDC",
                  quote: "0xe436820ba0c69702c1d3e601d421c0ef38262739",
                  step_size: "0.000001",
                  step_price: "0.1",
                  maintenance_margin_factor: "37.5",
                  max_leverage: "25",
                  min_order_size: "0.00015",
                  unlocked: true,
                  open_interest_limit: "750",
                },
                base_asset_symbol: "BTC/USDC",
                quote_asset_symbol: "USDC",
                underlying: "BTC/USDC",
                display_name: "BTC/USDC",
                quote_volume_24h: "35805509.1445199",
                change_24h: "-902.7",
                high_24h: "65332.6",
                low_24h: "63762.2",
                last_price: "63902",
                mark_price: "63895.588033516661507377",
                index_price: "63896.692821114782",
                max_position_size: "100000000",
                open_interest: "213.28202",
                funding_interval: "3600000000000",
                next_funding_time: "1786410000000000000",
                post_only: false,
                accumulated_funding: "-1314.427677389622276658",
                current_funding_rate: "0.000014893705110027",
                funding_rate_8h: "0.000119149640880216",
                active: true,
              },
            ],
          },
          request_id: "abc",
        }),
      );

      const source = new RealRiseXMarketDataSource(BASE_URL);
      const markets = await source.getMarkets();

      expect(markets).toEqual([
        {
          marketId: 1,
          symbol: "BTC/USDC",
          displayName: "BTC/USDC",
          markPrice: 63895.58803351666,
          indexPrice: 63896.692821114782,
          lastPrice: 63902,
          stepSize: 0.000001,
          stepPrice: 0.1,
          minOrderSize: 0.00015,
          maxLeverage: 25,
          active: true,
        },
      ]);
      const calledUrl = fetchMock.mock.calls[0]![0] as URL;
      expect(calledUrl.toString()).toBe(`${BASE_URL}/v1/markets`);
    });
  });

  describe("getOrderbook", () => {
    it("passes market_id and limit as query params and maps levels", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            market_id: "1",
            bids: [{ price: "63886.9", quantity: "0.035071", order_count: 2 }],
            asks: [{ price: "63887", quantity: "0.07948", order_count: 5 }],
            total_bids: "334",
            total_asks: "531",
          },
        }),
      );

      const source = new RealRiseXMarketDataSource(BASE_URL);
      const book = await source.getOrderbook(1, 3);

      expect(book).toEqual({
        marketId: 1,
        bids: [{ price: 63886.9, quantity: 0.035071, orderCount: 2 }],
        asks: [{ price: 63887, quantity: 0.07948, orderCount: 5 }],
      });
      const calledUrl = fetchMock.mock.calls[0]![0] as URL;
      expect(calledUrl.pathname).toBe("/v1/orderbook");
      expect(calledUrl.searchParams.get("market_id")).toBe("1");
      expect(calledUrl.searchParams.get("limit")).toBe("3");
    });
  });

  describe("getRecentTrades", () => {
    it("derives takerSide as the OPPOSITE of maker_side, and converts ns timestamps to ms", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            market_id: "1",
            trades: [
              {
                id: "0x0000000000003fb5-0x0000000000003d86",
                maker_side: "BUY",
                price: "63886.9",
                size: "0.000527",
                time: "1786406519000000000",
                block_number: "18800760",
                log_index: "883",
              },
            ],
          },
        }),
      );

      const source = new RealRiseXMarketDataSource(BASE_URL);
      const trades = await source.getRecentTrades(1);

      expect(trades).toEqual([
        {
          id: "0x0000000000003fb5-0x0000000000003d86",
          takerSide: "sell", // maker was BUY (resting bid) -> taker crossed in as a seller
          price: 63886.9,
          size: 0.000527,
          timestamp: 1786406519000,
        },
      ]);
    });

    it("converts sinceMs to a nanosecond start_time query param", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: { market_id: "1", trades: [] } }));

      const source = new RealRiseXMarketDataSource(BASE_URL);
      await source.getRecentTrades(1, 1_700_000_000_000, { page: 2, limit: 50 });

      const calledUrl = fetchMock.mock.calls[0]![0] as URL;
      expect(calledUrl.pathname).toBe("/v1/markets/id/1/trade-history");
      expect(calledUrl.searchParams.get("start_time")).toBe("1700000000000000000");
      expect(calledUrl.searchParams.get("page")).toBe("2");
      expect(calledUrl.searchParams.get("limit")).toBe("50");
    });

    it("omits start_time entirely when sinceMs is undefined, to prime the cursor from the latest page", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: { market_id: "1", trades: [] } }));

      const source = new RealRiseXMarketDataSource(BASE_URL);
      await source.getRecentTrades(1);

      const calledUrl = fetchMock.mock.calls[0]![0] as URL;
      expect(calledUrl.searchParams.has("start_time")).toBe(false);
    });
  });

  describe("getCandles", () => {
    it("unwraps the double-nested data.data shape and converts interval/from/to to nanoseconds", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            data: [
              {
                market_id: "1",
                interval: "1m",
                time: "1786402980000000000",
                low: "63942.7",
                high: "63949.5",
                open: "63948.6",
                close: "63949",
                volume: "0.380939",
              },
            ],
          },
        }),
      );

      const source = new RealRiseXMarketDataSource(BASE_URL);
      const candles = await source.getCandles(1, { intervalMs: 60_000, fromMs: 1_700_000_000_000 });

      expect(candles).toEqual([
        {
          intervalLabel: "1m",
          timestamp: 1786402980000,
          low: 63942.7,
          high: 63949.5,
          open: 63948.6,
          close: 63949,
          volume: 0.380939,
        },
      ]);
      const calledUrl = fetchMock.mock.calls[0]![0] as URL;
      expect(calledUrl.searchParams.get("interval")).toBe("60000000000");
      expect(calledUrl.searchParams.get("from")).toBe("1700000000000000000");
      expect(calledUrl.searchParams.has("to")).toBe(false);
    });
  });

  describe("getFundingRateHistory", () => {
    it("maps records and converts start/end times to ms", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            market_id: "1",
            records: [
              {
                funding_rate: "0.000014893705110027",
                accumulated_funding: "-1314.427677389622276658",
                index_price: "63922.789299071235",
                start_time: "1786402800000000000",
                end_time: "1786406400000000000",
                block_number: "18800641",
                block_time: "1786406400000000000",
                tx_hash: "0xabc",
              },
            ],
            page: 1,
            has_next_page: true,
          },
        }),
      );

      const source = new RealRiseXMarketDataSource(BASE_URL);
      const records = await source.getFundingRateHistory(1);

      expect(records).toEqual([
        {
          fundingRate: 0.000014893705110027,
          accumulatedFunding: -1314.4276773896222,
          indexPrice: 63922.789299071235,
          startTime: 1786402800000,
          endTime: 1786406400000,
        },
      ]);
    });
  });

  describe("error handling", () => {
    it("throws ExchangeAdapterError with retryable=true on a 5xx response", async () => {
      fetchMock.mockResolvedValueOnce(new Response("server exploded", { status: 503 }));

      const source = new RealRiseXMarketDataSource(BASE_URL);
      await expect(source.getMarkets()).rejects.toMatchObject({
        name: "ExchangeAdapterError",
        retryable: true,
      });
    });

    it("throws ExchangeAdapterError with retryable=false on a 4xx response", async () => {
      fetchMock.mockResolvedValueOnce(new Response("bad market id", { status: 400 }));

      const source = new RealRiseXMarketDataSource(BASE_URL);
      await expect(source.getOrderbook(999)).rejects.toMatchObject({
        name: "ExchangeAdapterError",
        retryable: false,
      });
    });

    it("throws ExchangeAdapterError with retryable=true when the network call itself throws", async () => {
      fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

      const source = new RealRiseXMarketDataSource(BASE_URL);
      await expect(source.getMarkets()).rejects.toMatchObject({
        name: "ExchangeAdapterError",
        retryable: true,
      });
    });

    it("throws ExchangeAdapterError on a non-numeric decimal field instead of returning NaN silently", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: {
            market_id: "1",
            bids: [{ price: "not-a-number", quantity: "1", order_count: 1 }],
            asks: [],
            total_bids: "1",
            total_asks: "0",
          },
        }),
      );

      const source = new RealRiseXMarketDataSource(BASE_URL);
      await expect(source.getOrderbook(1)).rejects.toThrow(ExchangeAdapterError);
    });
  });
});
