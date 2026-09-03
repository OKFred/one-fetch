import type { Hono } from "hono";
import { SessionTokenPairV1Schema } from "@one-fetch/protocol";
import { stableStringify } from "@one-fetch/core";
import { z } from "zod";

import { createAuditEvent } from "../_shared/audit.ts";
import {
  hashPassword,
  issueTokenPair,
  tokenHash,
  verifyPassword,
} from "../_shared/auth.ts";
import { constantTimeSecretEqual, sha256Hex } from "../_shared/crypto.ts";
import { type Database, parseStorageResult } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { readBoundedJson, uuid } from "../_shared/http.ts";
import {
  registerPasswordRoutes,
  registerSessionRoutes,
} from "./account-routes.ts";
import { appendAuthFailure } from "./auth-audit.ts";
import {
  authSourceHash,
  controlError,
  loginThrottleKeys,
  originFingerprint,
} from "./helpers.ts";
import {
  BootstrapSchema,
  configVersion,
  defaultConfig,
  LoginRecordSchema,
  LoginSchema,
  RefreshSchema,
} from "./model.ts";
import { parseRequest } from "./request-validation.ts";

class SessionIssueConflictError extends Error {}

const ThrottleResultSchema = z.object({ allowed: z.boolean() }).strict();
const GuardedSessionSchema = z
  .object({
    sessionId: z.string().uuid(),
    familyId: z.string().uuid(),
  })
  .strict()
  .nullable();
const BootstrapResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("created"),
      sessionId: z.string().uuid(),
    })
    .strict(),
  z.object({ status: z.literal("already_initialized") }).strict(),
]);
const RefreshResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("rotated"),
      adminId: z.string().uuid(),
      sessionId: z.string().uuid(),
      familyId: z.string().uuid(),
    })
    .strict(),
  z
    .object({ status: z.literal("reuse"), familyId: z.string().uuid() })
    .strict(),
  z.object({ status: z.literal("invalid") }).strict(),
]);

interface LoginThrottleKeys {
  sourceHash: string;
  usernameHash: string;
}

async function allowAuthSourceAttempt(
  request: Request,
  purpose: "bootstrap" | "refresh",
  limit: number,
  environment: SupabaseEnvironment,
  database: Database,
): Promise<boolean> {
  const deniedAudit = await createAuditEvent(
    {
      category: "security",
      action: `auth.${purpose}.throttled`,
      outcome: "denied",
      severity: "warning",
      actor: { type: "anonymous" },
      correlation: {},
    },
    environment,
  );
  const result = parseStorageResult(
    "of_begin_auth_source_attempt",
    ThrottleResultSchema,
    await database.rpc<unknown>("of_begin_auth_source_attempt", {
      p_kind: `${purpose}-source`,
      p_source_hash: await authSourceHash(request, purpose, environment),
      p_limit: limit,
      p_denied_audit: deniedAudit,
    }),
  );
  return result.allowed;
}

async function issueSession(
  request: Request,
  adminId: string,
  expectedPasswordHash: string,
  expectedTotpConfigured: boolean,
  deviceFingerprint: string | undefined,
  action: string,
  environment: SupabaseEnvironment,
  database: Database,
  throttleKeys: LoginThrottleKeys,
) {
  const pair = issueTokenPair();
  const audit = await createAuditEvent(
    {
      category: "auth",
      action,
      outcome: "success",
      severity: "info",
      actor: {
        type: "admin",
        actorId: adminId,
        sessionFingerprint: await originFingerprint(request, environment),
      },
      correlation: {},
    },
    environment,
  );
  const session = parseStorageResult(
    "of_issue_session_guarded",
    GuardedSessionSchema,
    await database.rpc<unknown>("of_issue_session_guarded", {
      p_admin_id: adminId,
      p_expected_password_hash: expectedPasswordHash,
      p_expected_totp_configured: expectedTotpConfigured,
      p_family_id: uuid(),
      p_access_hash: await tokenHash(pair.accessToken, environment),
      p_refresh_hash: await tokenHash(pair.refreshToken, environment),
      p_access_expires_at: pair.accessExpiresAt,
      p_refresh_expires_at: pair.refreshExpiresAt,
      p_device_label: deviceFingerprint ?? "",
      p_client_fingerprint: await originFingerprint(request, environment),
      p_username_hash: throttleKeys.usernameHash,
      p_source_hash: throttleKeys.sourceHash,
      p_audit: audit,
    }),
  );
  if (!session) throw new SessionIssueConflictError();
  return SessionTokenPairV1Schema.parse({
    schemaVersion: 1,
    ...pair,
    sessionId: session.sessionId,
  });
}

