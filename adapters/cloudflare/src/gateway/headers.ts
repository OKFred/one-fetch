import {
  ONE_FETCH_RESERVED_HEADER_NAMES,
  type HeaderEntryV1,
  type HeaderMutationNoticeV1,
} from "@one-fetch/protocol";

import { problem } from "./errors";

const FORBIDDEN_UPSTREAM = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-version",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const STRIPPED_RESPONSE = new Set([
  ...FORBIDDEN_UPSTREAM,
  "set-cookie",
  ...ONE_FETCH_RESERVED_HEADER_NAMES,
]);

export interface BuiltHeaders {
  headers: Headers;
  mutations: HeaderMutationNoticeV1[];
}

export function buildUpstreamHeaders(
  entries: HeaderEntryV1[],
  referrer?: string,
): BuiltHeaders {
  const headers = new Headers();
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    if (ONE_FETCH_RESERVED_HEADER_NAMES.has(name)) {
      throw problem(
        "unsupported_header",
        "protocol",
        `The reserved ${entry.name} protocol header cannot be forwarded to a target`,
        400,
        false,
        { header: entry.name },
      );
    }
    if (FORBIDDEN_UPSTREAM.has(name) || name.startsWith("proxy-")) {
      throw problem(
        "unsupported_header",
        "protocol",
        `The ${entry.name} header cannot be forwarded by Cloudflare`,
        400,
        false,
        { header: entry.name },
      );
    }
    if (name === "set-cookie") {
      throw problem(
        "unsupported_header",
        "protocol",
        "Set-Cookie is not valid on a target request",
        400,
        false,
      );
    }
    try {
      headers.append(entry.name, entry.value);
    } catch {
      throw problem(
        "unsupported_header",
        "protocol",
        `The ${entry.name} header is invalid`,
        400,
        false,
        { header: entry.name },
      );
    }
  }

  const mutations: HeaderMutationNoticeV1[] = [];
  if (referrer && !headers.has("referer")) {
    headers.set("referer", referrer);
    mutations.push({
      side: "request",
      actor: "adapter",
      operation: "added",
      name: "Referer",
      detail: "fetchOptions.referrer was translated to an HTTP Referer header.",
    });
  }
  return { headers, mutations };
}

export function stripCrossOriginCredentials(
  headers: Headers,
): HeaderMutationNoticeV1[] {
  const mutations: HeaderMutationNoticeV1[] = [];
  for (const name of ["authorization", "cookie"]) {
    if (!headers.has(name)) continue;
    headers.delete(name);
    mutations.push({
      side: "request",
      actor: "one-fetch",
      operation: "removed",
      name,
      detail: "Removed while following a cross-origin redirect.",
    });
  }
  return mutations;
}

export function targetHeaderEntries(headers: Headers): HeaderEntryV1[] {
  const result: HeaderEntryV1[] = [];
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() !== "set-cookie") result.push({ name, value });
  }
  return result;
}

export function getSetCookie(headers: Headers): string[] {
  return headers.getSetCookie();
}

export function outerResponseHeaders(targetHeaders: Headers): Headers {
  const result = new Headers();
  for (const [name, value] of targetHeaders.entries()) {
    if (!STRIPPED_RESPONSE.has(name.toLowerCase())) result.append(name, value);
  }
  result.delete("content-length");
  return result;
}

export function removeBodyHeaders(headers: Headers): void {
  for (const name of [
    "content-length",
    "content-type",
    "content-encoding",
    "content-language",
    "content-location",
  ]) {
    headers.delete(name);
  }
}
