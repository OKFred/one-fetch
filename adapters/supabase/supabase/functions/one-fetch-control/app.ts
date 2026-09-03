import { Hono } from "hono";

import {
  createDatabase,
  DatabaseError,
  StorageContractError,
} from "../_shared/database.ts";
import { getEnvironment } from "../_shared/env.ts";
import {
  InvalidJsonBodyError,
  JsonBodyTooLargeError,
} from "../_shared/http.ts";
import { registerAuthRoutes } from "./auth-routes.ts";
import { registerConfigurationRoutes } from "./configuration-routes.ts";
import { controlError } from "./helpers.ts";
import { registerManagementRoutes } from "./management-routes.ts";
import { InstanceMismatchError } from "./model.ts";
import { registerPublicRoutes } from "./public-routes.ts";
import { RequestValidationError } from "./request-validation.ts";

export function createControlApp(
  environment = getEnvironment(),
  database = createDatabase(environment),
) {
  const app = new Hono();

  registerPublicRoutes(app, environment, database);
  registerAuthRoutes(app, environment, database);
  registerConfigurationRoutes(app, environment, database);
  registerManagementRoutes(app, environment, database);

  app.notFound(() => controlError("not_found", "Route was not found", 404));
  app.onError((error) => {
    if (error instanceof JsonBodyTooLargeError) {
      return controlError(
        "payload_too_large",
        "Control request body exceeds 1 MiB",
        413,
      );
    }
    if (error instanceof InvalidJsonBodyError) {
      return controlError(
        "invalid_request",
        "Request body is not valid JSON",
        400,
      );
    }
    if (error instanceof RequestValidationError) {
      return controlError("invalid_request", error.message, 400);
    }
    if (error instanceof InstanceMismatchError) {
      return controlError(
        "instance_mismatch",
        "Storage belongs to a different one-fetch instance",
        503,
      );
    }
    if (error instanceof StorageContractError) {
      return controlError(
        "storage_contract_invalid",
        "Storage returned an incompatible result",
        503,
      );
    }
    if (error instanceof DatabaseError) {
      const conflict = error.code === "40001" ||
        error.message.includes("config_revision_conflict");
      return controlError(
        conflict ? "version_conflict" : "storage_unavailable",
        conflict ? "Configuration version changed" : "Storage is unavailable",
        conflict ? 409 : 503,
      );
    }
    console.error(
      "Control request failed",
      error instanceof Error ? error.name : "unknown",
    );
    return controlError("internal", "Internal Control API error", 500);
  });
  return app;
}
