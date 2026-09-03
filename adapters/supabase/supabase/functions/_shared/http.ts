export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(data, { ...init, headers });
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
