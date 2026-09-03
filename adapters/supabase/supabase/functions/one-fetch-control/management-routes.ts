import type { Hono } from "hono";
import {
  AlertsResponseV1Schema,
  AuditEventV1Schema,
  AuditPageQueryV1Schema,
  AuditPageV1Schema,
  BackupsResponseV1Schema,
  ControlFeatureV1Schema,
  CreatedExecutionTokenV1Schema,
  ExecutionReportV1Schema,
  ExecutionTokenListV1Schema,
  ExecutionTokenRecordV1Schema,
  ExecutionTokenRevokeResponseV1Schema,
} from "@one-fetch/protocol";
import { z } from "zod";

import {
  createAuditEvent,
  verifyAuditEvent as verifySignedAuditEvent,
} from "../_shared/audit.ts";
import { issueExecutionToken, tokenHash } from "../_shared/auth.ts";
import { type Database, parseStorageResult } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { readBoundedJson } from "../_shared/http.ts";
import {
  adminOrResponse,
  controlError,
  executionOrResponse,
} from "./helpers.ts";
import { featureStatuses, TokenSchema } from "./model.ts";
import { parseRequest } from "./request-validation.ts";

interface AuditRow {
  sequence: number | string;
  payload: unknown;
  payloadHash: string;
  signature: string;
  keyId: string;
}

function canonicalAuditEvent(row: AuditRow) {
  if (
    !row.payload ||
    typeof row.payload !== "object" ||
    Array.isArray(row.payload)
  ) {
    throw new TypeError("Stored audit payload is invalid");
  }
  return AuditEventV1Schema.parse({
    ...row.payload,
    integrity: {
      payloadHash: row.payloadHash,
      signature: row.signature,
      keyId: row.keyId,
    },
  });
}

async function markAuditIntegrityFailure(
  environment: SupabaseEnvironment,
  database: Database,
): Promise<void> {
  const audit = await createAuditEvent(
    {
      category: "audit",
      action: "audit.integrity.failure",
      outcome: "failure",
      severity: "critical",
      actor: { type: "system" },
      correlation: {},
    },
    environment,
  );
  await database.rpc("of_mark_audit_degraded", { p_audit: audit });
}

function requireAdmin(
  request: Request,
  database: Database,
  environment: SupabaseEnvironment,
) {
  return adminOrResponse(request, database, environment);
}

export function registerManagementRoutes(
  app: Hono,
  environment: SupabaseEnvironment,
  database: Database,
): void {
  registerExecutionTokenRoutes(app, environment, database);
  registerAuditRoutes(app, environment, database);
  registerFeatureRoutes(app, environment, database);
  registerReportRoute(app, environment, database);
}

