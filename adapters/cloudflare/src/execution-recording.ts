import { ExecutionReportV1Schema } from "@one-fetch/protocol";

import { auditInsertWhenExecutionIsUnfinished, buildAuditEvent } from "./audit";
import { ensureInstance, reportJson } from "./storage";
import type { CompletionInput } from "./types";

export async function releaseExecution(
  env: CloudflareControlEnv,
  input: CompletionInput,
): Promise<"recorded" | "degraded"> {
  await env.QUOTA.getByName(input.tokenId).release(
    input.requestId,
    input.responseBytes,
    input.requestBytes,
  );
  const now = new Date();
  const instance = await ensureInstance(env.DB);
  const expiresAt = new Date(
    now.getTime() + parsePositiveInteger(env.REPORT_TTL_SECONDS, 600) * 1_000,
  ).toISOString();
  const initialAuditState = instance.auditDegraded ? "degraded" : "recorded";
  try {
    const audit = await buildAuditEvent({
      signingKey: env.AUDIT_SIGNING_KEY,
      event: {
        occurredAt: now.toISOString(),
        category: "execution",
        action: `execution.${input.outcome}`,
        outcome:
          input.outcome === "target"
            ? "success"
            : input.outcome === "partial"
              ? "partial"
              : "failure",
        severity: input.outcome === "target" ? "info" : "warning",
        actor: { type: "execution-token", credentialId: input.tokenId },
        correlation: {
          requestId: input.requestId,
          reportId: input.reportId,
          configVersion: instance.configVersion,
        },
        result: {
          source:
            input.outcome === "target" || input.outcome === "partial"
              ? "target"
              : "relay",
          ...(input.status ? { status: input.status } : {}),
          ...(input.errorCode ? { code: input.errorCode } : {}),
        },
        metrics: {
          requestBytes: input.requestBytes,
          responseBytes: input.responseBytes,
          durationMs: input.durationMs,
        },
      },
    });
    const report = completionReport(input, now, initialAuditState);
    const results = await env.DB.batch([
      auditInsertWhenExecutionIsUnfinished(
        env.DB,
        audit,
        input.requestId,
        input.tokenId,
        input.reportId,
      ),
      env.DB.prepare(
        `INSERT INTO execution_reports (
           report_id, request_id, token_id, created_at, expires_at,
           report_json, terminal_event_id
         ) SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM audit_events WHERE event_id = ?)
           ON CONFLICT DO NOTHING`,
      ).bind(
        input.reportId,
        input.requestId,
        input.tokenId,
        now.toISOString(),
        expiresAt,
        reportJson(report),
        audit.eventId,
        audit.eventId,
      ),
    ]);
    if (results[0]?.meta.changes === 0) return initialAuditState;
    if (results[1]?.meta.changes !== 1)
      throw new Error("terminal_audit_not_recorded");
    return initialAuditState;
  } catch (error) {
    await markAuditDegraded(env.DB, error);
    await saveDegradedReport(env.DB, input, now, expiresAt);
    return "degraded";
  }
}

async function saveDegradedReport(
  database: D1Database,
  input: CompletionInput,
  finishedAt: Date,
  expiresAt: string,
): Promise<void> {
  try {
    await database
      .prepare(
        `INSERT INTO execution_reports (
           report_id, request_id, token_id, created_at, expires_at,
           report_json, terminal_event_id
         ) VALUES (?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT DO NOTHING`,
      )
      .bind(
        input.reportId,
        input.requestId,
        input.tokenId,
        finishedAt.toISOString(),
        expiresAt,
        reportJson(completionReport(input, finishedAt, "degraded")),
      )
      .run();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "execution.report.degraded-write.failed",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}

async function markAuditDegraded(
  database: D1Database,
  error: unknown,
): Promise<void> {
  console.error(
    JSON.stringify({
      event: "audit.write.failed",
      error: error instanceof Error ? error.message : "unknown",
    }),
  );
  try {
    await database
      .prepare(
        "UPDATE instance_state SET audit_degraded = 1 WHERE singleton = 1",
      )
      .run();
  } catch (markError) {
    console.error(
      JSON.stringify({
        event: "audit.degraded-marker.failed",
        error: markError instanceof Error ? markError.message : "unknown",
      }),
    );
  }
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function completionReport(
  input: CompletionInput,
  finishedAt: Date,
  auditState: "recorded" | "degraded",
) {
  return ExecutionReportV1Schema.parse({
    schemaVersion: 1,
    reportId: input.reportId,
    requestId: input.requestId,
    outcome: reportOutcome(input),
    source:
      input.outcome === "target" || input.outcome === "partial"
        ? "target"
        : "relay",
    ...(input.status === undefined ? {} : { status: input.status }),
    responseBytes: input.responseBytes,
    bodyComplete: input.bodyComplete,
    ...(input.bodySha256 ? { bodySha256: input.bodySha256 } : {}),
    timing: input.timing,
    finishedAt: finishedAt.toISOString(),
    auditState,
  });
}

function reportOutcome(
  input: CompletionInput,
): "completed" | "partial" | "timeout" | "cancelled" | "relay-error" {
  if (input.outcome === "target") return "completed";
  if (input.outcome === "partial") return "partial";
  if (input.outcome === "cancelled") return "cancelled";
  return input.errorCode === "timeout" ? "timeout" : "relay-error";
}
