import { Hono } from "hono";
import { z } from "zod";
import {
  BootstrapStatusV1Schema,
  CreatedExecutionTokenV1Schema,
  ExecutionReportV1Schema,
  ExecutionTokenRecordV1Schema,
  PolicySetV1Schema,
  SessionTokenPairV1Schema,
} from "@one-fetch/protocol";
import { stableStringify } from "@one-fetch/core";

import { createAuditEvent } from "../_shared/audit.ts";
import {
  authenticateExecution,
  hashPassword,
  issueExecutionToken,
  issueTokenPair,
  tokenHash,
  verifyPassword,
} from "../_shared/auth.ts";
import { constantTimeSecretEqual, sha256Hex } from "../_shared/crypto.ts";
import { buildSupabaseCapabilities } from "../_shared/capabilities.ts";
import { createDatabase, DatabaseError } from "../_shared/database.ts";
import { getEnvironment } from "../_shared/env.ts";
import { bearer, uuid } from "../_shared/http.ts";
import {
  adminOrResponse,
  controlError,
  originFingerprint,
  previewUnsupported,
} from "./helpers.ts";
import {
  BootstrapSchema,
  ConfigSchema,
  LoginSchema,
  RefreshSchema,
  TokenSchema,
  configVersion,
  configurationResponse,
  defaultConfig,
  type InstanceState,
  type LoginRecord,
  type StoredConfig,
} from "./model.ts";

