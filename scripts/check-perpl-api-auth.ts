/** Authenticates and reads the initial wallet snapshot. This script cannot submit orders. */
import { pathToFileURL } from "node:url";
import { PerplApiExecutionTransport } from "../src/adapters/perpl/PerplApiExecutionTransport.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export async function checkPerplApiAuthentication(): Promise<Record<string, unknown>> {
  const transport = new PerplApiExecutionTransport({
    apiKey: requiredEnv("PERPL_API_KEY"),
    apiKeySecret: requiredEnv("PERPL_API_KEY_SECRET"),
    accountId: 5071,
  });
  try {
    await transport.connect();
    return {
      mode: "perpl-api-authentication-check",
      authenticated: true,
      ...transport.getConnectionEvidence(),
      orderRequestSent: false,
      transactionSubmitted: false,
    };
  } finally {
    transport.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void checkPerplApiAuthentication()
    .then((evidence) => console.log(JSON.stringify(evidence, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
