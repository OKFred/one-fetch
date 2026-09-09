import type { OneFetchTimingV1 } from "@one-fetch/protocol";

export { parseServerTiming } from "@one-fetch/core";

export function initialTiming(
  authMs: number,
  policyMs: number,
  upstreamMs: number,
  serverTiming: OneFetchTimingV1["serverTiming"],
): OneFetchTimingV1 {
  return {
    phases: [
      {
        name: "auth",
        state: "measured",
        source: "gateway",
        durationMs: authMs,
      },
      {
        name: "policy",
        state: "measured",
        source: "gateway",
        durationMs: policyMs,
      },
      {
        name: "dns",
        state: "unavailable",
        source: "vendor",
        detail: "Cloudflare does not expose target DNS timing.",
      },
      {
        name: "connect",
        state: "unavailable",
        source: "vendor",
        detail: "Cloudflare does not expose target connection timing.",
      },
      {
        name: "tls",
        state: "unavailable",
        source: "vendor",
        detail: "Cloudflare does not expose target TLS timing.",
      },
      {
        name: "ttfb",
        state: "measured",
        source: "gateway",
        durationMs: upstreamMs,
      },
    ],
    serverTiming,
  };
}
