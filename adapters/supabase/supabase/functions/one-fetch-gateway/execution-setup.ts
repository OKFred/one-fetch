import { ONE_FETCH_LIMITS_V1 } from "@one-fetch/protocol";
import type { HeaderEntryV1 } from "../_shared/protocol-types.ts";
import { classifyFetchOptions } from "@one-fetch/core";
import { z } from "zod";

import { SUPABASE_FETCH_OPTIONS } from "../_shared/capabilities.ts";
import {
  requestContentType,
  targetHeaderEntries,
  targetHeaders,
} from "../_shared/upstream.ts";
import {
  type ActiveConfig,
  type AuditState,
  type GatewayContext,
  milliseconds,
  problem,
  signedError,
} from "./foundation.ts";
import { finalizeRelayError, recordExecution } from "./recording.ts";
import {
  isRecursiveServiceTarget,
  pathAndQuery,
  readRequestBody,
  targetUrl,
  tokenAllows,
} from "./request.ts";

const DeniedExecutionSchema = z
  .object({
    allowed: z.literal(false),
    reason: z.string().min(1).max(128),
  })
  .strict();

const AcquireExecutionResultSchema = z.discriminatedUnion("allowed", [
  z
    .object({
      allowed: z.literal(true),
      leaseId: z.string().uuid(),
    })
    .strict(),
  DeniedExecutionSchema.extend({
    retryAfterSeconds: z.number().int().positive().optional(),
  }).strict(),
]);

const ReconcileExecutionResultSchema = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true) }).strict(),
  DeniedExecutionSchema,
]);

export interface PreparedExecution {
  configuration: NonNullable<ActiveConfig["config"]>;
  currentUrl: URL;
  initialOrigin: string;
  abortController: AbortController;
  didTimeOut: () => boolean;
  timeout: ReturnType<typeof setTimeout>;
  body: Uint8Array;
  headers: Headers;
  policyHeaders: HeaderEntryV1[];
  contentType?: string;
  leaseId: string;
  auditState: AuditState;
}

export async function auditStateAfter(
  context: GatewayContext,
  current: AuditState,
  action: string,
  outcome: "success" | "denied" | "failure" | "partial",
  details: { code?: string; targetUrl?: string } = {},
): Promise<AuditState> {
  try {
    await recordExecution(context, action, outcome, details);
    return current;
  } catch {
    try {
      await context.database.rpc("of_set_audit_degraded");
    } catch {
      // The signed response still reports degradation if storage is unavailable.
    }
    return "degraded";
  }
}

async function rejected(
  context: GatewayContext,
  state: AuditState,
  action: string,
  code: Parameters<typeof problem>[0],
  stage: Parameters<typeof problem>[1],
  message: string,
  options: {
    outcome?: "denied" | "failure" | "partial";
    retryable?: boolean;
    targetUrl?: string;
    leaseId?: string;
  } = {},
): Promise<Response> {
  const error = problem(code, stage, message, options.retryable ?? false);
  if (options.leaseId) {
    const terminal = await finalizeRelayError(
      context,
      options.leaseId,
      error,
      state,
      {
        action,
        auditOutcome: options.outcome ?? "denied",
        ...(options.targetUrl ? { targetUrl: options.targetUrl } : {}),
      },
    );
    return signedError(context, error, terminal.auditState, terminal.reportId);
  }
  const auditState = await auditStateAfter(
    context,
    state,
    action,
    options.outcome ?? "denied",
    { code, ...(options.targetUrl ? { targetUrl: options.targetUrl } : {}) },
  );
  return signedError(context, error, auditState);
}