function registerExecutionTokenRoutes(
  app: Hono,
  environment: SupabaseEnvironment,
  database: Database,
): void {
  app.get("/api/v1/tokens/execution", async (context) => {
    const principal = await requireAdmin(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const records = parseStorageResult(
      "of_list_execution_tokens",
      ExecutionTokenListV1Schema,
      {
        schemaVersion: 1,
        tokens: await database.rpc<unknown[]>("of_list_execution_tokens", {
          p_admin_id: principal.adminId,
        }),
      },
    );
    return context.json(records);
  });

  app.post("/api/v1/tokens/execution", async (context) => {
    const principal = await requireAdmin(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const input = parseRequest(
      TokenSchema,
      await readBoundedJson(context.req.raw),
    );
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
    const credential = parseStorageResult(
      "of_create_execution_token",
      ExecutionTokenRecordV1Schema,
      await database.rpc<unknown>("of_create_execution_token", {
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
    const principal = await requireAdmin(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const id = parseRequest(z.string().uuid(), context.req.param("id"));
    const revokedAt = new Date().toISOString();
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
    const revoked = parseStorageResult(
      "of_revoke_execution_token",
      z.boolean(),
      await database.rpc<unknown>("of_revoke_execution_token", {
        p_admin_id: principal.adminId,
        p_token_id: id,
        p_reason: "admin_revoked",
        p_audit: audit,
      }),
    );
    if (!revoked) {
      const failureAudit = await createAuditEvent(
        {
          category: "account",
          action: "execution-token.revoke.failure",
          outcome: "failure",
          severity: "warning",
          actor: { type: "admin", actorId: principal.adminId },
          correlation: {},
        },
        environment,
      );
      await database.rpc("of_append_audit", { p_event: failureAudit });
    }
    return revoked
      ? context.json(
          ExecutionTokenRevokeResponseV1Schema.parse({
            schemaVersion: 1,
            id,
            revokedAt,
          }),
        )
      : controlError("not_found", "Execution token was not found", 404);
  });
}

function registerAuditRoutes(
  app: Hono,
  environment: SupabaseEnvironment,
  database: Database,
): void {
  app.get("/api/v1/audit", async (context) => {
    const principal = await requireAdmin(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const cursor = context.req.query("cursor");
    if (cursor !== undefined && !/^[1-9][0-9]*$/u.test(cursor)) {
      return controlError("invalid_request", "Audit cursor is invalid", 400);
    }
    const query = parseRequest(AuditPageQueryV1Schema, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(context.req.query("limit") === undefined
        ? {}
        : { limit: Number(context.req.query("limit")) }),
    });
    const rows = await database.rpc<AuditRow[]>("of_list_audit", {
      p_before_sequence: query.cursor ?? null,
      p_limit: query.limit,
      p_category: null,
      p_request_id: null,
    });
    const events: ReturnType<typeof canonicalAuditEvent>[] = [];
    let integrityFailure = false;
    for (const row of rows) {
      try {
        const event = canonicalAuditEvent(row);
        if (!(await verifySignedAuditEvent(event, environment))) {
          integrityFailure = true;
          break;
        }
        events.push(event);
      } catch {
        integrityFailure = true;
        break;
      }
    }
    if (integrityFailure) {
      await markAuditIntegrityFailure(environment, database);
      return controlError(
        "audit_integrity_failure",
        "Audit integrity verification failed",
        503,
      );
    }
    const last = rows.at(-1)?.sequence;
    return context.json(
      AuditPageV1Schema.parse({
        schemaVersion: 1,
        events,
        ...(rows.length === query.limit && last !== undefined
          ? { nextCursor: String(last) }
          : {}),
      }),
    );
  });
}

function registerFeatureRoutes(
  app: Hono,
  environment: SupabaseEnvironment,
  database: Database,
): void {
  app.get("/api/v1/features", (context) => context.json(featureStatuses()));
  app.get("/api/v1/features/:feature", (context) => {
    const feature = parseRequest(
      ControlFeatureV1Schema,
      context.req.param("feature"),
    );
    const status = featureStatuses().features.find(
      (entry) => entry.feature === feature,
    );
    if (!status) throw new TypeError("Feature status is missing");
    return context.json(status);
  });

  app.get("/api/v1/alerts", async (context) => {
    const principal = await requireAdmin(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    return context.json(
      AlertsResponseV1Schema.parse({
        schemaVersion: 1,
        feature: "alerts",
        state: "unsupported",
        reason:
          "Signed Webhook alerts are not available in the Supabase Preview",
      }),
    );
  });
  app.get("/api/v1/backups", async (context) => {
    const principal = await requireAdmin(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    return context.json(
      BackupsResponseV1Schema.parse({
        schemaVersion: 1,
        feature: "backups",
        state: "unsupported",
        reason:
          "Managed backup orchestration is not available in the Supabase Preview",
      }),
    );
  });
}

function registerReportRoute(
  app: Hono,
  environment: SupabaseEnvironment,
  database: Database,
): void {
  app.get("/api/v1/reports/:id", async (context) => {
    const principal = await executionOrResponse(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const result = parseStorageResult(
      "of_get_execution_report",
      ExecutionReportV1Schema.nullable(),
      await database.rpc<unknown>("of_get_execution_report", {
        p_report_id: parseRequest(z.string().uuid(), context.req.param("id")),
        p_token_id: principal.tokenId,
      }),
    );
    return result
      ? context.json(result)
      : controlError("not_found", "Execution report was not found", 404);
  });
}
