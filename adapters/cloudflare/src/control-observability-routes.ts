import {
  AlertsResponseV1Schema,
  AuditEventV1Schema,
  AuditPageQueryV1Schema,
  AuditPageV1Schema,
  BackupsResponseV1Schema,
  ControlFeatureStatusListV1Schema,
  ControlFeatureStatusV1Schema,
  ControlFeatureV1Schema,
  ExecutionReportV1Schema,
  type AuditEventV1,
} from "@one-fetch/protocol";

import {
  authStub,
  bearerToken,
  controlError,
  isIdentifier,
  type ControlApp,
  type ControlContext,
} from "./control-support";
import { ensureInstance } from "./storage";

const FEATURE_STATUSES = ControlFeatureStatusListV1Schema.parse({
  schemaVersion: 1,
  features: [
    { schemaVersion: 1, feature: "gateway-pause", state: "supported" },
    { schemaVersion: 1, feature: "sessions", state: "supported" },
    { schemaVersion: 1, feature: "totp", state: "supported" },
    { schemaVersion: 1, feature: "password-change", state: "supported" },
    {
      schemaVersion: 1,
      feature: "alerts",
      state: "degraded",
      reason:
        "Preview returns current built-in safety states but does not retain alert history.",
    },
    {
      schemaVersion: 1,
      feature: "backups",
      state: "unsupported",
      reason:
        "Preview relies on operator-managed D1 export and has no in-app restore transaction.",
    },
    {
      schemaVersion: 1,
      feature: "audit-export",
      state: "unsupported",
      reason: "Signed JSONL audit export is not implemented in Preview.",
    },
    {
      schemaVersion: 1,
      feature: "webhooks",
      state: "unsupported",
      reason: "Signed alert webhook delivery is not implemented in Preview.",
    },
  ],
});

export function registerObservabilityRoutes(app: ControlApp): void {
  app.get("/api/v1/audit", listAudit);
  app.get("/api/v1/features", (context) => context.json(FEATURE_STATUSES));
  app.get("/api/v1/features/:id", (context) => {
    const parsed = ControlFeatureV1Schema.safeParse(context.req.param("id"));
    if (!parsed.success)
      return controlError(404, "not_found", "The feature was not found");
    const status = FEATURE_STATUSES.features.find(
      ({ feature }) => feature === parsed.data,
    );
    return status
      ? context.json(ControlFeatureStatusV1Schema.parse(status))
      : controlError(404, "not_found", "The feature was not found");
  });
  app.get("/api/v1/alerts", listAlerts);
  app.get("/api/v1/backups", (context) =>
    context.json(
      BackupsResponseV1Schema.parse({
        schemaVersion: 1,
        feature: "backups",
        state: "unsupported",
        reason:
          "Preview relies on operator-managed D1 export and has no in-app restore transaction.",
      }),
    ),
  );
  app.get("/api/v1/audit/export", () =>
    controlError(
      501,
      "feature_unsupported",
      "Signed JSONL audit export is not implemented in Preview",
    ),
  );
  app.get("/api/v1/backups/:id", () =>
    controlError(
      501,
      "feature_unsupported",
      "In-app backup restore is not implemented in Preview",
    ),
  );
}

export function registerExecutionReportRoute(app: ControlApp): void {
  app.get("/api/v1/reports/:id", async (context) => {
    const reportId = context.req.param("id");
    if (!isIdentifier(reportId))
      return controlError(
        404,
        "not_found",
        "The execution report was not found",
      );
    const token = bearerToken(context.req.header("Authorization"));
    if (!token)
      return controlError(401, "unauthorized", "Execution token required");
    const principal = await authStub(context.env).verifyExecutionToken(token);
    if (!principal)
      return controlError(
        404,
        "not_found",
        "The execution report was not found",
      );
    const row = await context.env.DB.prepare(
      "SELECT report_json, expires_at FROM execution_reports WHERE report_id = ? AND token_id = ?",
    )
      .bind(reportId, principal.tokenId)
      .first<{ report_json: string; expires_at: string }>();
    if (!row || Date.parse(row.expires_at) <= Date.now())
      return controlError(
        404,
        "not_found",
        "The execution report was not found",
      );
    return context.json(
      ExecutionReportV1Schema.parse(JSON.parse(row.report_json)),
    );
  });
}

