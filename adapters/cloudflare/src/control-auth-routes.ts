import {
  BootstrapStatusV1Schema,
  ChangePasswordResponseV1Schema,
  HealthResponseV1Schema,
  SessionListV1Schema,
  SessionRevokeResponseV1Schema,
  SessionTokenPairV1Schema,
  TotpEnableResponseV1Schema,
  TotpPrepareResponseV1Schema,
} from "@one-fetch/protocol";

import {
  bootstrapSchema,
  loginSchema,
  passwordChangeSchema,
  readBoundedJson,
  refreshSchema,
  totpEnableSchema,
} from "./control-schemas";
import {
  authStub,
  controlError,
  isIdentifier,
  quoteEtag,
  type ControlApp,
} from "./control-support";
import { createCapabilities, ensureInstance } from "./storage";

export function registerPublicControlRoutes(app: ControlApp): void {
  app.get("/api/v1/health", async (context) => {
    const instance = await ensureInstance(context.env.DB);
    return context.json(
      HealthResponseV1Schema.parse({
        instanceId: instance.instanceId,
        service: "one-fetch-control",
        status: instance.auditDegraded ? "degraded" : "ok",
        version: context.env.ADAPTER_VERSION,
      }),
    );
  });

  app.get("/api/v1/capabilities", async (context) => {
    const instance = await ensureInstance(context.env.DB);
    context.header("ETag", quoteEtag(instance.configVersion));
    return context.json(
      createCapabilities(instance, context.env.ADAPTER_VERSION),
    );
  });

  app.get("/api/v1/bootstrap", async (context) => {
    const instance = await ensureInstance(context.env.DB);
    return context.json(
      BootstrapStatusV1Schema.parse({
        schemaVersion: 1,
        initialized: instance.initializedAt !== undefined,
        instanceId: instance.instanceId,
      }),
    );
  });

  app.post("/api/v1/bootstrap", async (context) => {
    await ensureInstance(context.env.DB);
    const input = bootstrapSchema.parse(await readBoundedJson(context.req.raw));
    const result = await authStub(context.env).bootstrap({
      bootstrapSecret: input.bootstrapSecret,
      username: input.username,
      password: input.password,
    });
    if (!result.ok) {
      return controlError(
        result.code === "already_initialized" ? 409 : 401,
        result.code,
        result.code === "already_initialized"
          ? "The administrator is already initialized"
          : "The bootstrap secret is invalid",
      );
    }
    return context.json(SessionTokenPairV1Schema.parse(result.value), 201);
  });

  app.post("/api/v1/auth/login", async (context) => {
    const input = loginSchema.parse(await readBoundedJson(context.req.raw));
    const result = await authStub(context.env).login({
      username: input.username,
      password: input.password,
      ...(input.totpCode === undefined ? {} : { totpCode: input.totpCode }),
      ...(input.recoveryCode === undefined
        ? {}
        : { recoveryCode: input.recoveryCode }),
      ...(input.deviceFingerprint === undefined
        ? {}
        : { fingerprint: input.deviceFingerprint }),
    });
    if (result.ok) {
      return context.json(SessionTokenPairV1Schema.parse(result.pair));
    }
    const status =
      result.code === "totp_required"
        ? 428
        : result.code === "account_locked"
          ? 423
          : 401;
    return controlError(status, result.code, result.code.replaceAll("_", " "));
  });

  app.post("/api/v1/auth/refresh", async (context) => {
    const input = refreshSchema.parse(await readBoundedJson(context.req.raw));
    const pair = await authStub(context.env).refresh(input.refreshToken);
    return pair
      ? context.json(SessionTokenPairV1Schema.parse(pair))
      : controlError(
          401,
          "invalid_refresh_token",
          "The refresh token is invalid",
        );
  });
}

export function registerAuthenticatedControlRoutes(app: ControlApp): void {
  app.post("/api/v1/auth/logout", async (context) => {
    const principal = context.get("principal");
    const revokedAt = await authStub(context.env).logout(
      principal.adminId,
      principal.sessionId,
    );
    return revokedAt
      ? context.json(
          SessionRevokeResponseV1Schema.parse({
            schemaVersion: 1,
            sessionId: principal.sessionId,
            revokedAt,
          }),
        )
      : controlError(404, "not_found", "The session was not found");
  });

  app.get("/api/v1/auth/sessions", async (context) => {
    const principal = context.get("principal");
    const sessions = await authStub(context.env).listSessions(
      principal.adminId,
    );
    return context.json(
      SessionListV1Schema.parse({
        schemaVersion: 1,
        sessions: sessions.map((session) => ({
          schemaVersion: 1,
          ...session,
          current: session.id === principal.sessionId,
        })),
      }),
    );
  });

  app.delete("/api/v1/auth/sessions/:id", async (context) => {
    const sessionId = context.req.param("id");
    if (!isIdentifier(sessionId))
      return controlError(404, "not_found", "The session was not found");
    const revokedAt = await authStub(context.env).revokeSession(
      context.get("principal").adminId,
      sessionId,
    );
    return revokedAt
      ? context.json(
          SessionRevokeResponseV1Schema.parse({
            schemaVersion: 1,
            sessionId,
            revokedAt,
          }),
        )
      : controlError(404, "not_found", "The session was not found");
  });

  app.post("/api/v1/auth/totp/prepare", async (context) => {
    const principal = context.get("principal");
    const prepared = await authStub(context.env).prepareTotp(
      principal.adminId,
      principal.username,
    );
    return context.json(
      TotpPrepareResponseV1Schema.parse({ schemaVersion: 1, ...prepared }),
    );
  });

  app.post("/api/v1/auth/totp/enable", async (context) => {
    const input = totpEnableSchema.parse(
      await readBoundedJson(context.req.raw),
    );
    const enabled = await authStub(context.env).enableTotp(
      context.get("principal").adminId,
      input.code,
    );
    return enabled
      ? context.json(
          TotpEnableResponseV1Schema.parse({ schemaVersion: 1, ...enabled }),
        )
      : controlError(400, "invalid_totp", "The TOTP code is invalid");
  });

  app.post("/api/v1/auth/password", async (context) => {
    const input = passwordChangeSchema.parse(
      await readBoundedJson(context.req.raw),
    );
    const changed = await authStub(context.env).changePassword(
      context.get("principal").adminId,
      context.get("principal").sessionId,
      input.currentPassword,
      input.newPassword,
    );
    return changed
      ? context.json(
          ChangePasswordResponseV1Schema.parse({
            schemaVersion: 1,
            ...changed,
          }),
        )
      : controlError(
          401,
          "invalid_credentials",
          "The current password is invalid",
        );
  });
}
