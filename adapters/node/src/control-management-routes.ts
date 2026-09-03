import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  AlertsResponseV1Schema,
  AuditPageV1Schema,
  BackupsResponseV1Schema,
  ControlErrorV1Schema,
  ControlFeatureStatusListV1Schema,
  ControlFeatureStatusV1Schema,
  ControlFeatureV1Schema,
  CreateExecutionTokenRequestV1Schema,
  CreatedExecutionTokenV1Schema,
  ExecutionReportV1Schema,
  ExecutionTokenListV1Schema,
  ExecutionTokenRevokeResponseV1Schema,
  SetGatewayPausedRequestV1Schema,
  UpdatePolicyRequestV1Schema,
  type ControlFeatureStatusListV1,
} from "@one-fetch/protocol";

import {
  authorizeAdmin,
  bearer,
  controlError,
  type ControlDependencies,
  expectedConfigurationVersion,
  jsonBody,
  jsonResponse,
  quoteConfigurationVersion,
} from "./control-support.js";
import { OpaqueJsonSchema } from "./control-schemas.js";
import { ExecutionTokenNotFoundError } from "./execution-tokens.js";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const auditQuery = z.object({
  cursor: z.string().min(1).max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).default(100),
});

const featureStatuses = (): ControlFeatureStatusListV1 =>
  ControlFeatureStatusListV1Schema.parse({
    schemaVersion: 1,
    features: [
      {
        schemaVersion: 1,
        feature: "alerts",
        state: "unsupported",
        reason: "Signed Webhook alerts are not available in the Node Preview",
      },
      {
        schemaVersion: 1,
        feature: "backups",
        state: "unsupported",
        reason: "Use the documented SQLite backup runbook during Preview",
      },
      {
        schemaVersion: 1,
        feature: "audit-export",
        state: "unsupported",
        reason: "Signed JSONL export is not available in the Node Preview",
      },
      { schemaVersion: 1, feature: "gateway-pause", state: "supported" },
      { schemaVersion: 1, feature: "sessions", state: "supported" },
      { schemaVersion: 1, feature: "totp", state: "supported" },
      { schemaVersion: 1, feature: "password-change", state: "supported" },
      {
        schemaVersion: 1,
        feature: "webhooks",
        state: "unsupported",
        reason: "Webhook delivery is not available in the Node Preview",
      },
    ],
  });

const requireAdmin = async (
  dependencies: ControlDependencies,
  authorization: string | undefined,
) => authorizeAdmin(dependencies, authorization);

