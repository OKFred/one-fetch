import { applyCors, preflight } from "../_shared/cors.ts";
import { createDatabase, type Database } from "../_shared/database.ts";
import { getEnvironment, type SupabaseEnvironment } from "../_shared/env.ts";
import { normalizeControlRequest, requestPath } from "../_shared/http.ts";
import { createControlApp } from "./app.ts";

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
      path.startsWith("/api/v1/reports/");
    const allowedOrigins = isClientReadable
      ? [
          ...new Set([
            ...environment.allowedAdminOrigins,
            ...environment.allowedClientOrigins,
          ]),
        ]
      : environment.allowedAdminOrigins;
    const preflightResponse = preflight(request, allowedOrigins);
    if (preflightResponse) return preflightResponse;
    const response = await app.fetch(normalizeControlRequest(request));
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
