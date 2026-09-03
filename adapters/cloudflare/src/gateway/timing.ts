import type {
  OneFetchTimingV1,
  ServerTimingMetricV1Schema,
} from "@one-fetch/protocol";
import type { z } from "zod";

type ServerTimingMetric = z.infer<typeof ServerTimingMetricV1Schema>;

export function parseServerTiming(value: string | null): ServerTimingMetric[] {
  if (!value) return [];
  return value
    .split(",")
    .slice(0, 128)
    .flatMap((raw) => {
      const parts = raw.trim().split(";");
      const name = parts.shift()?.trim();
      if (!name || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u.test(name))
        return [];
      let durationMs: number | undefined;
      let description: string | undefined;
      for (const part of parts) {
        const [key, ...rest] = part.trim().split("=");
        const valuePart = rest.join("=").trim().replace(/^"|"$/gu, "");
        if (key === "dur") {
          const parsed = Number(valuePart);
          if (Number.isFinite(parsed) && parsed >= 0) durationMs = parsed;
        }
        if (key === "desc") description = valuePart.slice(0, 512);
      }
      return [
        {
          name,
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(description === undefined ? {} : { description }),
        },
      ];
    });
}

export function initialTiming(
  authMs: number,
  policyMs: number,
  upstreamMs: number,
  serverTiming: ServerTimingMetric[],
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
