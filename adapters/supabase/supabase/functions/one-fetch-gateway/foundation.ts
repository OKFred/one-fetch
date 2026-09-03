import {
  ONE_FETCH_RESPONSE_HEADER,
  encodeResponseMetadata,
  type OneFetchProblemV1,
  type OneFetchRequestMetaV1,
  type OneFetchTimingV1,
  type OneFetchUnsignedResponseMetaV1,
} from "@one-fetch/protocol";
import { createSignedResponseMetadata } from "@one-fetch/core";

import type { ExecutionPrincipal } from "../_shared/auth.ts";
import { SUPABASE_HEADER_MUTATIONS } from "../_shared/capabilities.ts";
import type { Database } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { json } from "../_shared/http.ts";

export interface ActiveConfig {
  initialized: boolean;
  gatewayPaused?: boolean;
  version?: string;
  config?: {
    gatewayPaused: boolean;
    policy: unknown;
    bodyInspectionBytes: number;
  };
}

export interface GatewayContext {
  environment: SupabaseEnvironment;
  database: Database;
  token: string;
  principal: ExecutionPrincipal;
  metadata: OneFetchRequestMetaV1;
  configVersion: string;
  startedAt: number;
  requestMethod: string;
  targetPathAndQuery: string;
}

export type AuditState = "recorded" | "degraded";

export function milliseconds(since: number): number {
  return Math.max(0, performance.now() - since);
}

function baseTiming(startedAt: number): OneFetchTimingV1 {
  return {
    phases: [
      {
        name: "total",
        state: "measured",
        source: "gateway",
        durationMs: milliseconds(startedAt),
      },
    ],
    serverTiming: [],
  };
}

export function problem(
  code: OneFetchProblemV1["code"],
  stage: OneFetchProblemV1["stage"],
  message: string,
  retryable = false,
): OneFetchProblemV1 {
  return { code, origin: "one-fetch", stage, message, retryable };
}

function problemStatus(code: OneFetchProblemV1["code"]): number {
  if (code === "unauthorized") return 401;
  if (
    code === "forbidden" ||
    code === "target_not_allowed" ||
    code === "user_rule_denied"
  )
    return 403;
  if (
    code === "payload_too_large" ||
    code === "response_too_large" ||
    code === "metadata_too_large" ||
    code === "response_metadata_too_large"
  )
    return 413;
  if (code === "quota_exceeded") return 429;
  if (code === "timeout") return 504;
  if (code === "upstream_network") return 502;
  if (code === "storage_unavailable" || code === "audit_degraded") return 503;
  if (code === "internal") return 500;
  return 400;
}

export async function signedError(
  context: GatewayContext,
  error: OneFetchProblemV1,
  auditState: "recorded" | "degraded" | "unknown" = "unknown",
): Promise<Response> {
  const unsigned: OneFetchUnsignedResponseMetaV1 = {
    protocolVersion: 1,
    requestId: context.metadata.requestId,
    nonce: context.metadata.nonce,
    outcome: "relay-error",
    error,
    timing: baseTiming(context.startedAt),
    configVersionUsed: context.configVersion,
    mutations: SUPABASE_HEADER_MUTATIONS,
    audit: { state: auditState },
  };
  const encoded = encodeResponseMetadata(
    await createSignedResponseMetadata(unsigned, context.token),
  );
  return json(error, {
    status: problemStatus(error.code),
    headers: { [ONE_FETCH_RESPONSE_HEADER]: encoded },
  });
}
