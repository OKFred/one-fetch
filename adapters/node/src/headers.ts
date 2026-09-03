import type { IncomingHttpHeaders } from "node:http";

import { ONE_FETCH_LIMITS_V1, type HeaderEntryV1 } from "@one-fetch/protocol";

const UNSAFE_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export const validateTargetHeaders = (
  headers: HeaderEntryV1[],
): string | undefined => {
  for (const { name } of headers) {
    const normalized = name.toLowerCase();
    if (
      UNSAFE_REQUEST_HEADERS.has(normalized) ||
      normalized.startsWith("one-fetch-")
    )
      return name;
    if (normalized.startsWith("proxy-")) return name;
  }
  return undefined;
};

export const reconcileContentType = (
  headers: HeaderEntryV1[],
  declared: string | undefined,
): HeaderEntryV1[] | undefined => {
  const contentTypes = headers.filter(
    ({ name }) => name.toLowerCase() === "content-type",
  );
  if (contentTypes.length > 1) return undefined;
  const forwarded = contentTypes[0]?.value;
  if (forwarded !== undefined && forwarded.trim() === "") return undefined;
  if (declared !== undefined && declared.trim() === "") return undefined;
  if (forwarded !== undefined && declared !== undefined) {
    return forwarded === declared ? headers : undefined;
  }
  if (declared !== undefined && headers.length >= ONE_FETCH_LIMITS_V1.headers)
    return undefined;
  return declared === undefined
    ? headers
    : [...headers, { name: "Content-Type", value: declared }];
};

export const toNodeHeaderArray = (headers: HeaderEntryV1[]): string[] =>
  headers.flatMap(({ name, value }) => [name, value]);

export const fromRawHeaders = (rawHeaders: string[]): HeaderEntryV1[] => {
  const entries: HeaderEntryV1[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined)
      entries.push({ name, value });
  }
  return entries;
};

export const setCookieValues = (
  headers: IncomingHttpHeaders,
  entries: HeaderEntryV1[],
): string[] => {
  if (headers["set-cookie"]) return headers["set-cookie"];
  return entries
    .filter(({ name }) => name.toLowerCase() === "set-cookie")
    .map(({ value }) => value);
};

export const stripSensitiveRedirectHeaders = (
  headers: HeaderEntryV1[],
): HeaderEntryV1[] => {
  const sensitive = new Set(["authorization", "cookie", "proxy-authorization"]);
  return headers.filter(({ name }) => !sensitive.has(name.toLowerCase()));
};

export const stripBodyHeaders = (headers: HeaderEntryV1[]): HeaderEntryV1[] => {
  const bodyHeaders = new Set([
    "content-encoding",
    "content-language",
    "content-length",
    "content-location",
    "content-type",
  ]);
  return headers.filter(({ name }) => !bodyHeaders.has(name.toLowerCase()));
};
