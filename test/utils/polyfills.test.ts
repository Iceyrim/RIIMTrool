import { describe, expect, it, vi } from "vitest";

import "../../src/utils/polyfills.js";

describe("Uint8Array.prototype.toHex compatibility shim", () => {
  it("encodes every byte as two lowercase hexadecimal characters", () => {
    const bytes = Uint8Array.from([0, 15, 255]);

    expect((bytes as Uint8Array & { toHex(): string }).toHex()).toBe("000fff");
  });

  it("does not replace an existing implementation", async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      Uint8Array.prototype,
      "toHex",
    );
    const existingToHex = () => "existing";

    Object.defineProperty(Uint8Array.prototype, "toHex", {
      value: existingToHex,
      writable: true,
      configurable: true,
    });

    try {
      vi.resetModules();
      await vi.importActual("../../src/utils/polyfills.js");

      const toHex = (Uint8Array.prototype as Uint8Array & {
        toHex(): string;
      }).toHex;
      expect(toHex).toBe(existingToHex);
      expect(toHex.call(Uint8Array.from([255]))).toBe("existing");
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          Uint8Array.prototype,
          "toHex",
          originalDescriptor,
        );
      } else {
        delete (Uint8Array.prototype as { toHex?: () => string }).toHex;
      }
    }
  });
});