async function listAudit(context: ControlContext): Promise<Response> {
  const limitText = context.req.query("limit");
  const query = AuditPageQueryV1Schema.parse({
    ...(context.req.query("cursor") === undefined
      ? {}
      : { cursor: context.req.query("cursor") }),
    ...(limitText === undefined ? {} : { limit: parseLimit(limitText) }),
  });
  const cursor =
    query.cursor === undefined ? undefined : decodeAuditCursor(query.cursor);
  const sql = cursor
    ? `SELECT * FROM audit_events
       WHERE occurred_at < ? OR (occurred_at = ? AND event_id < ?)
       ORDER BY occurred_at DESC, event_id DESC LIMIT ?`
    : `SELECT * FROM audit_events
       ORDER BY occurred_at DESC, event_id DESC LIMIT ?`;
  const statement = context.env.DB.prepare(sql);
  const rows = cursor
    ? await statement
        .bind(
          cursor.occurredAt,
          cursor.occurredAt,
          cursor.eventId,
          query.limit + 1,
        )
        .all<Record<string, unknown>>()
    : await statement.bind(query.limit + 1).all<Record<string, unknown>>();
  const pageRows = rows.results.slice(0, query.limit);
  const last = pageRows.at(-1);
  return context.json(
    AuditPageV1Schema.parse({
      schemaVersion: 1,
      events: pageRows.map(publicAuditEvent),
      ...(rows.results.length <= query.limit || last === undefined
        ? {}
        : {
            nextCursor: encodeAuditCursor({
              occurredAt: String(last.occurred_at),
              eventId: String(last.event_id),
            }),
          }),
    }),
  );
}

async function listAlerts(context: ControlContext): Promise<Response> {
  const cursor = context.req.query("cursor");
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 1_024))
    throw new Error("invalid_cursor");
  const instance = await ensureInstance(context.env.DB);
  const occurredAt = new Date().toISOString();
  const alerts = [];
  if (instance.auditDegraded) {
    alerts.push({
      schemaVersion: 1,
      alertId: "audit_degraded",
      instanceId: instance.instanceId,
      occurredAt,
      severity: "critical",
      type: "audit_degraded",
      summary: "The application audit ledger is degraded.",
      configVersion: instance.configVersion,
    });
  }
  if (instance.gatewayPaused) {
    alerts.push({
      schemaVersion: 1,
      alertId: "gateway_paused",
      instanceId: instance.instanceId,
      occurredAt,
      severity: "warning",
      type: "gateway_paused",
      summary: "The Gateway is paused.",
      configVersion: instance.configVersion,
    });
  }
  return context.json(
    AlertsResponseV1Schema.parse({
      schemaVersion: 1,
      feature: "alerts",
      state: "degraded",
      reason:
        "Preview returns current built-in safety states but does not retain alert history.",
      alerts,
    }),
  );
}

function publicAuditEvent(row: Record<string, unknown>): AuditEventV1 {
  const payload = JSON.parse(String(row.payload_json)) as unknown;
  return AuditEventV1Schema.parse({
    ...(payload as Record<string, unknown>),
    integrity: {
      payloadHash: row.payload_hash,
      signature: row.signature,
      keyId: row.key_id,
    },
  });
}

function parseLimit(value: string): number {
  if (!/^[0-9]+$/u.test(value)) throw new Error("invalid_request");
  return Number(value);
}

interface AuditCursor {
  occurredAt: string;
  eventId: string;
}

function encodeAuditCursor(cursor: AuditCursor): string {
  return btoa(JSON.stringify(cursor))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeAuditCursor(value: string): AuditCursor {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(atob(normalized + padding)) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error();
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(record.occurredAt)) ||
      typeof record.eventId !== "string" ||
      !isIdentifier(record.eventId)
    ) {
      throw new Error();
    }
    return { occurredAt: record.occurredAt, eventId: record.eventId };
  } catch {
    throw new Error("invalid_cursor");
  }
}
