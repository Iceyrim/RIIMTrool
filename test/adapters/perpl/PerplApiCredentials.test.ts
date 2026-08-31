import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPerplApiCredentials } from "../../../src/adapters/perpl/PerplApiCredentials.js";

function credentialFile(mode = 0o600): string {
  const path = join(mkdtempSync(join(tmpdir(), "perpl-api-creds-")), "api.env");
  writeFileSync(path, `PERPL_API_KEY='opaque-token'\nPERPL_API_KEY_SECRET='${"ab".repeat(32)}'\n`, { mode });
  chmodSync(path, mode);
  return path;
}

describe("loadPerplApiCredentials", () => {
  it("loads the two expected values from a private regular file", () => {
    expect(loadPerplApiCredentials(credentialFile())).toMatchObject({
      apiKey: "opaque-token",
      apiKeySecret: "ab".repeat(32),
    });
  });
  it("rejects group-readable files", () => {
    expect(() => loadPerplApiCredentials(credentialFile(0o640))).toThrow(/group or others/);
  });
  it("rejects symlinks and unexpected entries", () => {
    const target = credentialFile(); const link = `${target}.link`; symlinkSync(target, link);
    expect(() => loadPerplApiCredentials(link)).toThrow(/regular file/);
    const path = credentialFile(); writeFileSync(path, "PERPL_API_KEY=x\nEVIL=value\n", { mode: 0o600 });
    expect(() => loadPerplApiCredentials(path)).toThrow(/Unexpected/);
  });
});
