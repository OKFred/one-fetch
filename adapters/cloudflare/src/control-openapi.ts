import { z } from "@hono/zod-openapi";
import {
  AlertsResponseV1Schema,
  AuditPageV1Schema,
  BackupsResponseV1Schema,
  BootstrapRequestV1Schema,
  BootstrapStatusV1Schema,
  ChangePasswordRequestV1Schema,
  ChangePasswordResponseV1Schema,
  ControlErrorV1Schema,
  ControlFeatureStatusListV1Schema,
  ControlFeatureStatusV1Schema,
  CreateExecutionTokenRequestV1Schema,
  CreatedExecutionTokenV1Schema,
  ExecutionReportV1Schema,
  ExecutionTokenListV1Schema,
  ExecutionTokenRevokeResponseV1Schema,
  HealthResponseV1Schema,
  LoginRequestV1Schema,
  LogoutResponseV1Schema,
  RefreshRequestV1Schema,
  SessionListV1Schema,
  SessionRevokeResponseV1Schema,
  SessionTokenPairV1Schema,
  SetGatewayPausedRequestV1Schema,
  TotpEnableRequestV1Schema,
  TotpEnableResponseV1Schema,
  TotpPrepareResponseV1Schema,
} from "@one-fetch/protocol";

import type { ControlApp } from "./control-support";

const RuntimeConfigurationDocumentationSchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: z.string(),
    controlGatewayPairId: z.string(),
    revision: z.number().int().nonnegative(),
    version: z.string(),
    updatedAt: z.iso.datetime(),
    gatewayPaused: z.boolean(),
    policy: z.object({}).passthrough(),
  })
  .strict();
const UpdatePolicyDocumentationSchema = z
  .object({ schemaVersion: z.literal(1), policy: z.object({}).passthrough() })
  .strict();
// The runtime route validates the full capability contract. JsonValue inside the
// shared schema is recursive, which zod-to-openapi 9 cannot currently convert.
const CapabilitiesDocumentationSchema = z.any();
const pathParameters = (name: string) =>
  z.object({
    [name]: z
      .string()
      .min(1)
      .max(128)
      .openapi({ param: { name, in: "path" } }),
  });

const jsonResponse = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const jsonBody = (schema: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema } },
});
const protectedErrors = {
  400: jsonResponse(ControlErrorV1Schema, "Invalid request"),
  401: jsonResponse(ControlErrorV1Schema, "Unauthorized"),
};

export function registerControlOpenApi(app: ControlApp): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "adminBearer", {
    type: "http",
    scheme: "bearer",
    description: "Opaque administrator access token",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "executionBearer", {
    type: "http",
    scheme: "bearer",
    description: "Opaque execution token scoped to its own report",
  });
  const register = app.openAPIRegistry.registerPath.bind(app.openAPIRegistry);

  register({
    method: "get",
    path: "/api/v1/health",
    responses: {
      200: jsonResponse(HealthResponseV1Schema, "Control health"),
    },
  });
  register({
    method: "get",
    path: "/api/v1/capabilities",
    responses: {
      200: jsonResponse(
        CapabilitiesDocumentationSchema,
        "Adapter capabilities",
      ),
    },
  });
  register({
    method: "get",
    path: "/api/v1/openapi.json",
    responses: {
      200: jsonResponse(z.any(), "This OpenAPI 3.1 document"),
    },
  });
  register({
    method: "get",
    path: "/api/v1/bootstrap",
    responses: {
      200: jsonResponse(BootstrapStatusV1Schema, "Bootstrap status"),
    },
  });
  register({
    method: "post",
    path: "/api/v1/bootstrap",
    request: { body: jsonBody(BootstrapRequestV1Schema) },
    responses: {
      200: jsonResponse(
        SessionTokenPairV1Schema,
        "Initial administrator session",
      ),
      401: jsonResponse(ControlErrorV1Schema, "Invalid bootstrap secret"),
      409: jsonResponse(ControlErrorV1Schema, "Already initialized"),
    },
  });
  register({
    method: "post",
    path: "/api/v1/auth/login",
    request: { body: jsonBody(LoginRequestV1Schema) },
    responses: {
      200: jsonResponse(SessionTokenPairV1Schema, "Administrator session"),
      ...protectedErrors,
      423: jsonResponse(ControlErrorV1Schema, "Account locked"),
      428: jsonResponse(ControlErrorV1Schema, "Second factor required"),
    },
  });
  register({
    method: "post",
    path: "/api/v1/auth/refresh",
    request: { body: jsonBody(RefreshRequestV1Schema) },
    responses: {
      200: jsonResponse(SessionTokenPairV1Schema, "Rotated session"),
      401: protectedErrors[401],
    },
  });

  registerProtectedAuthPaths(register);
  registerManagementPaths(register);
}

type RegisterPath = ControlApp["openAPIRegistry"]["registerPath"];

