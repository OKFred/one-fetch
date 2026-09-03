export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(data, { ...init, headers });
}

export const CONTROL_JSON_LIMIT_BYTES = 1_048_576;

export class InvalidJsonBodyError extends Error {}

export class JsonBodyTooLargeError extends Error {}

export async function readBoundedJson(
  request: Request,
  limitBytes = CONTROL_JSON_LIMIT_BYTES,
): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > limitBytes
  ) {
    throw new JsonBodyTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) throw new InvalidJsonBodyError();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader
          .cancel("Control JSON body exceeded its byte limit")
          .catch(() => undefined);
        throw new JsonBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new InvalidJsonBodyError();
  }
}

export function bearer(
  request: Request,
  headerName = "authorization",
): string | undefined {
  const value = request.headers.get(headerName);
  if (!value) return undefined;
  if (headerName.toLowerCase() !== "authorization")
    return value.trim() || undefined;
  const match = /^Bearer\s+([^\s]+)$/iu.exec(value);
  return match?.[1];
}

export function requestPath(request: Request, functionName: string): string {
  const pathname = new URL(request.url).pathname;
  const marker = `/${functionName}`;
  const index = pathname.indexOf(marker);
  if (index === -1) return pathname;
  const path = pathname.slice(index + marker.length);
  return path.startsWith("/") ? path : `/${path}`;
}

export function normalizeControlRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = requestPath(request, "one-fetch-control");
  return new Request(url, request);
}

export function uuid(): string {
  return crypto.randomUUID();
}
