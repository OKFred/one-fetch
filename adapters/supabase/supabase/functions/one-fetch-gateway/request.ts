import {
  ONE_FETCH_LIMITS_V1,
  type OneFetchRequestMetaV1,
} from "@one-fetch/protocol";
import { sha256Hex } from "@one-fetch/core";

import type { ExecutionPrincipal } from "../_shared/auth.ts";
import { requestPath } from "../_shared/http.ts";

export async function readRequestBody(
  request: Request,
  metadata: OneFetchRequestMetaV1,
): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declared) &&
    declared > ONE_FETCH_LIMITS_V1.requestBodyBytes
  ) {
    throw new RangeError("payload_too_large");
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > ONE_FETCH_LIMITS_V1.requestBodyBytes) {
    throw new RangeError("payload_too_large");
  }
  if (
    metadata.body.sizeBytes !== undefined &&
    metadata.body.sizeBytes !== body.byteLength
  ) {
    throw new TypeError("body_size_mismatch");
  }
  if (
    metadata.body.sha256 !== undefined &&
    (await sha256Hex(body)) !== metadata.body.sha256
  ) {
    throw new TypeError("body_hash_mismatch");
  }
  return body;
}

export function tokenAllows(
  principal: ExecutionPrincipal,
  metadata: OneFetchRequestMetaV1,
  target: URL,
): boolean {
  const transports = principal.scopes.transports;
  if (!Array.isArray(transports) || !transports.includes(metadata.transport)) {
    return false;
  }
  const origins = principal.scopes.origins;
  return (
    !Array.isArray(origins) ||
    origins.length === 0 ||
    origins.includes(target.origin)
  );
}

export function pathAndQuery(request: Request): string {
  const url = new URL(request.url);
  return `${requestPath(request, "one-fetch-gateway")}${url.search}`;
}

export function targetUrl(targetOrigin: string, pathQuery: string): URL {
  const origin = new URL(targetOrigin);
  const separator = pathQuery.startsWith("/") ? "" : "/";
  return new URL(`${origin.origin}${separator}${pathQuery}`);
}

export function isRecursiveServiceTarget(
  target: URL,
  serviceBaseUrls: readonly string[],
): boolean {
  return serviceBaseUrls.some((value) => {
    const base = new URL(value);
    const basePath = base.pathname.replace(/\/$/u, "");
    return (
      target.origin === base.origin &&
      (target.pathname === basePath ||
        target.pathname.startsWith(`${basePath}/`))
    );
  });
}
