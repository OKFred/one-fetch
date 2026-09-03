import {
  ExecutionReportV1Schema,
  type OneFetchTimingV1,
} from "@one-fetch/protocol";

import { createAuditEvent } from "../_shared/audit.ts";
import { targetUrl } from "./request.ts";
import { milliseconds, type GatewayContext } from "./foundation.ts";

export async function recordExecution(
  context: GatewayContext,
  action: string,
  outcome: "success" | "denied" | "failure" | "partial",
  details: {
    status?: number;
    code?: string;
    responseBytes?: number;
    durationMs?: number;
    reportId?: string;
  } = {},
): Promise<string | undefined> {
  const url = targetUrl(
    context.metadata.targetOrigin ?? "https://invalid.example",
    context.targetPathAndQuery,
  );
  const event = await createAuditEvent(
    {
      category: "execution",
      action,
      outcome,
      severity:
        outcome === "failure"
          ? "error"
          : outcome === "denied"
            ? "warning"
            : "info",
      actor: {
        type: "execution-token",
        actorId: context.principal.tokenId,
        credentialId: context.principal.tokenId,
      },
      correlation: {
        requestId: context.metadata.requestId,
        configVersion: context.configVersion,
        ...(details.reportId ? { reportId: details.reportId } : {}),
      },
      request: {
        transport: context.metadata.transport,
        method: context.requestMethod,
        origin: url.origin,
        path: url.pathname,
        query: Array.from(url.searchParams.entries()),
        headers: context.metadata.targetHeaders,
        ...(context.metadata.body.contentType
          ? { contentType: context.metadata.body.contentType }
          : {}),
      },
      result: {
        source: details.status === undefined ? "relay" : "target",
        ...(details.status === undefined ? {} : { status: details.status }),
        ...(details.code === undefined ? {} : { code: details.code }),
      },
      metrics: {
        ...(context.metadata.body.sizeBytes === undefined
          ? {}
          : { requestBytes: context.metadata.body.sizeBytes }),
        ...(details.responseBytes === undefined
          ? {}
          : { responseBytes: details.responseBytes }),
        ...(details.durationMs === undefined
          ? {}
          : { durationMs: details.durationMs }),
      },
    },
    context.environment,
  );
  await context.database.rpc("of_append_audit", { p_event: event });
  return event.eventId;
}

export async function finalize(
  context: GatewayContext,
  leaseId: string,
  reportId: string,
  targetStatus: number,
  responseBytes: number,
  outcome: "completed" | "partial" | "timeout" | "cancelled" | "relay-error",
  timing: OneFetchTimingV1,
  downloadMs: number,
  auditState: "recorded" | "degraded" | "unknown",
): Promise<void> {
  const durationMs = milliseconds(context.startedAt);
  const report = ExecutionReportV1Schema.parse({
    schemaVersion: 1,
    reportId,
    requestId: context.metadata.requestId,
    outcome,
    source:
      outcome === "completed" || outcome === "partial" ? "target" : "relay",
    status: targetStatus,
    bodyComplete: outcome === "completed",
    responseBytes,
    timing: {
      phases: [
        ...timing.phases.filter(
          (phase) => phase.name !== "total" && phase.name !== "download",
        ),
        {
          name: "download",
          state: "measured",
          source: "gateway",
          durationMs: downloadMs,
        },
        {
          name: "total",
          state: "measured",
          source: "gateway",
          durationMs,
        },
      ],
      serverTiming: timing.serverTiming,
    },
    finishedAt: new Date().toISOString(),
    auditState,
  });
  await Promise.allSettled([
    context.database.rpc("of_release_execution", {
      p_lease_id: leaseId,
      p_response_bytes: responseBytes,
    }),
    context.database.rpc("of_put_execution_report", {
      p_report_id: reportId,
      p_request_id: context.metadata.requestId,
      p_token_id: context.principal.tokenId,
      p_outcome: report.outcome,
      p_report: report,
      p_expires_at: new Date(Date.now() + 600_000).toISOString(),
    }),
    recordExecution(
      context,
      `execution.${outcome}`,
      outcome === "completed"
        ? "success"
        : outcome === "partial" || outcome === "cancelled"
          ? "partial"
          : "failure",
      {
        status: targetStatus,
        responseBytes,
        durationMs,
        reportId,
      },
    ),
  ]);
}
