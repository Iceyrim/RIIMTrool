/**
 * Normalized error type for all exchange adapters. Adapter implementations must catch their
 * exchange SDK's native error type (e.g. N1's `NordError`) at the adapter boundary and rethrow
 * as this — nowhere outside an adapter's own directory should ever need to know an exchange
 * SDK's error type exists (SPEC.md Section 1b).
 */
export class ExchangeAdapterError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
    /** Set true when a caller might reasonably retry (e.g. a network hiccup); false/undefined
     * for errors that will not resolve on retry (e.g. unknown market symbol). */
    public readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "ExchangeAdapterError";
  }
}
