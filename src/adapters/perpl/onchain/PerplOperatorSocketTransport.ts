import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { ExchangeAdapterError } from "../../AdapterError.js";
import type { PerplExecutionTransport } from "./PerplCanaryExecutor.js";
import type { PerplExecutionIntent } from "./executionProtocol.js";

/** Connects to an operator-started local worker; it never receives wallet or process arguments. */
export class PerplOperatorSocketTransport implements PerplExecutionTransport {
  private readonly socket: Socket;
  private readonly ready: Promise<void>;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private failed?: ExchangeAdapterError;

  constructor(
    socketPath: string,
    private readonly timeoutMs = 5_000,
  ) {
    if (!socketPath.startsWith("/") || socketPath.includes("\0") || timeoutMs < 100) {
      throw new ExchangeAdapterError("Perpl operator socket configuration is invalid");
    }
    this.socket = createConnection({ path: socketPath });
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    // A plan may fail local preflight before request() awaits readiness. Keep that asynchronous
    // connection failure observed while preserving the original rejection for a later request.
    void this.ready.catch(() => undefined);
    const lines = createInterface({ input: this.socket, crlfDelay: Infinity });
    lines.on("line", (line) => this.ingest(line));
    lines.on("error", (error) => this.fail(`operator socket reader failed: ${error.message}`));
    this.socket.on("error", (error) => this.fail(`operator socket failed: ${error.message}`));
    this.socket.on("close", () => {
      if (this.pending.size) this.fail("operator socket disconnected with a pending action");
    });
  }

  async request(intent: PerplExecutionIntent): Promise<unknown> {
    await this.ready;
    if (this.failed) throw this.failed;
    if (this.pending.size || this.pending.has(intent.id)) {
      throw new ExchangeAdapterError("operator socket permits exactly one pending action");
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(intent.id);
        reject(new ExchangeAdapterError("operator socket request timed out", undefined, true));
        this.socket.destroy();
      }, this.timeoutMs);
      this.pending.set(intent.id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify(intent)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(intent.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(intent.id);
        pending.reject(new ExchangeAdapterError("operator socket write failed", error, true));
      });
    });
  }

  close(): void {
    this.socket.end();
  }

  private ingest(line: string): void {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const id = typeof value.id === "string" ? value.id : "";
      const pending = this.pending.get(id);
      if (!pending) throw new ExchangeAdapterError(`operator socket response has unknown id ${id}`);
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve(value);
    } catch (error) {
      this.fail(String(error));
      this.socket.destroy();
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