export function registerAuthRoutes(
  app: Hono,
  environment: SupabaseEnvironment,
  database: Database,
): void {
  app.post("/api/v1/bootstrap", async (context) => {
    const input = parseRequest(
      BootstrapSchema,
      await readBoundedJson(context.req.raw),
    );
    if (
      !(await allowAuthSourceAttempt(
        context.req.raw,
        "bootstrap",
        10,
        environment,
        database,
      ))
    ) {
      return controlError("bootstrap_failed", "Bootstrap failed", 401);
    }
    if (
      !(await constantTimeSecretEqual(
        input.bootstrapSecret,
        environment.bootstrapSecret,
        environment.pepper,
      ))
    ) {
      await appendAuthFailure(
        "account.bootstrap.failure",
        "account",
        "warning",
        environment,
        database,
      );
      return controlError("bootstrap_failed", "Bootstrap failed", 401);
    }
    const config = defaultConfig();
    const now = new Date();
    const version = configVersion(
      now,
      await sha256Hex(stableStringify(config)),
    );
    const pair = issueTokenPair();
    const adminId = uuid();
    const sessionId = uuid();
    const familyId = uuid();
    const clientFingerprint = await originFingerprint(
      context.req.raw,
      environment,
    );
    const [passwordHash, bootstrapAudit, sessionAudit, failureAudit] =
      await Promise.all([
        hashPassword(input.password, environment),
        createAuditEvent(
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
        ),
        createAuditEvent(
          {
            category: "auth",
            action: "auth.bootstrap.session",
            outcome: "success",
            severity: "info",
            actor: {
              type: "admin",
              actorId: adminId,
              sessionFingerprint: clientFingerprint,
            },
            correlation: {},
          },
          environment,
        ),
        createAuditEvent(
          {
            category: "account",
            action: "account.bootstrap.failure",
            outcome: "failure",
            severity: "warning",
            actor: { type: "anonymous" },
            correlation: {},
          },
          environment,
        ),
      ]);
    const result = parseStorageResult(
      "of_bootstrap_admin_session",
      BootstrapResultSchema,
      await database.rpc<unknown>("of_bootstrap_admin_session", {
        p_instance_id: environment.instanceId,
        p_admin_id: adminId,
        p_session_id: sessionId,
        p_username: input.username,
        p_password_hash: passwordHash,
        p_config_version: version,
        p_default_config: config,
        p_family_id: familyId,
        p_access_hash: await tokenHash(pair.accessToken, environment),
        p_refresh_hash: await tokenHash(pair.refreshToken, environment),
        p_access_expires_at: pair.accessExpiresAt,
        p_refresh_expires_at: pair.refreshExpiresAt,
        p_device_label: "",
        p_client_fingerprint: clientFingerprint,
        p_audit_bootstrap: bootstrapAudit,
        p_audit_session: sessionAudit,
        p_audit_already_initialized: failureAudit,
      }),
    );
    if (result.status !== "created") {
      return controlError("bootstrap_failed", "Bootstrap failed", 401);
    }
    return context.json(
      SessionTokenPairV1Schema.parse({
        schemaVersion: 1,
        ...pair,
        sessionId: result.sessionId,
      }),
      200,
    );
  });

  app.post("/api/v1/auth/login", async (context) => {
    const input = parseRequest(
      LoginSchema,
      await readBoundedJson(context.req.raw),
    );
    const throttleKeys = await loginThrottleKeys(
      context.req.raw,
      input.username,
      environment,
    );
    const throttleAudit = await createAuditEvent(
      {
        category: "security",
        action: "auth.login.throttled",
        outcome: "denied",
        severity: "warning",
        actor: { type: "anonymous" },
        correlation: {},
      },
      environment,
    );
    const throttle = parseStorageResult(
      "of_begin_login_attempt",
      ThrottleResultSchema,
      await database.rpc<unknown>("of_begin_login_attempt", {
        p_username_hash: throttleKeys.usernameHash,
        p_source_hash: throttleKeys.sourceHash,
        p_denied_audit: throttleAudit,
      }),
    );
    if (!throttle.allowed) {
      return controlError("invalid_credentials", "Invalid credentials", 401);
    }
    const record = parseStorageResult(
      "of_get_admin_for_login",
      LoginRecordSchema,
      await database.rpc<unknown>("of_get_admin_for_login", {
        p_username: input.username,
      }),
    );
    const locked = record?.lockedUntil !== null &&
      record?.lockedUntil !== undefined &&
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
      if (record) {
        await database.rpc("of_record_login_failure", {
          p_admin_id: record.adminId,
          p_audit: audit,
        });
      } else {
        await database.rpc("of_append_audit", { p_event: audit });
      }
      return controlError("invalid_credentials", "Invalid credentials", 401);
    }
    if (record.totpConfigured) {
      await appendAuthFailure(
        "auth.login.totp-unsupported",
        "auth",
        "warning",
        environment,
        database,
        record.adminId,
      );
      return controlError(
        "totp_unsupported",
        "TOTP verification is not enabled in the Preview adapter",
        501,
      );
    }
    try {
      return context.json(
        await issueSession(
          context.req.raw,
          record.adminId,
          record.passwordHash,
          record.totpConfigured,
          input.deviceFingerprint,
          "auth.login.success",
          environment,
          database,
          throttleKeys,
        ),
      );
    } catch (error) {
      if (error instanceof SessionIssueConflictError) {
        await appendAuthFailure(
          "auth.login.conflict",
          "security",
          "warning",
          environment,
          database,
          record.adminId,
        );
        return controlError("invalid_credentials", "Invalid credentials", 401);
      }
      throw error;
    }
  });

  app.post("/api/v1/auth/refresh", async (context) => {
    const input = parseRequest(
      RefreshSchema,
      await readBoundedJson(context.req.raw),
    );
    if (
      !(await allowAuthSourceAttempt(
        context.req.raw,
        "refresh",
        60,
        environment,
        database,
      ))
    ) {
      return controlError(
        "invalid_refresh_token",
        "Refresh token is invalid",
        401,
      );
    }
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
    const invalidAudit = await createAuditEvent(
      {
        category: "auth",
        action: "auth.refresh.failure",
        outcome: "failure",
        severity: "warning",
        actor: { type: "anonymous" },
        correlation: {},
      },
      environment,
    );
    const result = parseStorageResult(
      "of_rotate_refresh_audited",
      RefreshResultSchema,
      await database.rpc<unknown>("of_rotate_refresh_audited", {
        p_current_hash: await tokenHash(input.refreshToken, environment),
        p_new_access_hash: await tokenHash(pair.accessToken, environment),
        p_new_refresh_hash: await tokenHash(pair.refreshToken, environment),
        p_access_expires_at: pair.accessExpiresAt,
        p_refresh_expires_at: pair.refreshExpiresAt,
        p_audit_success: successAudit,
        p_audit_reuse: reuseAudit,
        p_audit_invalid: invalidAudit,
      }),
    );
    if (result.status !== "rotated") {
      return controlError(
        result.status === "reuse" ? "refresh_reuse" : "invalid_refresh_token",
        result.status === "reuse"
          ? "Refresh token reuse was detected"
          : "Refresh token is invalid",
        401,
      );
    }
    return context.json(
      SessionTokenPairV1Schema.parse({
        schemaVersion: 1,
        ...pair,
        sessionId: result.sessionId,
      }),
    );
  });

  registerSessionRoutes(app, environment, database);
  registerPasswordRoutes(app, environment, database);
}
