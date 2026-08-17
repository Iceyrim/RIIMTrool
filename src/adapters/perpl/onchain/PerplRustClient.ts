import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { ExchangeAdapterError } from "../../AdapterError.js";
import { assertNoSignerInput, parseBridgeResponse, type BridgeRequest, type BridgeResponse } from "./protocol.js";

export interface PerplBridgeTransport {
  request(message: BridgeRequest): Promise<BridgeResponse>;
  close(): Promise<void>;
  onEvent?(listener: (message: BridgeResponse) => void): void;
}

export class PerplRustClient implements PerplBridgeTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (value: BridgeResponse) => void; reject: (error: Error) => void }>();
  private listener?: (message: BridgeResponse) => void;
  private failed?: ExchangeAdapterError;

  constructor(binaryPath: string) {
    if (!binaryPath || binaryPath.includes("\0")) throw new ExchangeAdapterError("Perpl bridge binary path is invalid");
    this.child = spawn(binaryPath, [], { stdio: ["pipe", "pipe", "pipe"], env: {} });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on("line", (line) => this.ingest(line));
    this.child.stderr.on("data", () => undefined);
    this.child.once("error", (error) => this.fail(`Perpl bridge failed to start: ${error.message}`));
    this.child.once("exit", (code, signal) => this.fail(`Perpl bridge exited unexpectedly (${code ?? signal ?? "unknown"})`));
  }

  onEvent(listener: (message: BridgeResponse) => void): void { this.listener = listener; }

  request(message: BridgeRequest): Promise<BridgeResponse> {
    if (this.failed) return Promise.reject(this.failed);
    assertNoSignerInput(message);
    if (this.pending.has(message.id)) return Promise.reject(new ExchangeAdapterError(`Duplicate Perpl bridge request id ${message.id}`));
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => { if (error) { this.pending.delete(message.id); reject(new ExchangeAdapterError("Perpl bridge write failed", error, true)); } });
    });
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    await new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
  }

  private ingest(line: string): void {
    try {
      const message = parseBridgeResponse(line);
      if (message.event === "state") { this.listener?.(message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) throw new ExchangeAdapterError(`Perpl bridge response has unknown id ${message.id}`);
      this.pending.delete(message.id);
      if (message.event === "fatal") pending.reject(new ExchangeAdapterError(`Perpl bridge failed: ${message.error}`)); else pending.resolve(message);
    } catch (error) { this.fail(String(error)); }
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = new ExchangeAdapterError(message, undefined, true);
    for (const pending of this.pending.values()) pending.reject(this.failed);
    this.pending.clear();
  }
}
