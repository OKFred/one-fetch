import type { ServerTimingMetricV1 } from "@one-fetch/protocol";

export type ServerTimingHeaderValue =
  | string
  | readonly string[]
  | null
  | undefined;

const METRIC_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/u;
const MAX_METRICS = 128;
const MAX_DESCRIPTION_LENGTH = 512;

function splitOutsideQuotes(value: string, delimiter: "," | ";"): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === delimiter) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function parameterValue(parameter: string): [string, string] | undefined {
  const separator = parameter.indexOf("=");
  if (separator < 0) return undefined;
  const name = parameter.slice(0, separator).trim().toLowerCase();
  return name === ""
    ? undefined
    : [name, parameter.slice(separator + 1).trim()];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  const content = trimmed.slice(1, -1);
  let result = "";
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === "\\" && index + 1 < content.length) {
      index += 1;
      result += content[index];
    } else {
      result += character;
    }
  }
  return result;
}

export function parseServerTiming(
  value: ServerTimingHeaderValue,
): ServerTimingMetricV1[] {
  const fields: readonly string[] =
    typeof value === "string" ? [value] : (value ?? []);
  const metrics: ServerTimingMetricV1[] = [];
  for (const field of fields) {
    for (const rawMetric of splitOutsideQuotes(field, ",")) {
      const [rawName, ...rawParameters] = splitOutsideQuotes(rawMetric, ";");
      const name = rawName?.trim();
      if (name === undefined || !METRIC_NAME.test(name)) continue;
      let durationMs: number | undefined;
      let description: string | undefined;
      for (const rawParameter of rawParameters) {
        const parsedParameter = parameterValue(rawParameter);
        if (parsedParameter === undefined) continue;
        const [parameterName, rawValue] = parsedParameter;
        if (parameterName === "dur") {
          const parsedDuration = Number(rawValue);
          if (Number.isFinite(parsedDuration) && parsedDuration >= 0) {
            durationMs = parsedDuration;
          }
        } else if (parameterName === "desc") {
          description = unquote(rawValue).slice(0, MAX_DESCRIPTION_LENGTH);
        }
      }
      metrics.push({
        name,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(description === undefined ? {} : { description }),
      });
      if (metrics.length >= MAX_METRICS) return metrics;
    }
  }
  return metrics;
}
