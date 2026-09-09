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

function byteStream(
  size: number,
  chunkSize: number,
): ReadableStream<Uint8Array> {
  let emitted = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= size) {
        controller.close();
        return;
      }
      const length = Math.min(chunkSize, size - emitted);
      const chunk = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        chunk[index] = (emitted + index) % 251;
      }
      emitted += length;
      controller.enqueue(chunk);
    },
  });
}

const boundedInteger = (
  value: string | undefined,
  maximum: number,
): number | undefined => {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value))
    return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : undefined;
};

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
      contentType: request.headers.get("content-type"),
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
      headers: {
        Location: url.searchParams.get("to") ?? "/echo?redirected=1",
      },
    });
  }
  const bytesMatch = /^\/bytes\/(\d+)$/u.exec(url.pathname);
  if (bytesMatch !== null) {
    const size = boundedInteger(bytesMatch[1], 20_971_521);
    const chunkSize = boundedInteger(
      url.searchParams.get("chunk") ?? undefined,
      1_048_576,
    );
    if (size === undefined)
      return new Response("invalid byte count", { status: 400 });
    return new Response(byteStream(size, chunkSize ?? 65_536), {
      headers: {
        "Content-Length": String(size),
        "Content-Type": "application/octet-stream",
      },
    });
  }
  const delayMatch = /^\/delay\/(\d+)$/u.exec(url.pathname);
  if (delayMatch !== null) {
    const delayMs = boundedInteger(delayMatch[1], 60_000);
    if (delayMs === undefined)
      return new Response("invalid delay", { status: 400 });
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return new Response("delayed");
  }
  if (url.pathname === "/truncated") {
    let emitted = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!emitted) {
            emitted = true;
            controller.enqueue(new TextEncoder().encode("partial"));
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          controller.error(new Error("synthetic target body failure"));
        },
      }),
      { headers: { "Content-Type": "application/octet-stream" } },
    );
  }
  return json(
    {
      error: "fixture-not-found",
      method: request.method,
      path: url.pathname,
      rawQuery: url.search.slice(1),
    },
    { status: 404 },
  );
}
