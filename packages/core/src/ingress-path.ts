import { ONE_FETCH_LIMITS_V1 } from "@one-fetch/protocol";
import { targetUrlFromPath } from "./target-url.js";

/** A Fetch-serialized origin-form path, not an authority or URL reference. */
export function assertOriginalPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > ONE_FETCH_LIMITS_V1.metadataBytes ||
    !/^[\u0021-\u007e]+$/u.test(value) ||
    /[\\#]/u.test(value) ||
    /%(?![\da-f]{2})/iu.test(value)
  )
    throw new TypeError("Invalid original path binding");
  const parsed = targetUrlFromPath("https://path.invalid", value);
  if (`${parsed.pathname}${parsed.search}` !== value)
    throw new TypeError("Original path must already be Fetch-serialized");
}

function splitPathAndQuery(value: string): [string, string] {
  const separator = value.indexOf("?");
  return separator < 0
    ? [value, ""]
    : [value.slice(0, separator), value.slice(separator)];
}

const upperEscapes = (value: string): string =>
  value.replace(/%[\da-f]{2}/giu, (escape) => escape.toUpperCase());

function normalizedPath(path: string): string {
  return path.replace(/%([\da-f]{2})/giu, (escape, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return /^[A-Za-z0-9._~-]$/u.test(character)
      ? character
      : escape.toUpperCase();
  });
}

function normalizedQueryComponent(value: string): string {
  // Bytewise encoding avoids lossy UTF-8 replacement and recursive decoding.
  return value.replace(/%[\da-f]{2}|[^%]/giu, (unit) => {
    if (unit === "+") return "+";
    const byte = unit.startsWith("%")
      ? Number.parseInt(unit.slice(1), 16)
      : unit.charCodeAt(0);
    if (byte === 32) return "+";
    const character = String.fromCharCode(byte);
    return /^[A-Za-z0-9*._-]$/u.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  });
}

function normalizedQuery(query: string): string {
  if (query === "") return query;
  // Preserve duplicate order, bare flags and empty segments; do not parse into
  // URLSearchParams, which would add '=' to flags and discard empty segments.
  const components = query
    .slice(1)
    .split("&")
    .map((pair) => {
      const separator = pair.indexOf("=");
      if (separator < 0) return normalizedQueryComponent(pair);
      return `${normalizedQueryComponent(pair.slice(0, separator))}=${normalizedQueryComponent(pair.slice(separator + 1))}`;
    });
  return `?${components.join("&")}`;
}

/** Match known hosted ingress spellings; always return the original bytes. */
export function restoreSupabaseIngressPath(
  original: unknown,
  observed: string,
): string {
  assertOriginalPath(original);
  const [path, query] = splitPathAndQuery(original);
  const [observedPath, observedQuery] = splitPathAndQuery(observed);
  const paths = [path, upperEscapes(path), normalizedPath(path)];
  const acceptedPaths = paths.flatMap((value) => [
    value,
    value.replace(/\/{2,}/gu, "/"),
  ]);
  if (
    !acceptedPaths.includes(observedPath) ||
    ![query, upperEscapes(query), normalizedQuery(query)].includes(
      observedQuery,
    )
  )
    throw new TypeError(
      "Gateway path does not match its original path binding",
    );
  return original;
}
