import type { OneFetchTimingV1 } from "@one-fetch/protocol";

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

export const parseServerTiming = (
  values: string | string[] | undefined,
): OneFetchTimingV1["serverTiming"] => {
  const joined = Array.isArray(values) ? values.join(",") : values;
  if (!joined) return [];
  const metrics: OneFetchTimingV1["serverTiming"] = [];
  for (const item of joined.split(",")) {
    const parts = item.trim().split(";");
    const name = parts.shift()?.trim();
    if (!name || !TOKEN.test(name)) continue;
    let durationMs: number | undefined;
    let description: string | undefined;
    for (const parameter of parts) {
      const [rawName, ...rawValue] = parameter.trim().split("=");
      const value = rawValue.join("=").trim().replace(/^"|"$/gu, "");
      if (rawName?.toLowerCase() === "dur") {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) durationMs = parsed;
      }
      if (rawName?.toLowerCase() === "desc") description = value.slice(0, 512);
    }
    metrics.push({
      name,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(description ? { description } : {}),
    });
    if (metrics.length >= 128) break;
  }
  return metrics;
};
