import { OpenAPIHono } from "@hono/zod-openapi";

import {
  registerAuthenticatedControlRoutes,
  registerPublicControlRoutes,
} from "./control-auth-routes";
import { registerConfigurationRoutes } from "./control-configuration-routes";
import {
  registerExecutionReportRoute,
  registerObservabilityRoutes,
} from "./control-observability-routes";
import { registerControlOpenApi } from "./control-openapi";
import {
  applyControlHeaders,
  controlError,
  handleControlError,
  requireAdmin,
  type ControlAppEnv,
} from "./control-support";
import { registerTokenRoutes } from "./control-token-routes";

export const controlApp = new OpenAPIHono<ControlAppEnv>();

controlApp.use("*", applyControlHeaders);
registerPublicControlRoutes(controlApp);
registerExecutionReportRoute(controlApp);

for (const path of [
  "/api/v1/auth/logout",
  "/api/v1/auth/sessions",
  "/api/v1/auth/sessions/*",
  "/api/v1/auth/totp/*",
  "/api/v1/auth/password",
  "/api/v1/config",
  "/api/v1/config/*",
  "/api/v1/tokens/execution",
  "/api/v1/tokens/execution/*",
  "/api/v1/audit",
  "/api/v1/audit/*",
  "/api/v1/alerts",
  "/api/v1/backups",
  "/api/v1/backups/*",
]) {
  controlApp.use(path, requireAdmin);
}

registerAuthenticatedControlRoutes(controlApp);
registerConfigurationRoutes(controlApp);
registerTokenRoutes(controlApp);
registerObservabilityRoutes(controlApp);
registerControlOpenApi(controlApp);

controlApp.doc31("/api/v1/openapi.json", {
  info: { title: "one-fetch Control API", version: "0.1.0" },
  openapi: "3.1.0",
});
controlApp.notFound(() =>
  controlError(404, "not_found", "The Control resource was not found"),
);
controlApp.onError((error) => handleControlError(error));
