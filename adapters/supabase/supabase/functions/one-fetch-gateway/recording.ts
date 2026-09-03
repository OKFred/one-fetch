import { ExecutionReportV1Schema } from "@one-fetch/protocol";
import { z } from "zod";
import type {
  AuditEventV1,
  OneFetchProblemV1,
  OneFetchTimingV1,
} from "../_shared/protocol-types.ts";

import { createAuditEvent } from "../_shared/audit.ts";
import { DatabaseError } from "../_shared/database.ts";
import { targetUrl } from "./request.ts";
import { type GatewayContext, milliseconds } from "./foundation.ts";

interface ExecutionDetails {
  status?: number;
  code?: string;
  responseBytes?: number;
  durationMs?: number;
  reportId?: string;
  targetUrl?: string;
  source?: "target" | "relay";
}

type ReportOutcome =
  | "completed"
  | "partial"
  | "timeout"
  | "cancelled"
  | "relay-error";

export interface FinalizeOptions {
  leaseId: string;
  reportId?: string;
  targetStatus?: number;
  responseBytes: number;
  outcome: ReportOutcome;
  source: "target" | "relay";
  timing: OneFetchTimingV1;
  downloadMs?: number;
  auditState: "recorded" | "degraded" | "unknown";
  bodySha256?: string;
  problem?: OneFetchProblemV1;
  auditAction?: string;
  auditOutcome?: "success" | "denied" | "failure" | "partial";
  targetUrl?: string;
}

export interface FinalizeResult {
  reportId: string;
  auditState: "recorded" | "degraded";
}

const DatabaseFinalizeResultSchema = z
  .object({
    status: z.enum(["finalized", "already_finalized"]),
    auditState: z.enum(["recorded", "degraded"]),
  })
  .strict();

function retryableFinalizationFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DatabaseError &&
      ["database_transport", "database_timeout"].includes(error.code ?? ""))
  );
}

export async function recordExecution(
  context: GatewayContext,
  action: string,
  outcome: "success" | "denied" | "failure" | "partial",
  details: ExecutionDetails = {},
): Promise<string | undefined> {
  const event = await executionAuditEvent(context, action, outcome, details);
  await context.database.rpc("of_append_audit", { p_event: event });
  return event.eventId;
}

export function executionAuditEvent(
  context: GatewayContext,
  action: string,
  outcome: "success" | "denied" | "failure" | "partial",
  details: ExecutionDetails = {},
): Promise<AuditEventV1> {
  const url = details.targetUrl
    ? new URL(details.targetUrl)
    : targetUrl(
        context.metadata.targetOrigin ?? "https://invalid.example",
        context.targetPathAndQuery,
      );
  return createAuditEvent(
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
        source:
          details.source ?? (details.status === undefined ? "relay" : "target"),
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
}

export async function finalize(
  context: GatewayContext,
  options: FinalizeOptions,
): Promise<FinalizeResult> {
  const reportId = options.reportId ?? crypto.randomUUID();
  const durationMs = milliseconds(context.startedAt);
  let priorAuditDegraded = options.auditState === "degraded";
  let event: AuditEventV1 | undefined;
  try {
    event = await executionAuditEvent(
      context,
      options.auditAction ?? `execution.${options.outcome}`,
      options.auditOutcome ?? reportAuditOutcome(options.outcome),
      {
        ...(options.targetStatus === undefined
          ? {}
          : { status: options.targetStatus }),
        ...(options.problem ? { code: options.problem.code } : {}),
        responseBytes: options.responseBytes,
        durationMs,
        reportId,
        ...(options.targetUrl ? { targetUrl: options.targetUrl } : {}),
        source: options.source,
      },
    );
  } catch {
    priorAuditDegraded = true;
  }

  const report = ExecutionReportV1Schema.parse({
    schemaVersion: 1,
    reportId,
    requestId: context.metadata.requestId,
    outcome: options.outcome,
    source: options.source,
    ...(options.targetStatus === undefined
      ? {}
      : { status: options.targetStatus }),
    bodyComplete: options.outcome === "completed",
    responseBytes: options.responseBytes,
    ...(options.bodySha256 ? { bodySha256: options.bodySha256 } : {}),
    ...(options.problem ? { problem: options.problem } : {}),
    timing: {
      phases: [
        ...options.timing.phases.filter(
          (phase) => phase.name !== "total" && phase.name !== "download",
        ),
        ...(options.downloadMs === undefined
          ? []
          : [
              {
                name: "download" as const,
                state: "measured" as const,
                source: "gateway" as const,
                durationMs: options.downloadMs,
              },
            ]),
        {
          name: "total",
          state: "measured",
          source: "gateway",
          durationMs,
        },
      ],
      serverTiming: options.timing.serverTiming,
    },
    finishedAt: new Date().toISOString(),
    auditState: priorAuditDegraded ? "degraded" : "recorded",
  });
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const parameters = {
    p_lease_id: options.leaseId,
    p_response_bytes: options.responseBytes,
    p_report_id: reportId,
    p_request_id: context.metadata.requestId,
    p_token_id: context.principal.tokenId,
    p_outcome: report.outcome,
    p_report: report,
    p_expires_at: expiresAt,
    p_audit: event ?? null,
    p_prior_audit_degraded: priorAuditDegraded,
  };
  let stored: unknown;
  try {
    stored = await context.database.rpc("of_finalize_execution", parameters);
  } catch (error) {
    if (!retryableFinalizationFailure(error)) throw error;
    stored = await context.database.rpc("of_finalize_execution", parameters);
  }
  const result = DatabaseFinalizeResultSchema.parse(stored);
  return { reportId, auditState: result.auditState };
}

export function finalizeRelayError(
  context: GatewayContext,
  leaseId: string,
  error: OneFetchProblemV1,
  auditState: "recorded" | "degraded" | "unknown",
  options: {
    action: string;
    auditOutcome?: "denied" | "failure" | "partial";
    targetUrl?: string;
    targetStatus?: number;
    responseBytes?: number;
  },
): Promise<FinalizeResult> {
  return finalize(context, {
    leaseId,
    responseBytes: options.responseBytes ?? 0,
    outcome:
      error.code === "timeout"
        ? "timeout"
        : error.code === "cancelled"
          ? "cancelled"
          : "relay-error",
    source: "relay",
    timing: { phases: [], serverTiming: [] },
    auditState,
    problem: error,
    auditAction: options.action,
    auditOutcome: options.auditOutcome ?? "failure",
    ...(options.targetUrl ? { targetUrl: options.targetUrl } : {}),
    ...(options.targetStatus === undefined
      ? {}
      : { targetStatus: options.targetStatus }),
  });
}

function reportAuditOutcome(
  outcome: ReportOutcome,
): "success" | "failure" | "partial" {
  if (outcome === "completed") return "success";
  if (outcome === "partial" || outcome === "cancelled") return "partial";
  return "failure";
}
