import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  BootstrapRequestV1Schema,
  BootstrapStatusV1Schema,
  ChangePasswordRequestV1Schema,
  ChangePasswordResponseV1Schema,
  ControlErrorV1Schema,
  LoginRequestV1Schema,
  LogoutResponseV1Schema,
  RefreshRequestV1Schema,
  SessionListV1Schema,
  SessionRevokeResponseV1Schema,
  SessionTokenPairV1Schema,
  TotpEnableRequestV1Schema,
} from "@one-fetch/protocol";

import {
  authorizeAdmin,
  bearer,
  controlError,
  type ControlDependencies,
  jsonBody,
  jsonResponse,
} from "./control-support.js";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);

const authFailureResponses = {
  401: jsonResponse(ControlErrorV1Schema, "Authentication failed"),
  501: jsonResponse(ControlErrorV1Schema, "Feature unsupported"),
};

const requireAdmin = async (
  dependencies: ControlDependencies,
  authorization: string | undefined,
) => authorizeAdmin(dependencies, authorization);

export const registerControlAuthRoutes = (
  app: OpenAPIHono,
  dependencies: ControlDependencies,
): void => {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/bootstrap",
      responses: {
        200: jsonResponse(BootstrapStatusV1Schema, "Bootstrap status"),
      },
    }),
    async (context) => {
      const row = await dependencies.database.get(
        "SELECT id FROM administrators LIMIT 1",
      );
      return context.json(
        {
          initialized: Boolean(row),
          instanceId: dependencies.config.instanceId,
          schemaVersion: 1 as const,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/bootstrap",
      request: { body: jsonBody(BootstrapRequestV1Schema) },
      responses: {
        200: jsonResponse(SessionTokenPairV1Schema, "Issued session"),
        401: authFailureResponses[401],
      },
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
          controlError("bootstrap_failed", "Bootstrap failed"),
          401,
        );
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/auth/login",
      request: { body: jsonBody(LoginRequestV1Schema) },
      responses: {
        200: jsonResponse(SessionTokenPairV1Schema, "Issued session"),
        ...authFailureResponses,
      },
    }),
    async (context) => {
      const body = context.req.valid("json");
      if (body.totpCode || body.recoveryCode) {
        return context.json(
          controlError(
            "totp_unsupported",
            "TOTP and recovery-code login are not available in the Node Preview",
          ),
          501,
        );
      }
      try {
        return context.json(
          await dependencies.auth.login(
            body.username,
            body.password,
            body.deviceFingerprint,
          ),
          200,
        );
      } catch {
        return context.json(
          controlError("invalid_credentials", "Invalid credentials"),
          401,
        );
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/auth/refresh",
      request: { body: jsonBody(RefreshRequestV1Schema) },
      responses: {
        200: jsonResponse(SessionTokenPairV1Schema, "Rotated session"),
        401: authFailureResponses[401],
      },
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
          controlError("refresh_failed", "Refresh failed"),
          401,
        );
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/auth/logout",
      responses: {
        200: jsonResponse(LogoutResponseV1Schema, "Revoked session"),
        401: authFailureResponses[401],
      },
    }),
    async (context) => {
      const raw = bearer(context.req.header("Authorization"));
      const result = raw ? await dependencies.auth.logout(raw) : undefined;
      return result
        ? context.json(result, 200)
        : context.json(controlError("unauthorized", "Unauthorized"), 401);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/auth/sessions",
      responses: {
        200: jsonResponse(SessionListV1Schema, "Administrator sessions"),
        401: authFailureResponses[401],
      },
    }),
    async (context) => {
      const admin = await requireAdmin(
        dependencies,
        context.req.header("Authorization"),
      );
      return admin
        ? context.json(
            await dependencies.auth.listSessions(
              admin.administratorId,
              admin.sessionId,
            ),
            200,
          )
        : context.json(controlError("unauthorized", "Unauthorized"), 401);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/api/v1/auth/sessions/{sessionId}",
      request: { params: z.object({ sessionId: identifier }) },
      responses: {
        200: jsonResponse(SessionRevokeResponseV1Schema, "Revoked session"),
        401: authFailureResponses[401],
        404: jsonResponse(ControlErrorV1Schema, "Session not found"),
      },
    }),
    async (context) => {
      const admin = await requireAdmin(
        dependencies,
        context.req.header("Authorization"),
      );
      if (!admin)
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      const result = await dependencies.auth.revokeSession(
        admin.administratorId,
        context.req.valid("param").sessionId,
      );
      return result
        ? context.json(result, 200)
        : context.json(controlError("not_found", "Session not found"), 404);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/auth/totp/prepare",
      responses: {
        401: authFailureResponses[401],
        501: authFailureResponses[501],
      },
    }),
    async (context) => {
      if (
        !(await requireAdmin(dependencies, context.req.header("Authorization")))
      ) {
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      }
      return context.json(
        controlError(
          "totp_unsupported",
          "TOTP enrollment is not available in the Node Preview",
        ),
        501,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/auth/totp/enable",
      request: { body: jsonBody(TotpEnableRequestV1Schema) },
      responses: {
        401: authFailureResponses[401],
        501: authFailureResponses[501],
      },
    }),
    async (context) => {
      void context.req.valid("json");
      if (
        !(await requireAdmin(dependencies, context.req.header("Authorization")))
      ) {
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      }
      return context.json(
        controlError(
          "totp_unsupported",
          "TOTP enrollment is not available in the Node Preview",
        ),
        501,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/auth/password",
      request: { body: jsonBody(ChangePasswordRequestV1Schema) },
      responses: {
        200: jsonResponse(ChangePasswordResponseV1Schema, "Password changed"),
        401: authFailureResponses[401],
      },
    }),
    async (context) => {
      const admin = await requireAdmin(
        dependencies,
        context.req.header("Authorization"),
      );
      if (!admin)
        return context.json(controlError("unauthorized", "Unauthorized"), 401);
      const body = context.req.valid("json");
      const result = await dependencies.auth.changePassword(
        admin.administratorId,
        admin.sessionId,
        body.currentPassword,
        body.newPassword,
      );
      return result
        ? context.json(result, 200)
        : context.json(
            controlError("invalid_credentials", "Current password is invalid"),
            401,
          );
    },
  );
};
