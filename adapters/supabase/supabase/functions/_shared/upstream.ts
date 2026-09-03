import { ONE_FETCH_RESERVED_HEADER_NAMES } from "@one-fetch/protocol";
import type { HeaderEntryV1, OneFetchRequestMetaV1 } from "./protocol-types.ts";

export { parseServerTiming } from "@one-fetch/core";

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
const SENSITIVE_REDIRECT_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "referer",
]);

function validateTargetHeader(name: string): void {
  const normalized = name.toLowerCase();
  if (
    FORBIDDEN_TARGET_HEADERS.has(normalized) ||
    ONE_FETCH_RESERVED_HEADER_NAMES.has(normalized) ||
    normalized.startsWith("proxy-")
  ) {
    throw new TypeError(`Unsupported target header: ${name}`);
  }
}

export function targetHeaderEntries(
  entries: readonly HeaderEntryV1[],
  metadata: OneFetchRequestMetaV1,
): HeaderEntryV1[] {
  const result = entries.map(({ name, value }) => {
    validateTargetHeader(name);
    return { name, value };
  });
  if (metadata.fetchOptions.referrer) {
    if (result.some(({ name }) => name.toLowerCase() === "referer")) {
      throw new TypeError(
        "Fetch referrer conflicts with an explicit Referer header",
      );
    }
    result.push({ name: "Referer", value: metadata.fetchOptions.referrer });
  }
  return result;
}

export function targetHeaders(
  entries: readonly HeaderEntryV1[],
  metadata: OneFetchRequestMetaV1,
): Headers {
  const headers = new Headers();
  const cookieValues: string[] = [];
  for (const { name, value } of targetHeaderEntries(entries, metadata)) {
    const normalized = name.toLowerCase();
    if (normalized === "cookie") cookieValues.push(value);
    else headers.append(name, value);
  }
  if (cookieValues.length > 0) headers.set("cookie", cookieValues.join("; "));
  return headers;
}

export function requestContentType(
  entries: readonly HeaderEntryV1[],
  metadata: OneFetchRequestMetaV1,
): string | undefined {
  const values = entries
    .filter(({ name }) => name.toLowerCase() === "content-type")
    .map(({ value }) => value.trim());
  if (values.length > 1) {
    throw new TypeError("Multiple Content-Type headers are unsupported");
  }
  const headerValue = values[0];
  const declared = metadata.body.contentType?.trim();
  if (declared !== undefined && declared !== headerValue) {
    throw new TypeError("Body content type does not match target headers");
  }
  return headerValue;
}

export function stripSensitiveRedirectHeaders(headers: Headers): void {
  for (const name of SENSITIVE_REDIRECT_HEADERS) headers.delete(name);
}

export function stripSensitiveRedirectHeaderEntries(
  entries: readonly HeaderEntryV1[],
): HeaderEntryV1[] {
  return entries.filter(
    ({ name }) => !SENSITIVE_REDIRECT_HEADERS.has(name.toLowerCase()),
  );
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