export const registerControlManagementRoutes = (
  app: OpenAPIHono,
  dependencies: ControlDependencies,
): void => {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/config",
      responses: {
        200: jsonResponse(OpaqueJsonSchema, "Configuration"),
        401: jsonResponse(ControlErrorV1Schema, "Unauthorized"),
      },
    }),
    async (context) => {
      if (
        !(await requireAdmin(dependencies, context.req.header("Authorization")))
      ) {
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      }
      const configuration = await dependencies.configuration.get();
      context.header("ETag", quoteConfigurationVersion(configuration));
      return context.json(configuration, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/config/policy",
      responses: {
        200: jsonResponse(OpaqueJsonSchema, "System policy"),
        401: jsonResponse(ControlErrorV1Schema, "Unauthorized"),
      },
    }),
    async (context) => {
      if (
        !(await requireAdmin(dependencies, context.req.header("Authorization")))
      ) {
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      }
      const configuration = await dependencies.configuration.get();
      context.header("ETag", quoteConfigurationVersion(configuration));
      return context.json(configuration.policy, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/api/v1/config/policy",
      request: { body: jsonBody(OpaqueJsonSchema) },
      responses: {
        200: jsonResponse(OpaqueJsonSchema, "Updated configuration"),
        401: jsonResponse(ControlErrorV1Schema, "Unauthorized"),
        409: jsonResponse(ControlErrorV1Schema, "Version conflict"),
        428: jsonResponse(ControlErrorV1Schema, "Precondition required"),
      },
    }),
    async (context) => {
      const admin = await requireAdmin(
        dependencies,
        context.req.header("Authorization"),
      );
      if (!admin)
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      const expected = expectedConfigurationVersion(
        context.req.header("If-Match"),
      );
      if (!expected)
        return context.json(
          controlError("precondition_required", "If-Match is required"),
          428,
        );
      const current = await dependencies.configuration.get();
      const body = UpdatePolicyRequestV1Schema.parse(
        context.req.valid("json") as unknown,
      );
      if (
        expected !== current.version ||
        body.policy.revision !== current.policy.revision
      ) {
        return context.json(
          controlError("version_conflict", "Configuration version changed"),
          409,
        );
      }
      const update = dependencies.configuration.prepareUpdate(
        current,
        body.policy,
      );
      const audit = dependencies.audit.prepare({
        action: "config.policy.update",
        actor: { actorId: admin.administratorId, type: "admin" },
        category: "config",
        change: {
          afterVersion: update.configuration.version,
          beforeVersion: current.version,
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
      context.header("ETag", quoteConfigurationVersion(update.configuration));
      return context.json(update.configuration, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/api/v1/config/gateway-paused",
      request: { body: jsonBody(SetGatewayPausedRequestV1Schema) },
      responses: {
        200: jsonResponse(OpaqueJsonSchema, "Updated configuration"),
        401: jsonResponse(ControlErrorV1Schema, "Unauthorized"),
        409: jsonResponse(ControlErrorV1Schema, "Version conflict"),
        428: jsonResponse(ControlErrorV1Schema, "Precondition required"),
      },
    }),
    async (context) => {
      const admin = await requireAdmin(
        dependencies,
        context.req.header("Authorization"),
      );
      if (!admin)
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      const expected = expectedConfigurationVersion(
        context.req.header("If-Match"),
      );
      if (!expected)
        return context.json(
          controlError("precondition_required", "If-Match is required"),
          428,
        );
      const current = await dependencies.configuration.get();
      if (expected !== current.version)
        return context.json(
          controlError("version_conflict", "Configuration version changed"),
          409,
        );
      const update = dependencies.configuration.prepareGatewayPaused(
        current,
        context.req.valid("json").paused,
      );
      const audit = dependencies.audit.prepare({
        action: "config.gateway.pause",
        actor: { actorId: admin.administratorId, type: "admin" },
        category: "config",
        change: {
          afterVersion: update.configuration.version,
          beforeVersion: current.version,
          changedFields: ["gatewayPaused"],
        },
        correlation: { configVersion: update.configuration.version },
        outcome: "success",
        severity: "warning",
      });
      await dependencies.database.transaction([
        update.operation,
        audit.operation,
      ]);
      context.header("ETag", quoteConfigurationVersion(update.configuration));
      return context.json(update.configuration, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/tokens/execution",
      responses: {
        200: jsonResponse(ExecutionTokenListV1Schema, "Execution tokens"),
        401: jsonResponse(ControlErrorV1Schema, "Unauthorized"),
      },
    }),
    async (context) => {
      if (
        !(await requireAdmin(dependencies, context.req.header("Authorization")))
      ) {
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      }
      return context.json(
        {
          schemaVersion: 1 as const,
          tokens: await dependencies.auth.listExecutionTokens(),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/tokens/execution",
      request: { body: jsonBody(CreateExecutionTokenRequestV1Schema) },
      responses: {
        201: jsonResponse(CreatedExecutionTokenV1Schema, "Execution token"),
        401: jsonResponse(ControlErrorV1Schema, "Unauthorized"),
      },
    }),
    async (context) => {
      const admin = await requireAdmin(
        dependencies,
        context.req.header("Authorization"),
      );
      return admin
        ? context.json(
            await dependencies.auth.createExecutionToken(
              admin.administratorId,
              context.req.valid("json"),
            ),
            201,
          )
        : context.json(controlError("unauthorized", "Unauthorized"), 401);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/api/v1/tokens/execution/{tokenId}",
      request: { params: z.object({ tokenId: identifier }) },
      responses: {
        200: jsonResponse(
          ExecutionTokenRevokeResponseV1Schema,
          "Revoked execution token",
        ),
        401: jsonResponse(ControlErrorV1Schema, "Unauthorized"),
        404: jsonResponse(ControlErrorV1Schema, "Token not found"),
      },
    }),
    async (context) => {
      const admin = await requireAdmin(
        dependencies,
        context.req.header("Authorization"),
      );
      if (!admin)
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      try {
        return context.json(
          await dependencies.auth.revokeExecutionToken(
            admin.administratorId,
            context.req.valid("param").tokenId,
          ),
          200,
        );
      } catch (error) {
        if (error instanceof ExecutionTokenNotFoundError)
          return context.json(
            controlError("not_found", "Execution token not found"),
            404,
          );
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/audit",
      request: { query: auditQuery },
      responses: {
        200: jsonResponse(AuditPageV1Schema, "Audit event page"),
        400: jsonResponse(ControlErrorV1Schema, "Invalid cursor"),
        401: jsonResponse(ControlErrorV1Schema, "Unauthorized"),
      },
    }),
    async (context) => {
      if (
        !(await requireAdmin(dependencies, context.req.header("Authorization")))
      ) {
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      }
      try {
        const query = context.req.valid("query");
        const page = await dependencies.audit.listEvents(
          query.limit,
          query.cursor,
        );
        return context.json({ schemaVersion: 1 as const, ...page }, 200);
      } catch (error) {
        if (error instanceof TypeError)
          return context.json(
            controlError("invalid_cursor", "Audit cursor is invalid"),
            400,
          );
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/features",
      responses: {
        200: jsonResponse(ControlFeatureStatusListV1Schema, "Feature states"),
        401: jsonResponse(ControlErrorV1Schema, "Unauthorized"),
      },
    }),
    async (context) => {
      if (
        !(await requireAdmin(dependencies, context.req.header("Authorization")))
      ) {
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      }
      return context.json(featureStatuses(), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/features/{feature}",
      request: { params: z.object({ feature: ControlFeatureV1Schema }) },
      responses: {
        200: jsonResponse(ControlFeatureStatusV1Schema, "Feature state"),
        401: jsonResponse(ControlErrorV1Schema, "Unauthorized"),
      },
    }),
    async (context) => {
      if (
        !(await requireAdmin(dependencies, context.req.header("Authorization")))
      ) {
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      }
      const feature = context.req.valid("param").feature;
      return context.json(
        featureStatuses().features.find((entry) => entry.feature === feature)!,
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/alerts",
      responses: {
        200: jsonResponse(AlertsResponseV1Schema, "Alert state"),
        401: jsonResponse(ControlErrorV1Schema, "Unauthorized"),
      },
    }),
    async (context) => {
      if (
        !(await requireAdmin(dependencies, context.req.header("Authorization")))
      ) {
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      }
      return context.json(
        {
          feature: "alerts" as const,
          reason: "Signed Webhook alerts are not available in the Node Preview",
          schemaVersion: 1 as const,
          state: "unsupported" as const,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/backups",
      responses: {
        200: jsonResponse(BackupsResponseV1Schema, "Backup state"),
        401: jsonResponse(ControlErrorV1Schema, "Unauthorized"),
      },
    }),
    async (context) => {
      if (
        !(await requireAdmin(dependencies, context.req.header("Authorization")))
      ) {
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      }
      return context.json(
        {
          feature: "backups" as const,
          reason: "Use the documented SQLite backup runbook during Preview",
          schemaVersion: 1 as const,
          state: "unsupported" as const,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/reports/{reportId}",
      request: { params: z.object({ reportId: identifier }) },
      responses: {
        200: jsonResponse(ExecutionReportV1Schema, "Execution report"),
        401: jsonResponse(ControlErrorV1Schema, "Unauthorized"),
        404: jsonResponse(ControlErrorV1Schema, "Report not found"),
      },
    }),
    async (context) => {
      const raw = bearer(context.req.header("Authorization"));
      const execution = raw
        ? await dependencies.auth.authenticateExecution(raw)
        : undefined;
      if (!execution)
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      const report = await dependencies.reports.get(
        context.req.valid("param").reportId,
        execution.id,
      );
      return report
        ? context.json(report, 200)
        : context.json(controlError("not_found", "Report not found"), 404);
    },
  );
};
