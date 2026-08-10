import { readFileSync } from "node:fs";
import { load as parseYaml } from "js-yaml";
import { marketsConfigSchema, type MarketsConfig } from "./schema.js";

/**
 * Loads and validates the markets config file. Fails loudly (throws, with the full validation
 * detail) on any malformed or missing field rather than silently proceeding with partial/wrong
 * config — this is the direct fix for SPEC.md Section 6's `.env`-heredoc-corruption class of
 * bug: a structured format with real validation cannot silently merge or drop values the way a
 * flat `.env` file did.
 */
export function loadMarketsConfig(filePath: string): MarketsConfig {
  let raw: unknown;
  try {
    const contents = readFileSync(filePath, "utf-8");
    raw = parseYaml(contents);
  } catch (err) {
    throw new Error(`Failed to read/parse config file at "${filePath}": ${String(err)}`, {
      cause: err,
    });
  }

  const result = marketsConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid markets config at "${filePath}":\n${details}`);
  }

  const symbols = result.data.markets.map((m) => m.symbol);
  const duplicates = symbols.filter((s, i) => symbols.indexOf(s) !== i);
  if (duplicates.length > 0) {
    throw new Error(
      `Invalid markets config at "${filePath}": duplicate symbol(s): ${[...new Set(duplicates)].join(", ")}`,
    );
  }

  return result.data;
}
