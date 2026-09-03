import type { Hono } from "hono";
import {
  ChangePasswordRequestV1Schema,
  ChangePasswordResponseV1Schema,
  SessionListV1Schema,
  SessionRevokeResponseV1Schema,
} from "@one-fetch/protocol";
import { z } from "zod";

import { createAuditEvent } from "../_shared/audit.ts";
import { hashPassword, verifyPassword } from "../_shared/auth.ts";
import { type Database, parseStorageResult } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { readBoundedJson } from "../_shared/http.ts";
import { appendAuthFailure } from "./auth-audit.ts";
import {
  adminOrResponse,
  controlError,
  previewUnsupported,
} from "./helpers.ts";
import { parseRequest } from "./request-validation.ts";

const BooleanResultSchema = z.boolean();
const PasswordRecordSchema = z
  .object({ passwordHash: z.string().min(1).max(512) })
  .strict()
  .nullable();

export function registerSessionRoutes(
  app: Hono,
  environment: SupabaseEnvironment,
  database: Database,
): void {
  app.post("/api/v1/auth/logout", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const revokedAt = new Date().toISOString();
    const audit = await createAuditEvent(
      {
        category: "auth",
        action: "auth.logout",
        outcome: "success",
        severity: "info",
        actor: { type: "admin", actorId: principal.adminId },
        correlation: {},
      },
      environment,
    );
    const revoked = parseStorageResult(
      "of_revoke_session",
      BooleanResultSchema,
      await database.rpc<unknown>("of_revoke_session", {
        p_admin_id: principal.adminId,
        p_session_id: principal.sessionId,
        p_reason: "logout",
        p_audit: audit,
      }),
    );
    if (!revoked) {
      await appendAuthFailure(
        "auth.logout.failure",
        "auth",
        "warning",
        environment,
        database,
        principal.adminId,
      );
    }
    return revoked
      ? context.json(
        SessionRevokeResponseV1Schema.parse({
          schemaVersion: 1,
          sessionId: principal.sessionId,
          revokedAt,
        }),
      )
      : controlError("unauthorized", "Unauthorized", 401);
  });

  app.get("/api/v1/auth/sessions", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const sessions = parseStorageResult(
      "of_list_sessions",
      SessionListV1Schema,
      {
        schemaVersion: 1,
        sessions: await database.rpc<unknown[]>("of_list_sessions", {
          p_admin_id: principal.adminId,
          p_current_session_id: principal.sessionId,
        }),
      },
    );
    return context.json(sessions);
  });

  app.delete("/api/v1/auth/sessions/:id", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const sessionId = parseRequest(z.string().uuid(), context.req.param("id"));
    const revokedAt = new Date().toISOString();
    const audit = await createAuditEvent(
      {
        category: "auth",
        action: "auth.session.revoke",
        outcome: "success",
        severity: "warning",
        actor: { type: "admin", actorId: principal.adminId },
        correlation: {},
      },
      environment,
    );
    const revoked = parseStorageResult(
      "of_revoke_session",
      BooleanResultSchema,
      await database.rpc<unknown>("of_revoke_session", {
        p_admin_id: principal.adminId,
        p_session_id: sessionId,
        p_reason: "admin_revoked",
        p_audit: audit,
      }),
    );
    if (!revoked) {
      await appendAuthFailure(
        "auth.session.revoke.failure",
        "auth",
        "warning",
        environment,
        database,
        principal.adminId,
      );
    }
    return revoked
      ? context.json(
        SessionRevokeResponseV1Schema.parse({
          schemaVersion: 1,
          sessionId,
          revokedAt,
        }),
      )
      : controlError("not_found", "Session was not found", 404);
  });

  app.post("/api/v1/auth/totp/prepare", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    return principal instanceof Response ? principal : previewUnsupported();
  });
  app.post("/api/v1/auth/totp/enable", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    return principal instanceof Response ? principal : previewUnsupported();
  });
}

export function registerPasswordRoutes(
  app: Hono,
  environment: SupabaseEnvironment,
  database: Database,
): void {
  app.post("/api/v1/auth/password", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const input = parseRequest(
      ChangePasswordRequestV1Schema,
      await readBoundedJson(context.req.raw),
    );
    const record = parseStorageResult(
      "of_get_admin_for_password_change",
      PasswordRecordSchema,
      await database.rpc<unknown>("of_get_admin_for_password_change", {
        p_admin_id: principal.adminId,
      }),
    );
    if (
      !record ||
      !(await verifyPassword(
        input.currentPassword,
        record.passwordHash,
        environment,
      ))
    ) {
      await appendAuthFailure(
        "auth.password.change.failure",
        "security",
        "warning",
        environment,
        database,
        principal.adminId,
      );
      return controlError("invalid_credentials", "Invalid credentials", 401);
    }
    const audit = await createAuditEvent(
      {
        category: "security",
        action: "auth.password.change",
        outcome: "success",
        severity: "warning",
        actor: { type: "admin", actorId: principal.adminId },
        correlation: {},
      },
      environment,
    );
    const result = parseStorageResult(
      "of_change_password",
      ChangePasswordResponseV1Schema.nullable(),
      await database.rpc<unknown>("of_change_password", {
        p_admin_id: principal.adminId,
        p_current_session_id: principal.sessionId,
        p_current_password_hash: record.passwordHash,
        p_new_password_hash: await hashPassword(input.newPassword, environment),
        p_audit: audit,
      }),
    );
    if (result === null) {
      await appendAuthFailure(
        "auth.password.change.conflict",
        "security",
        "warning",
        environment,
        database,
        principal.adminId,
      );
      return controlError(
        "version_conflict",
        "Administrator credentials changed concurrently",
        409,
      );
    }
    return context.json(result);
  });
}
