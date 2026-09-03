import {
  ONE_FETCH_RESERVED_HEADER_NAMES,
  type HeaderEntryV1,
  type OneFetchRequestMetaV1,
  type ServerTimingMetricV1Schema,
} from "@one-fetch/protocol";

type ServerTimingMetric = typeof ServerTimingMetricV1Schema._output;

const FORBIDDEN_TARGET_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function targetHeaders(
  entries: readonly HeaderEntryV1[],
  metadata: OneFetchRequestMetaV1,
): Headers {
  const headers = new Headers();
  const cookieValues: string[] = [];
  for (const { name, value } of entries) {
    const normalized = name.toLowerCase();
    if (
      FORBIDDEN_TARGET_HEADERS.has(normalized) ||
      ONE_FETCH_RESERVED_HEADER_NAMES.has(normalized) ||
      normalized.startsWith("proxy-")
    ) {
      throw new TypeError(`Unsupported target header: ${name}`);
    }
    if (normalized === "cookie") cookieValues.push(value);
    else headers.append(name, value);
  }
  if (cookieValues.length > 0) headers.set("cookie", cookieValues.join("; "));
  if (metadata.fetchOptions.referrer && !headers.has("referer")) {
    headers.set("referer", metadata.fetchOptions.referrer);
  }
  return headers;
}

export function stripSensitiveRedirectHeaders(headers: Headers): void {
  for (const name of [
    "authorization",
    "cookie",
    "proxy-authorization",
    "referer",
  ])
    headers.delete(name);
}

export function responseHeaderEntries(headers: Headers): HeaderEntryV1[] {
  const result: HeaderEntryV1[] = [];
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() !== "set-cookie") result.push({ name, value });
  }
  return result;
}

export function responseSetCookies(headers: Headers): string[] {
  const compatible = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof compatible.getSetCookie === "function")
    return compatible.getSetCookie();
  const merged = headers.get("set-cookie");
  return merged ? [merged] : [];
}

export function outerResponseHeaders(target: Headers): Headers {
  const headers = new Headers();
  for (const name of [
    "content-type",
    "content-language",
    "content-disposition",
    "etag",
    "last-modified",
  ]) {
    const value = target.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function splitOutsideQuotes(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quoted) {
      current += character;
      escaped = true;
    } else if (character === '"') {
      current += character;
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      result.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

export function parseServerTiming(value: string | null): ServerTimingMetric[] {
  if (!value) return [];
  return splitOutsideQuotes(value)
    .slice(0, 128)
    .flatMap((entry) => {
      const [rawName, ...parameters] = entry.split(";");
      const name = rawName?.trim();
      if (!name || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name)) return [];
      let durationMs: number | undefined;
      let description: string | undefined;
      for (const parameter of parameters) {
        const [rawKey, ...rawValue] = parameter.trim().split("=");
        const parameterValue = rawValue.join("=").trim();
        if (rawKey?.toLowerCase() === "dur") {
          const parsed = Number(parameterValue);
          if (Number.isFinite(parsed) && parsed >= 0) durationMs = parsed;
        } else if (rawKey?.toLowerCase() === "desc") {
          description = parameterValue.replace(/^"|"$/gu, "").slice(0, 512);
        }
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

export function assertNoOuterProtocolHeaders(headers: Headers): void {
  for (const name of ONE_FETCH_RESERVED_HEADER_NAMES) {
    if (
      name !== "one-fetch-request" &&
      name !== "one-fetch-token" &&
      headers.has(name)
    ) {
      throw new TypeError(`Unexpected outer protocol header: ${name}`);
    }
  }
}
