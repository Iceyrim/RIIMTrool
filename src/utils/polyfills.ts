// Node 24 in this environment ships without Uint8Array.prototype.toHex, which
// @n1xyz/nord-ts depends on for session signing. This supplies the standard
// method exactly as specified: each byte becomes two lowercase hex characters.
if (typeof (Uint8Array.prototype as any).toHex !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    value: function toHex(this: Uint8Array): string {
      return Array.from(this)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}
