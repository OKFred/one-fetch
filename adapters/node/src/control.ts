import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";

import {
  CreateExecutionTokenRequestV1Schema,
  CreatedExecutionTokenV1Schema,
  PolicySetV1Schema,
} from "@one-fetch/protocol";

import type { AuditLedger } from "./audit.js";
import type { AuthenticationService } from "./auth.js";
import { createCapabilities } from "./capabilities.js";
import type { NodeAdapterConfig } from "./config.js";
import type { ConfigurationStore } from "./configuration.js";
import {
  AuditListSchema,
  BootstrapRequestSchema,
  CapabilitiesResponseSchema,
  ConfigurationResponseSchema,
  ErrorResponseSchema,
  ExecutionReportSchema,
  HealthResponseSchema,
  LoginRequestSchema,
  PolicyDocumentSchema,
  RefreshRequestSchema,
  SessionResponseSchema,
} from "./control-schemas.js";
import type { DatabaseClient } from "./database.js";
import type { ExecutionReportStore } from "./execution-reports.js";

interface ControlDependencies {
  audit: AuditLedger;
  auth: AuthenticationService;
  config: NodeAdapterConfig;
  configuration: ConfigurationStore;
  database: DatabaseClient;
  reports: ExecutionReportStore;
}

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
  required: true,
});

const jsonResponse = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

