import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";

import type {
  ExecutionReportV1,
  OneFetchRequestMetaV1,
} from "@one-fetch/protocol";

import type { ExecutionCredential } from "./auth.js";
import type { BodySpool } from "./body-spool.js";
import type { StoredConfiguration } from "./configuration.js";
import { failure } from "./gateway-error.js";
import type { ResponseContext } from "./gateway-response.js";
import type { GatewayDependencies } from "./gateway.js";
import { parseServerTiming } from "./server-timing.js";
import type { executeUpstream } from "./upstream.js";

export const auditAccepted = async (
  dependencies: GatewayDependencies,
  request: IncomingMessage,
  metadata: OneFetchRequestMetaV1,
  credential: ExecutionCredential,
  configuration: StoredConfiguration,
  body: BodySpool,
): Promise<"recorded" | "degraded"> => {
  try {
    const url = new URL(request.url ?? "/", metadata.targetOrigin);
    await dependencies.audit.append({
      action: "request.accepted",
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
      metrics: { requestBytes: body.sizeBytes },
      outcome: "success",
      request: {
        headers: metadata.targetHeaders,
        method: request.method,
        origin: url.origin,
        path: url.pathname,
        query: [...url.searchParams.entries()],
        transport: "http",
      },
      severity: "info",
    });
    return "recorded";
  } catch (error) {
    console.error("Audit write degraded", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return "degraded";
  }
};

export const streamTarget = async (
  upstream: Awaited<ReturnType<typeof executeUpstream>>,
  response: ServerResponse,
  dependencies: GatewayDependencies,
  context: ResponseContext,
  credential: ExecutionCredential,
  startedAt: number,
): Promise<void> => {
  const hash = createHash("sha256");
  const downloadStarted = performance.now();
  let bytes = 0;
  let outcome: "completed" | "partial" | "cancelled" = "completed";
  try {
    for await (const value of upstream.response as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > dependencies.config.responseBodyLimitBytes) {
        outcome = "partial";
        throw failure(
          "response_too_large",
          "upstream-body",
          "Target response exceeded the configured limit",
          502,
        );
      }
      hash.update(chunk);
      if (!response.write(chunk))
        await new Promise<void>((resolve) => response.once("drain", resolve));
    }
    response.end();
  } catch (error) {
    if (response.destroyed) outcome = "cancelled";
    response.destroy(error instanceof Error ? error : undefined);
  } finally {
    const report: ExecutionReportV1 = {
      auditState: context.auditState,
      bodyComplete: outcome === "completed",
      ...(bytes > 0 ? { bodySha256: hash.digest("hex") } : {}),
      finishedAt: new Date().toISOString(),
      outcome,
      reportId: context.reportId ?? context.metadata.requestId,
      requestId: context.metadata.requestId,
      responseBytes: bytes,
      schemaVersion: 1,
      source: "target",
      status: upstream.status,
      timing: {
        phases: [
          ...upstream.timing,
          {
            durationMs: performance.now() - downloadStarted,
            name: "download",
            source: "gateway",
            state: "measured",
          },
          {
            durationMs: performance.now() - startedAt,
            name: "total",
            source: "gateway",
            state: "measured",
          },
        ],
        serverTiming: parseServerTiming(
          upstream.response.headers["server-timing"],
        ),
      },
    };
    try {
      await dependencies.reports.save(report, credential.id);
      await dependencies.audit.append({
        action: `request.${outcome}`,
        actor: {
          actorId: credential.id,
          credentialId: credential.id,
          type: "execution-token",
        },
        category: "execution",
        correlation: {
          requestId: context.metadata.requestId,
          reportId: context.reportId,
        },
        metrics: {
          durationMs:
            report.timing.phases.find(({ name }) => name === "total")
              ?.durationMs ?? 0,
          responseBytes: bytes,
          redirects: upstream.redirects,
        },
        outcome: outcome === "completed" ? "success" : "partial",
        result: { source: "target", status: upstream.status },
        severity: outcome === "completed" ? "info" : "warning",
      });
    } catch (error) {
      console.error("Final execution recording degraded", {
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }
};
