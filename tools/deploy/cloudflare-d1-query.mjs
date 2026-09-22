import { Buffer } from "node:buffer";
import { coordinationIdentity } from "./cloudflare-coordination.mjs";
import { runWrangler } from "./cloudflare-runtime.mjs";

async function boundedJson(response) {
  if (!response.body) throw new Error("D1 coordination response has no body");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 65_536)
        throw new Error("D1 coordination response is too large");
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Wrangler has no bound-parameter CLI option. Its supported auth-token command
// supplies credentials only in memory for the fixed D1 query API, never argv.
export async function createCloudflareD1Query(state, dependencies = {}) {
  coordinationIdentity(state);
  const run = dependencies.runWrangler ?? runWrangler;
  const fetch = dependencies.fetch ?? globalThis.fetch;
  let auth;
  try {
    auth = await run(["auth", "token", "--json"], {
      json: true,
      accountId: state.accountId,
    });
  } catch {
    throw new Error("Cloudflare coordination authentication failed");
  }
  if (
    !["oauth", "api_token"].includes(auth?.type) ||
    typeof auth.token !== "string" ||
    auth.token.length < 16
  )
    throw new Error(
      "Cloudflare coordination requires a supported token credential",
    );
  const url = `https://api.cloudflare.com/client/v4/accounts/${state.accountId}/d1/database/${state.resources.databaseId}/query`;
  return async (sql, params) => {
    try {
      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql, params }),
        signal: globalThis.AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("D1 query failed");
      }
      const value = await boundedJson(response);
      if (
        value.success !== true ||
        !Array.isArray(value.result) ||
        value.result.length !== 1 ||
        value.result[0]?.success !== true ||
        !Array.isArray(value.result[0].results)
      )
        throw new Error("D1 query returned an invalid result");
      return value.result[0].results;
    } catch {
      // Provider errors may contain SQL/credentials. Do not print or retry them.
      throw new Error(
        "D1 coordination query failed; remote outcome may be unknown; inspect before recovery",
      );
    }
  };
}