const bearer = (value: string | undefined): string | undefined => {
  const match = /^Bearer\s+(.+)$/iu.exec(value ?? "");
  return match?.[1];
};

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
        {
          error: {
            code: "origin_denied",
            message: "Control origin is not allowed",
          },
        },
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

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/bootstrap",
      responses: {
        200: jsonResponse(
          z.object({ required: z.boolean() }).strict(),
          "Bootstrap state",
        ),
      },
    }),
    async (context) => {
      const row = await dependencies.database.get(
        "SELECT id FROM administrators LIMIT 1",
      );
      return context.json({ required: !row }, 200);
    },
  );

  const sessionResponses = {
    200: jsonResponse(SessionResponseSchema, "Issued session"),
    401: jsonResponse(ErrorResponseSchema, "Authentication failed"),
  };

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/bootstrap",
      request: { body: jsonBody(BootstrapRequestSchema) },
      responses: sessionResponses,
    }),
    async (context) => {
      try {
        const body = context.req.valid("json");
        return context.json(
          await dependencies.auth.bootstrap(
            body.bootstrapSecret,
            body.username,
            body.password,
          ),
          200,
        );
      } catch {
        return context.json(
          { error: { code: "bootstrap_failed", message: "Bootstrap failed" } },
          401,
        );
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/auth/login",
      request: { body: jsonBody(LoginRequestSchema) },
      responses: sessionResponses,
    }),
    async (context) => {
      try {
        const body = context.req.valid("json");
        return context.json(
          await dependencies.auth.login(body.username, body.password),
          200,
        );
      } catch {
        return context.json(
          {
            error: {
              code: "invalid_credentials",
              message: "Invalid credentials",
            },
          },
          401,
        );
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/auth/refresh",
      request: { body: jsonBody(RefreshRequestSchema) },
      responses: sessionResponses,
    }),
    async (context) => {
      try {
        return context.json(
          await dependencies.auth.refresh(
            context.req.valid("json").refreshToken,
          ),
          200,
        );
      } catch {
        return context.json(
          { error: { code: "refresh_failed", message: "Refresh failed" } },
          401,
        );
      }
    },
  );

  const authorize = async (
    authorization: string | undefined,
  ): Promise<string | undefined> => {
    const token = bearer(authorization);
    return token ? dependencies.auth.authenticateAdmin(token) : undefined;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/config",
      responses: {
        200: jsonResponse(ConfigurationResponseSchema, "Configuration"),
        401: jsonResponse(ErrorResponseSchema, "Unauthorized"),
      },
    }),
    async (context) => {
      if (!(await authorize(context.req.header("Authorization")))) {
        return context.json(
          { error: { code: "unauthorized", message: "Unauthorized" } },
          401,
        );
      }
      return context.json(await dependencies.configuration.get(), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/api/v1/config/policy",
      request: { body: jsonBody(PolicyDocumentSchema) },
      responses: {
        200: jsonResponse(ConfigurationResponseSchema, "Updated configuration"),
        401: jsonResponse(ErrorResponseSchema, "Unauthorized"),
      },
    }),
    async (context) => {
      const administratorId = await authorize(
        context.req.header("Authorization"),
      );
      if (!administratorId) {
        return context.json(
          { error: { code: "unauthorized", message: "Unauthorized" } },
          401,
        );
      }
      const current = await dependencies.configuration.get();
      const update = dependencies.configuration.prepareUpdate(
        current,
        PolicySetV1Schema.parse(context.req.valid("json")),
      );
      const audit = dependencies.audit.prepare({
        action: "config.policy.update",
        actor: { actorId: administratorId, type: "admin" },
        category: "config",
        change: {
          beforeVersion: current.version,
          afterVersion: update.configuration.version,
          changedFields: ["policy"],
        },
        correlation: { configVersion: update.configuration.version },
        outcome: "success",
        severity: "warning",
      });
      await dependencies.database.transaction([
        update.operation,
        audit.operation,
      ]);
      return context.json(update.configuration, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/tokens/execution",
      request: { body: jsonBody(CreateExecutionTokenRequestV1Schema) },
      responses: {
        200: jsonResponse(
          CreatedExecutionTokenV1Schema,
          "One-time execution token",
        ),
        401: jsonResponse(ErrorResponseSchema, "Unauthorized"),
      },
    }),
    async (context) => {
      const administratorId = await authorize(
        context.req.header("Authorization"),
      );
      if (!administratorId) {
        return context.json(
          { error: { code: "unauthorized", message: "Unauthorized" } },
          401,
        );
      }
      const body = context.req.valid("json");
      return context.json(
        await dependencies.auth.createExecutionToken(administratorId, body),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/audit",
      request: {
        query: z.object({
          before: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().optional(),
        }),
      },
      responses: {
        200: jsonResponse(AuditListSchema, "Audit ledger page"),
        401: jsonResponse(ErrorResponseSchema, "Unauthorized"),
      },
    }),
    async (context) => {
      if (!(await authorize(context.req.header("Authorization")))) {
        return context.json(
          { error: { code: "unauthorized", message: "Unauthorized" } },
          401,
        );
      }
      const query = context.req.valid("query");
      const items = await dependencies.audit.list(query.limit, query.before);
      const sequence = items.at(-1)?.sequence;
      return context.json(
        {
          items,
          ...(typeof sequence === "number"
            ? { nextBeforeSequence: sequence }
            : {}),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/reports/{reportId}",
      request: {
        params: z.object({ reportId: z.string().min(1).max(128) }),
      },
      responses: {
        200: jsonResponse(ExecutionReportSchema, "Final execution report"),
        401: jsonResponse(ErrorResponseSchema, "Unauthorized"),
        404: jsonResponse(ErrorResponseSchema, "Report not found or expired"),
      },
    }),
    async (context) => {
      const raw = bearer(context.req.header("Authorization"));
      if (!raw) {
        return context.json(
          { error: { code: "unauthorized", message: "Unauthorized" } },
          401,
        );
      }
      const administratorId = await dependencies.auth.authenticateAdmin(raw);
      const execution = administratorId
        ? undefined
        : await dependencies.auth.authenticateExecution(raw);
      if (!administratorId && !execution) {
        return context.json(
          { error: { code: "unauthorized", message: "Unauthorized" } },
          401,
        );
      }
      const report = await dependencies.reports.get(
        context.req.valid("param").reportId,
        execution?.id,
      );
      if (!report) {
        return context.json(
          { error: { code: "not_found", message: "Report not found" } },
          404,
        );
      }
      return context.json(report, 200);
    },
  );

  app.doc31("/api/v1/openapi.json", {
    info: { title: "one-fetch Control API", version: "0.1.0" },
    openapi: "3.1.0",
  });
  app.onError((error, context) => {
    console.error("Control request failed", { message: error.message });
    return context.json(
      { error: { code: "internal", message: "Internal control error" } },
      500,
    );
  });
  return app;
};
