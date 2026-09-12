import { ONE_FETCH_LIMITS_V1 } from "@one-fetch/protocol";
import type { OneFetchRequestMetaV1 } from "../_shared/protocol-types.ts";
import { sha256Hex, targetUrlFromPath } from "@one-fetch/core";

import type { ExecutionPrincipal } from "../_shared/auth.ts";
import { requestPath } from "../_shared/http.ts";

export async function readRequestBody(
  request: Request,
  metadata: OneFetchRequestMetaV1,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = transportBodySize(request.headers.get("content-length"));
  if (
    declared !== undefined &&
    declared > ONE_FETCH_LIMITS_V1.requestBodyBytes
  ) {
    throw new RangeError("payload_too_large");
  }
  const body = await readBody(request.body, signal);
  if (declared !== undefined && declared !== body.byteLength) {
    throw new TypeError("transport_body_size_mismatch");
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

function transportBodySize(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readBody(
  stream: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await readNext(reader, signal);
    if (result.done) return concatenate(chunks, size);
    size += result.value.byteLength;
    if (size > ONE_FETCH_LIMITS_V1.requestBodyBytes) {
      await reader.cancel("request_limit");
      throw new RangeError("payload_too_large");
    }
    chunks.push(result.value);
  }
}

async function readNext(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) {
    await reader.cancel(signal.reason).catch(() => undefined);
    throw abortError(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(abortError(signal.reason));
    };
    signal.addEventListener("abort", aborted, { once: true });
    void reader
      .read()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === "string" ? reason : "Request aborted",
    "AbortError",
  );
}

function concatenate(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
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
  if (!origins.includes("*") && !origins.includes(target.origin)) {
    return false;
  }
  const ports = principal.scopes.ports;
  if (!Array.isArray(ports) || ports.length === 0) return true;
  const port = target.port
    ? Number.parseInt(target.port, 10)
    : target.protocol === "https:"
      ? 443
      : 80;
  return ports.includes(port);
}

export function pathAndQuery(request: Request): string {
  const url = new URL(request.url);
  return `${requestPath(request, "one-fetch-gateway")}${url.search}`;
}

export function targetUrl(targetOrigin: string, pathQuery: string): URL {
  const separator = pathQuery.startsWith("/") ? "" : "/";
  return targetUrlFromPath(targetOrigin, `${separator}${pathQuery}`);
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
