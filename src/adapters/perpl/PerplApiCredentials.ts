import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ExchangeAdapterError } from "../AdapterError.js";

export interface PerplApiCredentials { apiKey: string; apiKeySecret: string; source: string }

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"')))
    return trimmed.slice(1, -1);
  return trimmed;
}

/** Loads only the two expected keys from a root-owned, non-group/world-accessible file. */
export function loadPerplApiCredentials(
  filePath = process.env.PERPL_API_ENV_FILE ?? "/root/.config/riimtrool/perpl-api.env",
): PerplApiCredentials {
  const path = resolve(filePath);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ExchangeAdapterError("Perpl API credential path must be a regular file, not a symlink");
  if ((stat.mode & 0o077) !== 0)
    throw new ExchangeAdapterError("Perpl API credential file must not be accessible by group or others");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new ExchangeAdapterError("Perpl API credential file must be owned by the running user");

  const values = new Map<string, string>();
  for (const [index, raw] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(PERPL_API_KEY|PERPL_API_KEY_SECRET)=(.*)$/.exec(line);
    if (!match) throw new ExchangeAdapterError(`Unexpected Perpl API credential entry on line ${index + 1}`);
    if (values.has(match[1]!)) throw new ExchangeAdapterError(`Duplicate ${match[1]} entry`);
    values.set(match[1]!, unquote(match[2]!));
  }
  const apiKey = values.get("PERPL_API_KEY") ?? "";
  const apiKeySecret = values.get("PERPL_API_KEY_SECRET") ?? "";
  if (!apiKey) throw new ExchangeAdapterError("PERPL_API_KEY is missing from the credential file");
  if (!/^(?:0x)?[0-9a-f]{64}$/i.test(apiKeySecret))
    throw new ExchangeAdapterError("PERPL_API_KEY_SECRET must be a 32-byte hexadecimal Ed25519 key");
  return { apiKey, apiKeySecret, source: path };
}
