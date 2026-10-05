import { describe, expect, it } from "vitest";
import {
  prepareReviewedHandoff,
  type ReviewedHandoffInput,
} from "../../scripts/prepare-perpl-reviewed-one-shot-handoff.js";

const valid: ReviewedHandoffInput = {
  signer: "0xa89bC210BaB1156113571F2a9193c5282efBF78a",
  socketPath: "/tmp/perpl-reviewed.sock",
  sessionId: "2026082801",
  market: "BTCUSD",
  side: "buy",
  price: 77000,
  size: 0.00018,
  bestBid: 77100,
  bestAsk: 77110,
  placementActionId: "2026082701",
  cancellationActionId: "2026082702",
  chainNonce: 13,
};

describe("reviewed one-shot handoff", () => {
  it("separates the wallet worker template from the signer-free runner", () => {
    const result = prepareReviewedHandoff(valid);
    expect(result).toMatchObject({
      mode: "operator-review-only",
      executable: false,
      review: { notionalUsd: 13.86 },
    });
    expect(result.terminal1WorkerTemplate).toContain("SIGNER_KEY_FILE");
    expect(result.terminal1WorkerTemplate).toContain("gated-execution-worker");
    expect(result.terminal1WorkerTemplate).toContain(
      "state/perpl-reviewed-one-shot/2026082801/rust-worker.json",
    );
    expect(result.terminal2Runner).toContain("run-perpl-reviewed-one-shot.ts");
    expect(result.terminal2Runner).toContain(
      "state/perpl-reviewed-one-shot/2026082801/equity.json",
    );
    expect(result.terminal2Runner).not.toMatch(/signer|key|wallet/i);
    expect(result.supervisedCommand).toContain("run-perpl-supervised-one-shot.ts");
    expect(result.supervisedCommand).toContain("--session-id=2026082801");
    expect(result.supervisedCommand).toContain("--socket-timeout-ms=180000");
    expect(result.supervisedCommand).toContain("SIGNER_KEY_FILE");
  });

  it.each([
    { price: 77100 },
    { size: 1 },
    { chainNonce: -1 },
    { sessionId: "../old-session" },
    { cancellationActionId: "2026082701" },
  ])("rejects unsafe review input: %o", (override) =>
    expect(() => prepareReviewedHandoff({ ...valid, ...override })).toThrow(),
  );
});
