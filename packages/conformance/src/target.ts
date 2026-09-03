function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function json(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export async function handleConformanceTarget(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/echo" || url.pathname === "/echo") {
    const body = new Uint8Array(await request.arrayBuffer());
    return json({
      method: request.method,
      path: url.pathname,
      rawQuery: url.search.slice(1),
      query: Array.from(url.searchParams.entries()),
      headers: Array.from(request.headers.entries()),
      bodyBase64: bytesToBase64(body),
    });
  }
  const statusMatch = /^\/status\/(\d{3})$/u.exec(url.pathname);
  if (statusMatch !== null) {
    const status = Number(statusMatch[1]);
    if (status < 200 || status > 599)
      return new Response("invalid status", { status: 400 });
    return new Response(`target-status-${status}`, {
      status,
      statusText: status === 503 ? "Service Unavailable" : "Fixture",
    });
  }
  if (url.pathname === "/set-cookie") {
    const headers = new Headers({ "Content-Type": "text/plain" });
    headers.append("Set-Cookie", "alpha=1; Path=/; Secure");
    headers.append("Set-Cookie", "beta=2; Path=/; HttpOnly; Secure");
    return new Response("cookies", { headers });
  }
  if (url.pathname === "/server-timing") {
    return new Response("timed", {
      headers: { "Server-Timing": 'db;dur=12.5;desc="database", app;dur=4' },
    });
  }
  if (url.pathname === "/redirect") {
    return new Response(null, {
      status: 302,
      headers: { Location: "/echo?redirected=1" },
    });
  }
  return new Response("fixture-not-found", { status: 404 });
}
