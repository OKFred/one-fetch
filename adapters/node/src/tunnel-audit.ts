import type { OneFetchRequestMetaV1 } from "@one-fetch/protocol";

import type { ExecutionCredential } from "./auth.js";
import type { StoredConfiguration } from "./configuration.js";
import type { GatewayDependencies } from "./gateway.js";

export const auditTunnelAccepted = async (
  dependencies: GatewayDependencies,
  metadata: OneFetchRequestMetaV1,
  credential: ExecutionCredential,
  configuration: StoredConfiguration,
  pathAndQuery: string,
): Promise<"recorded" | "degraded"> => {
  try {
    const target = metadata.targetOrigin
      ? new URL(pathAndQuery, metadata.targetOrigin)
      : undefined;
    await dependencies.audit.append({
      action: "tunnel.accepted",
      actor: {
        actorId: credential.id,
        credentialId: credential.id,
        type: "execution-token",
      },
      category: "execution",
      correlation: {
        configVersion: configuration.version,
        requestId: metadata.requestId,
      },
      outcome: "success",
      request: {
        ...(target
          ? {
              method: "GET",
              origin: target.origin,
              path: target.pathname,
              query: [...target.searchParams.entries()],
            }
          : {}),
        transport: metadata.transport,
      },
      severity: "info",
    });
    return "recorded";
  } catch (error) {
    console.error("Tunnel audit write degraded", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return "degraded";
  }
};

export const auditTunnelClosed = async (
  dependencies: GatewayDependencies,
  metadata: OneFetchRequestMetaV1,
  credential: ExecutionCredential,
  startedAt: number,
  bytesUp: number,
  bytesDown: number,
  reason: string,
): Promise<void> => {
  try {
    await dependencies.audit.append({
      action: "tunnel.closed",
      actor: {
        actorId: credential.id,
        credentialId: credential.id,
        type: "execution-token",
      },
      category: "execution",
      correlation: { requestId: metadata.requestId },
      metrics: {
        durationMs: Date.now() - startedAt,
        requestBytes: bytesUp,
        responseBytes: bytesDown,
      },
      outcome: reason === "completed" ? "success" : "partial",
      result: { source: "target", stage: reason },
      severity: reason === "completed" ? "info" : "warning",
    });
  } catch (error) {
    console.error("Tunnel completion audit degraded", {
      message: error instanceof Error ? error.message : "unknown",
    });
  }
};
