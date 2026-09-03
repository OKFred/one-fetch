import type { ServerTimingMetricV1 } from "@one-fetch/protocol";

function unquote(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replace(/\\([\\"])/gu, "$1");
}

function splitOutsideQuotes(value: string, delimiter: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    else if (character === delimiter && !quoted) {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  result.push(value.slice(start));
  return result;
}

export function parseServerTiming(
  value: string | null,
): ServerTimingMetricV1[] {
  if (value === null || value.trim() === "") return [];
  const metrics: ServerTimingMetricV1[] = [];
  for (const rawMetric of splitOutsideQuotes(value, ",")) {
    const [rawName, ...rawParameters] = splitOutsideQuotes(rawMetric, ";");
    const name = rawName?.trim();
    if (name === undefined || !/^[A-Za-z0-9_.-]{1,128}$/u.test(name)) continue;
    let durationMs: number | undefined;
    let description: string | undefined;
    for (const parameter of rawParameters) {
      const [rawKey, ...rawValue] = parameter.split("=");
      const key = rawKey?.trim().toLowerCase();
      const parameterValue = rawValue.join("=").trim();
      if (key === "dur") {
        const parsed = Number(parameterValue);
        if (Number.isFinite(parsed) && parsed >= 0) durationMs = parsed;
      } else if (key === "desc") {
        description = unquote(parameterValue).slice(0, 512);
      }
    }
    metrics.push({
      name,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(description === undefined ? {} : { description }),
    });
  }
  return metrics;
}
