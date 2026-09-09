import { applyCors, preflight } from "../_shared/cors.ts";
import { createDatabase, type Database } from "../_shared/database.ts";
import { getEnvironment, type SupabaseEnvironment } from "../_shared/env.ts";
import { normalizeControlRequest, requestPath } from "../_shared/http.ts";
import { createControlApp } from "./app.ts";
import { controlError } from "./helpers.ts";

export function createControlHandler(
  environment: SupabaseEnvironment = getEnvironment(),
  database: Database = createDatabase(environment),
) {
  const app = createControlApp(environment, database);
  return async (request: Request): Promise<Response> => {
    const path = requestPath(request, "one-fetch-control");
    const isClientReadable =
      path === "/api/v1/capabilities" ||
      path === "/api/v1/health" ||
      path === "/api/v1/openapi.json" ||
      path === "/api/v1/features" ||
      path.startsWith("/api/v1/features/") ||
      path.startsWith("/api/v1/reports/");
    const allowedOrigins = isClientReadable
      ? [
          ...new Set([
            ...environment.allowedAdminOrigins,
            ...environment.allowedClientOrigins,
          ]),
        ]
      : environment.allowedAdminOrigins;
    const origin = request.headers.get("origin");
    if (origin && !allowedOrigins.includes(origin)) {
      return controlError(
        "origin_not_allowed",
        "Request origin is not allowed",
        403,
      );
    }
    const preflightResponse = preflight(request, allowedOrigins);
    if (preflightResponse) return preflightResponse;
    const normalizedRequest = normalizeControlRequest(request);
    const response = await app.fetch(normalizedRequest);
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    return applyCors(
      request,
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
      allowedOrigins,
    );
  };
}