export async function prepareExecution(
  request: Request,
  context: GatewayContext,
  config: ActiveConfig,
): Promise<Response | PreparedExecution> {
  let auditState: AuditState = config.auditDegraded ? "degraded" : "recorded";
  auditState = await auditStateAfter(
    context,
    auditState,
    "execution.received",
    "success",
  );
  if (context.metadata.transport !== "http" || !context.metadata.targetOrigin) {
    return rejected(
      context,
      auditState,
      "execution.protocol-denied",
      "unsupported_request",
      "protocol",
      "Supabase HTTP Gateway received a non-HTTP transport",
    );
  }
  if (
    !config.initialized ||
    !config.config ||
    config.gatewayPaused ||
    config.config.gatewayPaused
  ) {
    return rejected(
      context,
      auditState,
      "execution.gateway-denied",
      "forbidden",
      "authorization",
      "Gateway is not initialized or is paused",
    );
  }
  const optionAssessment = classifyFetchOptions(
    context.metadata.fetchOptions,
    SUPABASE_FETCH_OPTIONS,
  );
  if (
    !optionAssessment.allowed ||
    context.metadata.fetchOptions.timeoutMs > ONE_FETCH_LIMITS_V1.timeoutMs
  ) {
    return rejected(
      context,
      auditState,
      "execution.option-denied",
      "unsupported_option",
      "protocol",
      "One or more Fetch options are unsupported",
    );
  }
  if (
    optionAssessment.requiresConfirmation &&
    context.metadata.fetchOptions.adapter?.supabaseAcceptMutations !== true
  ) {
    return rejected(
      context,
      auditState,
      "execution.option-denied",
      "unsupported_option",
      "protocol",
      "Translated Fetch options require explicit Supabase mutation confirmation",
    );
  }

  const currentUrl = targetUrl(
    context.metadata.targetOrigin,
    pathAndQuery(request),
  );
  const target = currentUrl.href;
  if (
    context.metadata.hop !== 0 ||
    isRecursiveServiceTarget(currentUrl, [
      context.environment.gatewayBaseUrl,
      context.environment.controlBaseUrl,
    ])
  ) {
    return rejected(
      context,
      auditState,
      "execution.recursion-denied",
      "target_not_allowed",
      "policy",
      "Recursive one-fetch target denied",
      { targetUrl: target },
    );
  }
  if (!tokenAllows(context.principal, context.metadata, currentUrl)) {
    return rejected(
      context,
      auditState,
      "execution.scope-denied",
      "forbidden",
      "authorization",
      "Execution token scope does not allow this target",
      { targetUrl: target },
    );
  }

  let lease: z.infer<typeof AcquireExecutionResultSchema>;
  try {
    lease = AcquireExecutionResultSchema.parse(
      await context.database.rpc<unknown>("of_acquire_execution", {
        p_token_id: context.principal.tokenId,
        p_request_id: context.metadata.requestId,
        p_transport: "http",
        p_request_bytes: 0,
        p_lease_seconds: 120,
      }),
    );
  } catch {
    return rejected(
      context,
      "degraded",
      "execution.storage-failed",
      "storage_unavailable",
      "storage",
      "Execution quota storage is unavailable",
      { outcome: "failure", retryable: true, targetUrl: target },
    );
  }
  if (!lease.allowed) {
    return rejected(
      context,
      auditState,
      "execution.quota-denied",
      "quota_exceeded",
      "quota",
      `Quota denied: ${lease.reason}`,
      { retryable: true, targetUrl: target },
    );
  }

  const abortController = new AbortController();
  let timedOut = false;
  const remaining = Math.max(
    1,
    context.metadata.fetchOptions.timeoutMs - milliseconds(context.startedAt),
  );
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort(
      new DOMException("Request timed out", "TimeoutError"),
    );
  }, remaining);
  const cancel = () =>
    abortController.abort(
      new DOMException("Client cancelled the request", "AbortError"),
    );
  if (request.signal.aborted) cancel();
  else request.signal.addEventListener("abort", cancel, { once: true });

  let body: Uint8Array;
  try {
    body = await readRequestBody(
      request,
      context.metadata,
      abortController.signal,
    );
  } catch (error) {
    clearTimeout(timeout);
    const code = timedOut
      ? "timeout"
      : abortController.signal.aborted
        ? "cancelled"
        : error instanceof RangeError
          ? "payload_too_large"
          : "invalid_metadata";
    return rejected(
      context,
      auditState,
      `execution.${code}`,
      code,
      timedOut ? "timeout" : code === "cancelled" ? "cancellation" : "upload",
      timedOut
        ? "Request upload exceeded its timeout"
        : code === "cancelled"
          ? "The client cancelled the request upload"
          : code === "payload_too_large"
            ? "Request body exceeds 20 MiB"
            : "Request body metadata or stream is invalid",
      {
        outcome: code === "cancelled" ? "partial" : "failure",
        retryable:
          timedOut ||
          (!(error instanceof TypeError) && !(error instanceof RangeError)),
        targetUrl: target,
        leaseId: lease.leaseId,
      },
    );
  }

  let reconciled: z.infer<typeof ReconcileExecutionResultSchema>;
  try {
    reconciled = ReconcileExecutionResultSchema.parse(
      await context.database.rpc<unknown>("of_reconcile_execution_request", {
        p_lease_id: lease.leaseId,
        p_request_bytes: body.byteLength,
      }),
    );
  } catch {
    clearTimeout(timeout);
    return rejected(
      context,
      "degraded",
      "execution.storage-failed",
      "storage_unavailable",
      "storage",
      "Execution quota storage is unavailable",
      {
        outcome: "failure",
        retryable: true,
        targetUrl: target,
        leaseId: lease.leaseId,
      },
    );
  }
  if (!reconciled.allowed) {
    clearTimeout(timeout);
    return rejected(
      context,
      auditState,
      "execution.quota-denied",
      "quota_exceeded",
      "quota",
      `Quota denied: ${reconciled.reason}`,
      { retryable: true, targetUrl: target, leaseId: lease.leaseId },
    );
  }
  if (["GET", "HEAD"].includes(request.method) && body.byteLength > 0) {
    clearTimeout(timeout);
    return rejected(
      context,
      auditState,
      "execution.protocol-denied",
      "unsupported_request",
      "protocol",
      `${request.method} requests cannot contain a body`,
      { targetUrl: target, leaseId: lease.leaseId },
    );
  }

  let policyHeaders: HeaderEntryV1[];
  let headers: Headers;
  let contentType: string | undefined;
  try {
    policyHeaders = targetHeaderEntries(
      context.metadata.targetHeaders,
      context.metadata,
    );
    contentType = requestContentType(policyHeaders, context.metadata);
    headers = targetHeaders(context.metadata.targetHeaders, context.metadata);
  } catch {
    clearTimeout(timeout);
    return rejected(
      context,
      auditState,
      "execution.header-denied",
      "unsupported_header",
      "protocol",
      "One or more target headers cannot be represented safely",
      { targetUrl: target, leaseId: lease.leaseId },
    );
  }
  auditState = await auditStateAfter(
    context,
    auditState,
    "execution.accepted",
    "success",
    { targetUrl: target },
  );
  return {
    configuration: config.config,
    currentUrl,
    initialOrigin: currentUrl.origin,
    abortController,
    didTimeOut: () => timedOut,
    timeout,
    body,
    headers,
    policyHeaders,
    ...(contentType ? { contentType } : {}),
    leaseId: lease.leaseId,
    auditState,
  };
}
