import { classifyFetchOptions } from "@one-fetch/core";
import type { OneFetchRequestMetaV1 } from "@one-fetch/protocol";

import { CLOUDFLARE_FETCH_CAPABILITIES } from "../storage";
import type { CompletionInput, ExecutionDecisionInput } from "../types";
import { problem } from "./errors";
import type { TunnelDependencies } from "./tunnel-dependencies";
import type { WebSocketBridgeResult } from "./websocket";

export function fetchOptionMutations(meta: OneFetchRequestMetaV1) {
  return classifyFetchOptions(meta.fetchOptions, CLOUDFLARE_FETCH_CAPABILITIES)
    .assessments.filter(
      ({ fidelity }) =>
        fidelity === "translated" || fidelity === "vendor-mutated",
    )
    .map(({ option, fidelity, detail }) => ({
      side: "request" as const,
      actor:
        fidelity === "vendor-mutated"
          ? ("vendor" as const)
          : ("adapter" as const),
      operation:
        fidelity === "vendor-mutated"
          ? ("possibly-mutated" as const)
          : ("overwritten" as const),
      name: option,
      detail: detail ?? `Fetch option ${option} is ${fidelity}.`,
    }));
}

export function tunnelCompletion(
  tokenId: string,
  requestId: string,
  reportId: string,
  startedAt: number,
  responseBytes: number,
  outcome: CompletionInput["outcome"],
  status?: number,
  errorCode?: string,
  timing?: CompletionInput["timing"],
): CompletionInput {
  const durationMs = performance.now() - startedAt;
  return {
    tokenId,
    requestId,
    reportId,
    outcome,
    requestBytes: 0,
    responseBytes,
    durationMs,
    timing: timing ?? {
      phases: [
        { name: "total", state: "measured", source: "gateway", durationMs },
      ],
      serverTiming: [],
    },
    bodyComplete: outcome === "target",
    ...(status === undefined ? {} : { status }),
    ...(errorCode ? { errorCode } : {}),
  };
}

export async function finalizeTunnelBridge(
  result: WebSocketBridgeResult,
  dependencies: TunnelDependencies,
  control: CloudflareGatewayEnv["CONTROL"],
  tokenId: string,
  requestId: string,
  reportId: string,
  startedAt: number,
): Promise<void> {
  await dependencies.complete(
    control,
    tunnelCompletion(
      tokenId,
      requestId,
      reportId,
      startedAt,
      result.bytesDown,
      result.failed ? "partial" : "target",
      101,
      result.failed ? (result.reason ?? "upstream_network") : undefined,
    ),
  );
}

export function mapAuthorizationCode(
  value: string | undefined,
): "unauthorized" | "forbidden" | "quota_exceeded" | "storage_unavailable" {
  if (value === "unauthorized") return "unauthorized";
  if (value === "storage_unavailable") return "storage_unavailable";
  if (
    value === "quota_exceeded" ||
    value === "rate_limited" ||
    value === "concurrency_limited"
  )
    return "quota_exceeded";
  return "forbidden";
}

export async function recordTunnelDecisionSafely(
  dependencies: TunnelDependencies,
  control: CloudflareGatewayEnv["CONTROL"],
  input: ExecutionDecisionInput,
): Promise<"recorded" | "degraded"> {
  let result: Awaited<ReturnType<TunnelDependencies["recordDecision"]>>;
  try {
    result = await dependencies.recordDecision(control, input);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "audit.tunnel-decision.rpc.failed",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
    return "degraded";
  }
  if (result === "storage_unavailable") {
    throw problem(
      "storage_unavailable",
      "storage",
      "The Control database migration state is incompatible",
      503,
      true,
    );
  }
  return result;
}
