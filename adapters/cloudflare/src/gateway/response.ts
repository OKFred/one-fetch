import { createSignedResponseMetadata } from "@one-fetch/core";
import {
  encodeResponseMetadata,
  ONE_FETCH_RESPONSE_HEADER,
  type HeaderMutationNoticeV1,
  type OneFetchProblemV1,
  type OneFetchTimingV1,
  type OneFetchUnsignedResponseMetaV1,
} from "@one-fetch/protocol";

import type { AuthorizationResult, CompletionInput } from "../types";
import { GatewayProblem, problem } from "./errors";
import {
  getSetCookie,
  outerResponseHeaders,
  targetHeaderEntries,
} from "./headers";
import { metadataExceedsAdapterLimit } from "./metadata";

export interface TargetResponseInput {
  response: Response;
  token: string;
  requestId: string;
  nonce: string;
  reportId: string;
  auth: AuthorizationResult & {
    allowed: true;
    tokenId: string;
    configVersion: string;
  };
  timing: OneFetchTimingV1;
  mutations: HeaderMutationNoticeV1[];
  maxMetadataBytes: number;
  maxResponseBytes: number;
  requestBytes: number;
  startedAt: number;
  redirects: number;
  complete(input: CompletionInput): Promise<void>;
  ctx: ExecutionContext;
  onFinalize?(): void;
  cancellationReason?(): "timeout" | "cancelled" | undefined;
}

export async function targetResponse(
  input: TargetResponseInput,
): Promise<Response> {
  const targetHeaders = targetHeaderEntries(input.response.headers);
  const setCookie = getSetCookie(input.response.headers);
  const unsigned: OneFetchUnsignedResponseMetaV1 = {
    protocolVersion: 1,
    requestId: input.requestId,
    nonce: input.nonce,
    outcome: "target",
    target: {
      kind: "http",
      status: input.response.status,
      statusText: input.response.statusText,
      headers: targetHeaders,
      setCookie,
      bodyComplete: input.response.body === null,
    },
    timing: input.timing,
    configVersionUsed: input.auth.configVersion,
    mutations: input.mutations,
    audit: {
      state: input.auth.auditState,
      ...(input.auth.auditEventId ? { eventId: input.auth.auditEventId } : {}),
    },
    reportId: input.reportId,
  };
  const encoded = encodeResponseMetadata(
    await createSignedResponseMetadata(unsigned, input.token),
  );
  if (metadataExceedsAdapterLimit(encoded, input.maxMetadataBytes)) {
    await input.response.body?.cancel("response_metadata_too_large");
    throw problem(
      "response_metadata_too_large",
      "upstream-headers",
      "Target response metadata exceeds the configured limit",
      502,
    );
  }

  const headers = outerResponseHeaders(input.response.headers);
  headers.set(ONE_FETCH_RESPONSE_HEADER, encoded);
  headers.set("Cache-Control", "no-store");
  if (!input.response.body) {
    input.ctx.waitUntil(finalize(input, 0, "target"));
    return new Response(null, {
      status: input.response.status,
      statusText: input.response.statusText,
      headers,
    });
  }

  let responseBytes = 0;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      responseBytes += chunk.byteLength;
      if (responseBytes > input.maxResponseBytes) {
        controller.error(
          problem(
            "response_too_large",
            "upstream-body",
            "Target response body exceeds the configured limit",
            502,
          ),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
  const pipeline = input.response.body
    .pipeThrough(limiter)
    .pipeTo(writable)
    .then(async () => finalize(input, responseBytes, "target"))
    .catch(async (error: unknown) => {
      const cancellation = input.cancellationReason?.();
      const outcome = cancellation === "cancelled" ? "cancelled" : "partial";
      await finalize(
        input,
        responseBytes,
        outcome,
        cancellation ??
          (error instanceof GatewayProblem
            ? error.problem.code
            : "upstream_network"),
      );
    });
  input.ctx.waitUntil(pipeline);
  return new Response(readable, {
    status: input.response.status,
    statusText: input.response.statusText,
    headers,
  });
}

export async function relayErrorResponse(input: {
  problem: OneFetchProblemV1;
  status: number;
  token: string;
  requestId: string;
  nonce: string;
  configVersion: string;
  audit: AuthorizationResult["auditState"] | "unknown";
  reportId?: string;
}): Promise<Response> {
  const unsigned: OneFetchUnsignedResponseMetaV1 = {
    protocolVersion: 1,
    requestId: input.requestId,
    nonce: input.nonce,
    outcome: "relay-error",
    error: input.problem,
    timing: { phases: [], serverTiming: [] },
    configVersionUsed: input.configVersion,
    mutations: [],
    audit: { state: input.audit },
    ...(input.reportId ? { reportId: input.reportId } : {}),
  };
  const headers = new Headers({
    "Content-Type": "application/problem+json",
    "Cache-Control": "no-store",
  });
  headers.set(
    ONE_FETCH_RESPONSE_HEADER,
    encodeResponseMetadata(
      await createSignedResponseMetadata(unsigned, input.token),
    ),
  );
  return Response.json(input.problem, { status: input.status, headers });
}

async function finalize(
  input: TargetResponseInput,
  responseBytes: number,
  outcome: CompletionInput["outcome"],
  errorCode?: string,
): Promise<void> {
  try {
    const durationMs = performance.now() - input.startedAt;
    await input.complete({
      tokenId: input.auth.tokenId,
      requestId: input.requestId,
      reportId: input.reportId,
      outcome,
      status: input.response.status,
      requestBytes: input.requestBytes,
      responseBytes,
      durationMs,
      timing: {
        phases: [
          ...input.timing.phases,
          { name: "total", state: "measured", source: "gateway", durationMs },
        ],
        serverTiming: input.timing.serverTiming,
      },
      bodyComplete: outcome === "target",
      ...(errorCode ? { errorCode } : {}),
    });
  } finally {
    input.onFinalize?.();
  }
}
