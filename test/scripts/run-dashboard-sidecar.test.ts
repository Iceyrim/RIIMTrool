import { describe, expect, it } from "vitest";
import { sidecarOptions } from "../../scripts/run-dashboard-sidecar.js";

describe("dashboard sidecar launcher", () => {
  it("is fixed to its approved loopback port", () => {
    expect(sidecarOptions()).toEqual({ host: "127.0.0.1", port: 4400 });
  });
});
