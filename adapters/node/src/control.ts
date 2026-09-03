import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { cors } from "hono/cors";

import { createCapabilities } from "./capabilities.js";
import { registerControlAuthRoutes } from "./control-auth-routes.js";
import { registerControlManagementRoutes } from "./control-management-routes.js";
import {
  controlError,
  type ControlDependencies,
  jsonResponse,
} from "./control-support.js";
import {
  CapabilitiesResponseSchema,
  HealthResponseSchema,
} from "./control-schemas.js";

export const createControlApp = (
  dependencies: ControlDependencies,
): OpenAPIHono => {
  const app = new OpenAPIHono();

  app.use("/api/*", async (context, next) => {
    const origin = context.req.header("Origin");
    if (
      origin &&
      dependencies.config.controlAllowedOrigins.length > 0 &&
      !dependencies.config.controlAllowedOrigins.includes(origin)
    ) {
      return context.json(
        controlError("origin_denied", "Control origin is not allowed"),
        403,
      );
    }
    await next();
  });
  app.use(
    "/api/*",
    cors({
      allowHeaders: ["Authorization", "Content-Type", "If-Match"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      credentials: false,
      origin: dependencies.config.controlAllowedOrigins,
    }),
  );
  app.use("/api/*", async (context, next) => {
    await next();
    context.header("Cache-Control", "no-store");
  });

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/health",
      responses: { 200: jsonResponse(HealthResponseSchema, "Control health") },
    }),
    (context) =>
      context.json(
        {
          instanceId: dependencies.config.instanceId,
          service: "one-fetch-control" as const,
          status: "ok" as const,
          version: "0.1.0",
        },
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/capabilities",
      responses: {
        200: jsonResponse(
          CapabilitiesResponseSchema,
          "Current adapter capabilities",
        ),
      },
    }),
    async (context) =>
      context.json(
        createCapabilities(
          dependencies.config,
          await dependencies.configuration.get(),
        ),
        200,
      ),
  );

  registerControlAuthRoutes(app, dependencies);
  registerControlManagementRoutes(app, dependencies);

  app.doc31("/api/v1/openapi.json", {
    info: { title: "one-fetch Control API", version: "0.1.0" },
    openapi: "3.1.0",
  });
  app.onError((error, context) => {
    console.error("Control request failed", { message: error.message });
    return context.json(
      controlError("internal", "Internal control error", true),
      500,
    );
  });
  return app;
};