export function createControlApp(
  environment = getEnvironment(),
  database = createDatabase(environment),
) {
  const app = new Hono();

  app.get("/api/v1/health", async (context) => {
    const state = await database.rpc<InstanceState>("of_get_instance_state");
    return context.json({
      instanceId: state.instanceId ?? environment.instanceId,
      service: "one-fetch-control",
      status: "ok",
      version: environment.buildVersion,
    });
  });
  app.get("/api/v1/capabilities", async (context) => {
    const state = await database.rpc<InstanceState>("of_get_active_config");
    return context.json(buildSupabaseCapabilities(state, environment), 200, {
      etag: `"${state.configVersion ?? "uninitialized"}"`,
    });
  });
  app.get("/api/v1/bootstrap/status", async (context) => {
    const state = await database.rpc<InstanceState>("of_get_instance_state");
    return context.json(
      BootstrapStatusV1Schema.parse({
        schemaVersion: 1,
        initialized: state.initialized,
        instanceId: state.instanceId ?? environment.instanceId,
      }),
    );
  });
  app.post("/api/v1/bootstrap", async (context) => {
    const input = BootstrapSchema.parse(await context.req.json());
    if (
      !(await constantTimeSecretEqual(
        input.bootstrapSecret,
        environment.bootstrapSecret,
        environment.pepper,
      ))
    ) {
      return controlError(
        "invalid_bootstrap_secret",
        "Bootstrap secret is invalid",
        403,
      );
    }
    const config = defaultConfig();
    const now = new Date();
    const version = configVersion(
      now,
      await sha256Hex(stableStringify(config)),
    );
    const audit = await createAuditEvent(
      {
        category: "account",
        action: "account.bootstrap",
        outcome: "success",
        severity: "warning",
        actor: { type: "anonymous" },
        correlation: { configVersion: version },
        change: {
          afterVersion: version,
          changedFields: ["bootstrap", "admin", "config"],
        },
      },
      environment,
    );
    const result = await database.rpc("of_bootstrap_admin", {
      p_instance_id: environment.instanceId,
      p_username: input.username,
      p_password_hash: await hashPassword(input.password, environment),
      p_config_version: version,
      p_default_config: config,
      p_audit: audit,
    });
    return context.json(result, 201);
  });
  app.post("/api/v1/auth/login", async (context) => {
    const input = LoginSchema.parse(await context.req.json());
    const record = await database.rpc<LoginRecord | null>(
      "of_get_admin_for_login",
      { p_username: input.username },
    );
    const locked =
      record?.lockedUntil &&
      new Date(record.lockedUntil).getTime() > Date.now();
    const valid = await verifyPassword(
      input.password,
      record?.passwordHash,
      environment,
    );
    if (!record || !valid || locked) {
      const audit = await createAuditEvent(
        {
          category: "auth",
          action: locked ? "auth.locked" : "auth.login.failure",
          outcome: "failure",
          severity: record && record.failedLoginCount >= 3 ? "warning" : "info",
          actor: { type: "anonymous" },
          correlation: {},
        },
        environment,
      );
      if (record)
        await database.rpc("of_record_login_failure", {
          p_admin_id: record.adminId,
          p_audit: audit,
        });
      else await database.rpc("of_append_audit", { p_event: audit });
      return controlError("invalid_credentials", "Invalid credentials", 401);
    }
    if (record.totpConfigured)
      return controlError(
        "totp_unsupported",
        "TOTP verification is not enabled in the Preview adapter",
        501,
      );
    const pair = issueTokenPair();
    const familyId = uuid();
    const audit = await createAuditEvent(
      {
        category: "auth",
        action: "auth.login.success",
        outcome: "success",
        severity: "info",
        actor: {
          type: "admin",
          actorId: record.adminId,
          sessionFingerprint: await originFingerprint(
            context.req.raw,
            environment,
          ),
        },
        correlation: {},
      },
      environment,
    );
    const session = await database.rpc<{ sessionId: string; familyId: string }>(
      "of_issue_session",
      {
        p_admin_id: record.adminId,
        p_family_id: familyId,
        p_access_hash: await tokenHash(pair.accessToken, environment),
        p_refresh_hash: await tokenHash(pair.refreshToken, environment),
        p_access_expires_at: pair.accessExpiresAt,
        p_refresh_expires_at: pair.refreshExpiresAt,
        p_device_label: input.deviceFingerprint ?? "",
        p_client_fingerprint: await originFingerprint(
          context.req.raw,
          environment,
        ),
        p_audit: audit,
      },
    );
    return context.json(
      SessionTokenPairV1Schema.parse({
        schemaVersion: 1,
        ...pair,
        sessionId: session.sessionId,
      }),
    );
  });
  app.post("/api/v1/auth/refresh", async (context) => {
    const input = RefreshSchema.parse(await context.req.json());
    const pair = issueTokenPair();
    const successAudit = await createAuditEvent(
      {
        category: "auth",
        action: "auth.refresh",
        outcome: "success",
        severity: "info",
        actor: { type: "admin" },
        correlation: {},
      },
      environment,
    );
    const reuseAudit = await createAuditEvent(
      {
        category: "security",
        action: "auth.refresh.reuse",
        outcome: "denied",
        severity: "critical",
        actor: { type: "anonymous" },
        correlation: {},
      },
      environment,
    );
    const result = await database.rpc<{ status: string; sessionId?: string }>(
      "of_rotate_refresh",
      {
        p_current_hash: await tokenHash(input.refreshToken, environment),
        p_new_access_hash: await tokenHash(pair.accessToken, environment),
        p_new_refresh_hash: await tokenHash(pair.refreshToken, environment),
        p_access_expires_at: pair.accessExpiresAt,
        p_refresh_expires_at: pair.refreshExpiresAt,
        p_audit_success: successAudit,
        p_audit_reuse: reuseAudit,
      },
    );
    if (result.status !== "rotated")
      return controlError(
        result.status === "reuse" ? "refresh_reuse" : "invalid_refresh_token",
        result.status === "reuse"
          ? "Refresh token reuse was detected"
          : "Refresh token is invalid",
        401,
      );
    return context.json(
      SessionTokenPairV1Schema.parse({
        schemaVersion: 1,
        ...pair,
        sessionId: result.sessionId,
      }),
    );
  });
  app.get("/api/v1/config", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const stored = await database.rpc<StoredConfig>("of_get_active_config");
    return context.json(
      configurationResponse(stored, environment.instanceId),
      200,
      { etag: `"${stored.revision ?? 0}"` },
    );
  });
  app.put("/api/v1/config/policy", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const policyInput = PolicySetV1Schema.parse(await context.req.json());
    const stored = await database.rpc<StoredConfig>("of_get_active_config");
    const current = ConfigSchema.parse(stored.config);
    if (policyInput.revision !== current.policy.revision) {
      return controlError(
        "revision_conflict",
        "Policy revision does not match the active revision",
        409,
      );
    }
    const config = ConfigSchema.parse({
      ...current,
      policy: { ...policyInput, revision: current.policy.revision + 1 },
    });
    const now = new Date();
    const version = configVersion(
      now,
      await sha256Hex(stableStringify(config)),
    );
    const audit = await createAuditEvent(
      {
        category: "config",
        action: "config.policy.update",
        outcome: "success",
        severity: "warning",
        actor: { type: "admin", actorId: principal.adminId },
        correlation: { configVersion: version },
        change: {
          ...(stored.version ? { beforeVersion: stored.version } : {}),
          afterVersion: version,
          changedFields: ["policy"],
        },
      },
      environment,
    );
    await database.rpc("of_update_config", {
      p_admin_id: principal.adminId,
      p_expected_revision: stored.revision,
      p_version: version,
      p_config: config,
      p_changed_fields: ["policy"],
      p_audit: audit,
    });
    return context.json(
      configurationResponse(
        {
          ...stored,
          config,
          revision: (stored.revision ?? 0) + 1,
          updatedAt: now.toISOString(),
          version,
        },
        environment.instanceId,
      ),
      200,
      { etag: `"${(stored.revision ?? 0) + 1}"` },
    );
  });
  app.get("/api/v1/tokens/execution", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const records = await database.rpc<unknown[]>("of_list_execution_tokens", {
      p_admin_id: principal.adminId,
    });
    return context.json(z.array(ExecutionTokenRecordV1Schema).parse(records));
  });
  app.post("/api/v1/tokens/execution", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const input = TokenSchema.parse(await context.req.json());
    const token = issueExecutionToken();
    const audit = await createAuditEvent(
      {
        category: "account",
        action: "execution-token.create",
        outcome: "success",
        severity: "warning",
        actor: { type: "admin", actorId: principal.adminId },
        correlation: {},
      },
      environment,
    );
    const credential = ExecutionTokenRecordV1Schema.parse(
      await database.rpc("of_create_execution_token", {
        p_admin_id: principal.adminId,
        p_name: input.name,
        p_token_hash: await tokenHash(token, environment),
        p_scopes: input.scope,
        p_quotas: input.quota,
        p_expires_at: input.expiresAt ?? null,
        p_audit: audit,
      }),
    );
    return context.json(
      CreatedExecutionTokenV1Schema.parse({
        schemaVersion: 1,
        credential,
        token,
      }),
      201,
    );
  });
  app.delete("/api/v1/tokens/execution/:id", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const tokenId = z.string().uuid().parse(context.req.param("id"));
    const audit = await createAuditEvent(
      {
        category: "account",
        action: "execution-token.revoke",
        outcome: "success",
        severity: "warning",
        actor: { type: "admin", actorId: principal.adminId },
        correlation: {},
      },
      environment,
    );
    const revoked = await database.rpc<boolean>("of_revoke_execution_token", {
      p_admin_id: principal.adminId,
      p_token_id: tokenId,
      p_reason: "admin_revoked",
      p_audit: audit,
    });
    return revoked
      ? new Response(null, { status: 204 })
      : controlError("not_found", "Execution token was not found", 404);
  });
  app.get("/api/v1/audit", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const items = await database.rpc<Array<Record<string, unknown>>>(
      "of_list_audit",
      {
        p_before_sequence: context.req.query("before")
          ? Number(context.req.query("before"))
          : null,
        p_limit: context.req.query("limit")
          ? Number(context.req.query("limit"))
          : 100,
        p_category: context.req.query("category") ?? null,
        p_request_id: context.req.query("requestId") ?? null,
      },
    );
    const last = items.at(-1)?.sequence;
    return context.json({
      items,
      ...(typeof last === "number" ? { nextBeforeSequence: last } : {}),
    });
  });
  app.get("/api/v1/reports/:id", async (context) => {
    const token = bearer(context.req.raw);
    const principal = await authenticateExecution(token, database, environment);
    if (!principal) return controlError("unauthorized", "Unauthorized", 401);
    const result = await database.rpc<unknown>("of_get_execution_report", {
      p_report_id: z.string().uuid().parse(context.req.param("id")),
      p_token_id: principal.tokenId,
    });
    return result
      ? context.json(ExecutionReportV1Schema.parse(result))
      : controlError("not_found", "Execution report was not found", 404);
  });

  app.all("/api/v1/alerts", previewUnsupported);
  app.all("/api/v1/alerts/*", previewUnsupported);
  app.all("/api/v1/backups", previewUnsupported);
  app.all("/api/v1/backups/*", previewUnsupported);

  app.notFound(() => controlError("not_found", "Route was not found", 404));
  app.onError((error) => {
    if (error instanceof z.ZodError)
      return controlError(
        "invalid_request",
        `Request validation failed (${error.issues.length} issue(s))`,
        400,
      );
    if (error instanceof DatabaseError) {
      const conflict =
        error.code === "40001" || error.message === "config_revision_conflict";
      return controlError(
        conflict ? "revision_conflict" : "storage_unavailable",
        conflict ? "Configuration revision conflict" : "Storage is unavailable",
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
