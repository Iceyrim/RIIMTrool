import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const builder = join(root, "deploy/build-dashboard-sidecar-artifact.sh");

describe("dashboard sidecar deployment", () => {
  it("builds only the allowlisted artifact files", () => {
    const output = mkdtempSync(join(tmpdir(), "dashboard-artifact-"));
    const result = spawnSync("sh", [builder, output], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Refusing artifact");
    expect(readdirSync(output).sort()).toEqual(["dashboard.html", "run-dashboard-sidecar.js"]);

    writeFileSync(join(output, "forbidden.txt"), "must not be packaged\n");
    const rejected = spawnSync("sh", [builder, output], { cwd: root, encoding: "utf8" });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("forbidden file in output");
  });

  it("rejects an import outside the exact source allowlist", () => {
    const copy = mkdtempSync(join(tmpdir(), "dashboard-build-root-"));
    for (const file of [
      "deploy/build-dashboard-sidecar-artifact.sh", "scripts/run-dashboard-sidecar.ts",
      "src/dashboard/DashboardSnapshotSidecar.ts", "src/dashboard/DashboardService.ts",
      "src/dashboard/server.ts", "src/dashboard/dashboard.html",
    ]) {
      const destination = join(copy, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(root, file), destination, { recursive: true });
    }
    writeFileSync(join(copy, "forbidden.ts"), "export const forbidden = true;\n");
    writeFileSync(join(copy, "scripts/run-dashboard-sidecar.ts"), `${readFileSync(join(copy, "scripts/run-dashboard-sidecar.ts"), "utf8")}\nimport "../forbidden.js";\n`);
    const result = spawnSync("sh", [join(copy, "deploy/build-dashboard-sidecar-artifact.sh"), join(copy, "out")], {
      cwd: copy, encoding: "utf8", env: { ...process.env, ESBUILD_BIN: join(root, "node_modules/.bin/esbuild") },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("imports differ from the exact allowlist");
  });

  it("defines a loopback-only, sidecar-only unit", () => {
    const unit = readFileSync(join(root, "deploy/systemd/riim-dashboard.service"), "utf8");
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/riim-dashboard/run-dashboard-sidecar.js");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).not.toMatch(/run-(?:live|paper)|tailscale|0\.0\.0\.0/i);
  });
});
