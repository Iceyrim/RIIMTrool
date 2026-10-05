import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RiseXEquityPnlSource } from "../../scripts/run-risex-live.js";
import type { RiseXSessionAdapter } from "../../src/adapters/risex/RiseXSessionAdapter.js";
import { RiseXSessionEquityGuard } from "../../src/engine/RiseXSessionEquityGuard.js";

const journalPath = () => join("/tmp", `risex-pnl-source-${process.pid}-${Math.random()}.json`);

function adapterAt(accountValue: number): {
  adapter: RiseXSessionAdapter;
  setAccountValue: (value: number) => void;
} {
  let current = accountValue;
  return {
    adapter: {
      getMarginStatus: () => ({ accountValue: current }),
    } as unknown as RiseXSessionAdapter,
    setAccountValue: (value) => {
      current = value;
    },
  };
}

describe("RiseXEquityPnlSource", () => {
  it("returns signed equity changes so recoveries offset declines", async () => {
    const { adapter, setAccountValue } = adapterAt(100);
    const guard = new RiseXSessionEquityGuard(journalPath(), 2, 2, 5);
    const source = new RiseXEquityPnlSource(adapter, guard);
    source.arm();

    setAccountValue(99);
    expect(await source.drainRealizedPnlDeltaUsd()).toBe(-1);

    setAccountValue(100);
    expect(await source.drainRealizedPnlDeltaUsd()).toBe(1);
    expect(guard.status()).toMatchObject({ sessionChange: 0 });
  });

  it("still halts when net session equity reaches the configured loss cap", async () => {
    const { adapter, setAccountValue } = adapterAt(100);
    const guard = new RiseXSessionEquityGuard(journalPath(), 2, 10, 20);
    const onHalt = vi.fn();
    const source = new RiseXEquityPnlSource(adapter, guard, onHalt);
    source.arm();

    setAccountValue(98);
    await expect(source.drainRealizedPnlDeltaUsd()).rejects.toThrow(
      "RISEx session equity loss limit reached",
    );
    expect(onHalt).toHaveBeenCalledWith("RISEx session equity loss limit reached");
    expect(guard.status()).toMatchObject({ state: "halted" });
  });
});