function registerProtectedAuthPaths(register: RegisterPath): void {
  register({
    method: "post",
    path: "/api/v1/auth/logout",
    security: [{ adminBearer: [] }],
    responses: {
      200: jsonResponse(LogoutResponseV1Schema, "Revoked current session"),
      401: protectedErrors[401],
    },
  });
  register({
    method: "get",
    path: "/api/v1/auth/sessions",
    security: [{ adminBearer: [] }],
    responses: {
      200: jsonResponse(SessionListV1Schema, "Administrator sessions"),
      401: protectedErrors[401],
    },
  });
  register({
    method: "delete",
    path: "/api/v1/auth/sessions/{sessionId}",
    security: [{ adminBearer: [] }],
    request: { params: pathParameters("sessionId") },
    responses: {
      200: jsonResponse(SessionRevokeResponseV1Schema, "Revoked session"),
      401: protectedErrors[401],
      404: jsonResponse(ControlErrorV1Schema, "Session not found"),
    },
  });
  register({
    method: "post",
    path: "/api/v1/auth/totp/prepare",
    security: [{ adminBearer: [] }],
    responses: {
      200: jsonResponse(TotpPrepareResponseV1Schema, "TOTP preparation"),
      401: protectedErrors[401],
    },
  });
  register({
    method: "post",
    path: "/api/v1/auth/totp/enable",
    security: [{ adminBearer: [] }],
    request: { body: jsonBody(TotpEnableRequestV1Schema) },
    responses: {
      200: jsonResponse(TotpEnableResponseV1Schema, "TOTP enabled"),
      ...protectedErrors,
    },
  });
  register({
    method: "post",
    path: "/api/v1/auth/password",
    security: [{ adminBearer: [] }],
    request: { body: jsonBody(ChangePasswordRequestV1Schema) },
    responses: {
      200: jsonResponse(ChangePasswordResponseV1Schema, "Password changed"),
      ...protectedErrors,
    },
  });
}

function registerManagementPaths(register: RegisterPath): void {
  register({
    method: "get",
    path: "/api/v1/config",
    security: [{ adminBearer: [] }],
    responses: {
      200: jsonResponse(
        RuntimeConfigurationDocumentationSchema,
        "Runtime configuration",
      ),
      401: protectedErrors[401],
    },
  });
  register({
    method: "put",
    path: "/api/v1/config/policy",
    security: [{ adminBearer: [] }],
    request: { body: jsonBody(UpdatePolicyDocumentationSchema) },
    responses: configurationMutationResponses(),
  });
  register({
    method: "get",
    path: "/api/v1/config/policy",
    security: [{ adminBearer: [] }],
    responses: {
      200: jsonResponse(z.any(), "System policy"),
      401: protectedErrors[401],
    },
  });
  register({
    method: "put",
    path: "/api/v1/config/gateway-paused",
    security: [{ adminBearer: [] }],
    request: { body: jsonBody(SetGatewayPausedRequestV1Schema) },
    responses: configurationMutationResponses(),
  });
  register({
    method: "get",
    path: "/api/v1/tokens/execution",
    security: [{ adminBearer: [] }],
    responses: {
      200: jsonResponse(ExecutionTokenListV1Schema, "Execution tokens"),
      401: protectedErrors[401],
    },
  });
  register({
    method: "post",
    path: "/api/v1/tokens/execution",
    security: [{ adminBearer: [] }],
    request: { body: jsonBody(CreateExecutionTokenRequestV1Schema) },
    responses: {
      201: jsonResponse(
        CreatedExecutionTokenV1Schema,
        "Created execution token",
      ),
      ...protectedErrors,
    },
  });
  register({
    method: "delete",
    path: "/api/v1/tokens/execution/{tokenId}",
    security: [{ adminBearer: [] }],
    request: { params: pathParameters("tokenId") },
    responses: {
      200: jsonResponse(ExecutionTokenRevokeResponseV1Schema, "Revoked token"),
      401: protectedErrors[401],
      404: jsonResponse(ControlErrorV1Schema, "Token not found"),
    },
  });
  registerReadPaths(register);
}

function registerReadPaths(register: RegisterPath): void {
  for (const [path, schema, description] of [
    ["/api/v1/audit", AuditPageV1Schema, "Audit events"],
    ["/api/v1/alerts", AlertsResponseV1Schema, "Alert state"],
    ["/api/v1/backups", BackupsResponseV1Schema, "Backup state"],
  ] as const) {
    register({
      method: "get",
      path,
      security: [{ adminBearer: [] }],
      responses: {
        200: jsonResponse(schema, description),
        401: protectedErrors[401],
      },
    });
  }
  register({
    method: "get",
    path: "/api/v1/features",
    responses: {
      200: jsonResponse(ControlFeatureStatusListV1Schema, "Feature states"),
    },
  });
  register({
    method: "get",
    path: "/api/v1/features/{feature}",
    request: { params: pathParameters("feature") },
    responses: {
      200: jsonResponse(ControlFeatureStatusV1Schema, "Feature state"),
      404: jsonResponse(ControlErrorV1Schema, "Feature not found"),
    },
  });
  register({
    method: "get",
    path: "/api/v1/reports/{reportId}",
    security: [{ executionBearer: [] }],
    request: { params: pathParameters("reportId") },
    responses: {
      200: jsonResponse(ExecutionReportV1Schema, "Owned execution report"),
      401: protectedErrors[401],
      404: jsonResponse(ControlErrorV1Schema, "Report not found"),
    },
  });
}

function configurationMutationResponses() {
  return {
    200: jsonResponse(
      RuntimeConfigurationDocumentationSchema,
      "Updated configuration",
    ),
    400: protectedErrors[400],
    401: protectedErrors[401],
    409: jsonResponse(ControlErrorV1Schema, "Configuration conflict"),
    428: jsonResponse(ControlErrorV1Schema, "If-Match required"),
  };
}
