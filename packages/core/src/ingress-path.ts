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

/** Allow only the two transformations observed at hosted Supabase ingress. */
export function restoreSupabaseIngressPath(
  original: unknown,
  observed: string,
): string {
  assertOriginalPath(original);
  const separator = original.indexOf("?");
  const path = separator < 0 ? original : original.slice(0, separator);
  const query = separator < 0 ? "" : original.slice(separator);
  const collapsed = `${path.replace(/\/{2,}/gu, "/")}${query}`;
  const upperEscapes = (value: string): string =>
    value.replace(/%[\da-f]{2}/giu, (escape) => escape.toUpperCase());
  if (
    ![
      original,
      collapsed,
      upperEscapes(original),
      upperEscapes(collapsed),
    ].includes(observed)
  )
    throw new TypeError(
      "Gateway path does not match its original path binding",
    );
  return original;
}
