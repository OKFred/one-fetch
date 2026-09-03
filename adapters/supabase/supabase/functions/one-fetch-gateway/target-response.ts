import {
  encodeResponseMetadata,
  ONE_FETCH_LIMITS_V1,
  ONE_FETCH_RESPONSE_HEADER,
} from "@one-fetch/protocol";
import type { OneFetchTimingV1 } from "../_shared/protocol-types.ts";
import {
  createSignedResponseMetadata,
  IncrementalSha256,
} from "@one-fetch/core";

import { SUPABASE_HEADER_MUTATIONS } from "../_shared/capabilities.ts";
import {
  outerResponseHeaders,
  parseServerTiming,
  responseHeaderEntries,
  responseSetCookies,
} from "../_shared/upstream.ts";
import {
  type AuditState,
  type GatewayContext,
  milliseconds,
  problem,
  signedError,
} from "./foundation.ts";
import { finalize, finalizeRelayError } from "./recording.ts";
import { background, monitoredBody } from "./stream.ts";

const EMPTY_BODY_SHA256 = new IncrementalSha256().digestHex();

interface TargetResponseOptions {
  request: Request;
  context: GatewayContext;
  upstream: Response;
  leaseId: string;
  abortController: AbortController;
  didTimeOut: () => boolean;
  timeout: ReturnType<typeof setTimeout>;
  auditState: AuditState;
  ttfbMs: number;
}

export async function createTargetResponse({
  request,
  context,
  upstream,
  leaseId,
  abortController,
  didTimeOut,
  timeout,
  auditState,
  ttfbMs,
}: TargetResponseOptions): Promise<Response> {
  const reportId = crypto.randomUUID();
  const declaredSize = Number(upstream.headers.get("content-length"));
  if (
    Number.isFinite(declaredSize) &&
    declaredSize > ONE_FETCH_LIMITS_V1.responseBodyBytes
  ) {
    clearTimeout(timeout);
    await upstream.body?.cancel();
    const error = problem(
      "response_too_large",
      "upstream-body",
      "Declared response exceeds 20 MiB",
    );
    const terminal = await finalizeRelayError(
      context,
      leaseId,
      error,
      auditState,
      {
        action: "execution.response-too-large",
        ...(upstream.url ? { targetUrl: upstream.url } : {}),
        targetStatus: upstream.status,
      },
    );
    return signedError(context, error, terminal.auditState, terminal.reportId);
  }

  const noBody =
    request.method === "HEAD" ||
    [204, 205, 304].includes(upstream.status) ||
    !upstream.body;
  const target = {
    kind: "http" as const,
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaderEntries(upstream.headers),
    setCookie: responseSetCookies(upstream.headers),
    bodyComplete: noBody,
  };
  const timing: OneFetchTimingV1 = {
    phases: [
      {
        name: "ttfb",
        state: "measured",
        source: "gateway",
        durationMs: ttfbMs,
      },
      {
        name: "dns",
        state: "unavailable",
        source: "vendor",
        detail: "Supabase does not expose DNS timing.",
      },
      {
        name: "connect",
        state: "unavailable",
        source: "vendor",
        detail: "Supabase does not expose connection timing.",
      },
      {
        name: "tls",
        state: "unavailable",
        source: "vendor",
        detail: "Supabase does not expose TLS timing.",
      },
    ],
    serverTiming: parseServerTiming(upstream.headers.get("server-timing")),
  };

  let encoded: string;
  try {
    encoded = encodeResponseMetadata(
      await createSignedResponseMetadata(
        {
          protocolVersion: 1,
          requestId: context.metadata.requestId,
          nonce: context.metadata.nonce,
          outcome: "target",
          target,
          timing,
          configVersionUsed: context.configVersion,
          mutations: SUPABASE_HEADER_MUTATIONS,
          audit: { state: auditState },
          reportId,
        },
        context.token,
      ),
    );
  } catch {
    clearTimeout(timeout);
    await upstream.body?.cancel();
    const error = problem(
      "response_metadata_too_large",
      "upstream-headers",
      "Target response metadata exceeds the protocol limit",
    );
    const terminal = await finalizeRelayError(
      context,
      leaseId,
      error,
      auditState,
      {
        action: "execution.response-metadata-too-large",
        ...(upstream.url ? { targetUrl: upstream.url } : {}),
        targetStatus: upstream.status,
      },
    );
    return signedError(context, error, terminal.auditState, terminal.reportId);
  }

  const responseHeaders = outerResponseHeaders(upstream.headers);
  responseHeaders.set(ONE_FETCH_RESPONSE_HEADER, encoded);
  responseHeaders.set("server-timing", `of_ttfb;dur=${ttfbMs.toFixed(2)}`);
  if (noBody) {
    clearTimeout(timeout);
    background(
      finalize(context, {
        leaseId,
        reportId,
        targetStatus: upstream.status,
        responseBytes: 0,
        outcome: "completed",
        source: "target",
        timing,
        auditState,
        downloadMs: 0,
        bodySha256: EMPTY_BODY_SHA256,
      }),
    );
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  const downloadStarted = performance.now();
  const monitored = monitoredBody(
    upstream.body,
    abortController,
    async (bytes, complete, bodySha256, failure) => {
      clearTimeout(timeout);
      const outcome = complete
        ? "completed"
        : didTimeOut()
          ? "timeout"
          : failure === "response_too_large"
            ? "relay-error"
            : abortController.signal.aborted
              ? "cancelled"
              : "partial";
      const terminalProblem = complete
        ? undefined
        : didTimeOut()
          ? problem("timeout", "timeout", "Response download timed out", true)
          : failure === "response_too_large"
            ? problem(
                "response_too_large",
                "upstream-body",
                "Target response exceeded 20 MiB",
              )
            : failure === "cancelled" || abortController.signal.aborted
              ? problem(
                  "cancelled",
                  "cancellation",
                  "Response download was cancelled",
                )
              : problem(
                  "upstream_network",
                  "upstream-body",
                  "Target response stream ended unexpectedly",
                  true,
                );
      await finalize(context, {
        leaseId,
        reportId,
        targetStatus: upstream.status,
        responseBytes: bytes,
        outcome,
        source: complete || outcome === "partial" ? "target" : "relay",
        timing,
        auditState,
        downloadMs: milliseconds(downloadStarted),
        ...(bodySha256 ? { bodySha256 } : {}),
        ...(terminalProblem ? { problem: terminalProblem } : {}),
      });
    },
  );
  return new Response(monitored, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
