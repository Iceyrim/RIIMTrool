import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { ExchangeAdapterError } from "../../AdapterError.js";
import type { PerplExecutionTransport } from "./PerplCanaryExecutor.js";
import type { PerplExecutionIntent } from "./executionProtocol.js";

/** Process transport for the Rust worker whose backend is compile-time disabled. */
export class PerplDisabledExecutionTransport implements PerplExecutionTransport {
  private static readonly REQUEST_TIMEOUT_MS = 5_000;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private failed?: ExchangeAdapterError;

  constructor(binaryPath: string, journalPath: string) {
    if (!binaryPath || binaryPath.includes("\0") || !journalPath || journalPath.includes("\0")) {
      throw new ExchangeAdapterError("Perpl disabled worker paths are invalid");
    }
    this.child = spawn(binaryPath, [`--journal-path=${journalPath}`], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {},
    });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on("line", (line) =>
      this.ingest(line),
    );
    this.child.stderr.on("data", () => undefined);
    this.child.once("error", (error) =>
      this.fail(`disabled worker failed to start: ${error.message}`),
    );
    this.child.once("exit", (code, signal) => {
      if (this.pending.size) this.fail(`disabled worker exited (${code ?? signal ?? "unknown"})`);
    });
  }

  request(intent: PerplExecutionIntent): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.pending.has(intent.id)) {
      return Promise.reject(new ExchangeAdapterError(`duplicate disabled worker id ${intent.id}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(intent.id);
        reject(new ExchangeAdapterError("disabled worker request timed out", undefined, true));
      }, PerplDisabledExecutionTransport.REQUEST_TIMEOUT_MS);
      this.pending.set(intent.id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(intent)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(intent.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(intent.id);
        pending.reject(new ExchangeAdapterError("disabled worker write failed", error, true));
      });
    });
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 2_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private ingest(line: string): void {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const id = typeof value.id === "string" ? value.id : "";
      const pending = this.pending.get(id);
      if (!pending) throw new ExchangeAdapterError(`disabled worker response has unknown id ${id}`);
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve(value);
    } catch (error) {
      this.fail(String(error));
    }
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = new ExchangeAdapterError(message, undefined, true);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failed);
    }
    this.pending.clear();
  }
}
