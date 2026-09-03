export function applyCors(
  request: Request,
  response: Response,
  allowedOrigins: readonly string[],
): Response {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins.includes(origin)) return response;

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-credentials", "true");
  headers.set(
    "access-control-expose-headers",
    "etag, one-fetch-response, server-timing",
  );
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function preflight(
  request: Request,
  allowedOrigins: readonly string[],
): Response | undefined {
  if (
    request.method !== "OPTIONS" ||
    !request.headers.has("access-control-request-method")
  )
    return undefined;
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins.includes(origin)) {
    return Response.json(
      { error: "origin_not_allowed" },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers":
        "authorization,content-type,if-match,one-fetch-request,one-fetch-token",
      "access-control-max-age": "600",
      "cache-control": "no-store",
      vary: "Origin",
    },
  });
}
