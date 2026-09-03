import {
  ONE_FETCH_LIMITS_V1,
  ONE_FETCH_RESPONSE_HEADER,
  encodeResponseMetadata,
  type OneFetchTimingV1,
} from "@one-fetch/protocol";
import { createSignedResponseMetadata } from "@one-fetch/core";

import { SUPABASE_HEADER_MUTATIONS } from "../_shared/capabilities.ts";
import {
  outerResponseHeaders,
  parseServerTiming,
  responseHeaderEntries,
  responseSetCookies,
} from "../_shared/upstream.ts";
import {
  milliseconds,
  problem,
  signedError,
  type AuditState,
  type GatewayContext,
} from "./foundation.ts";
import { finalize } from "./recording.ts";
import { background, monitoredBody } from "./stream.ts";

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
  const declaredSize = Number(upstream.headers.get("content-length"));
  if (
    Number.isFinite(declaredSize) &&
    declaredSize > ONE_FETCH_LIMITS_V1.responseBodyBytes
  ) {
    clearTimeout(timeout);
    await upstream.body?.cancel();
    background(
      context.database.rpc("of_release_execution", {
        p_lease_id: leaseId,
        p_response_bytes: 0,
      }),
    );
    return signedError(
      context,
      problem(
        "response_too_large",
        "upstream-body",
        "Declared response exceeds 20 MiB",
      ),
      auditState,
    );
  }

  const reportId = crypto.randomUUID();
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
      {
        name: "total",
        state: "measured",
        source: "gateway",
        durationMs: milliseconds(context.startedAt),
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
    background(
      context.database.rpc("of_release_execution", {
        p_lease_id: leaseId,
        p_response_bytes: 0,
      }),
    );
    return signedError(
      context,
      problem(
        "response_metadata_too_large",
        "upstream-headers",
        "Target response metadata exceeds the protocol limit",
      ),
      auditState,
    );
  }

  const responseHeaders = outerResponseHeaders(upstream.headers);
  responseHeaders.set(ONE_FETCH_RESPONSE_HEADER, encoded);
  responseHeaders.set(
    "server-timing",
    `of_ttfb;dur=${ttfbMs.toFixed(2)}, of_total;dur=${milliseconds(context.startedAt).toFixed(2)}`,
  );
  if (noBody) {
    clearTimeout(timeout);
    background(
      finalize(
        context,
        leaseId,
        reportId,
        upstream.status,
        0,
        "completed",
        timing,
        0,
        auditState,
      ),
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
    async (bytes, complete) => {
      clearTimeout(timeout);
      const outcome = complete
        ? "completed"
        : didTimeOut()
          ? "timeout"
          : abortController.signal.reason === "response_too_large"
            ? "relay-error"
            : abortController.signal.aborted
              ? "cancelled"
              : "partial";
      await finalize(
        context,
        leaseId,
        reportId,
        upstream.status,
        bytes,
        outcome,
        timing,
        milliseconds(downloadStarted),
        auditState,
      );
    },
  );
  return new Response(monitored, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
