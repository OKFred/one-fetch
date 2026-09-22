import {
  createSignedResponseMetadata,
  browserResponseMetadata,
  browserEnvelopeHeaders,
  httpTransportStatus,
} from "@one-fetch/core";
import {
  encodeResponseMetadata,
  ONE_FETCH_RESPONSE_HEADER,
  type HeaderMutationNoticeV1,
  type OneFetchProblemV1,
  type OneFetchTimingV1,
  type OneFetchUnsignedResponseMetaV1,
  type FetchOptionsV1,
} from "@one-fetch/protocol";

import type { AuthorizationResult, CompletionInput } from "../types";
import { GatewayProblem, problem } from "./errors";
import {
  getSetCookie,
  outerResponseHeaders,
  targetHeaderEntries,
} from "./headers";
import { metadataExceedsAdapterLimit } from "./metadata";
import { responseBodyDigest } from "./body-digest";

export interface TargetResponseInput {
  fetchOptions?: Pick<FetchOptionsV1, "adapter">;
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

export function declaredResponseExceedsLimit(
  headers: Headers,
  limit: number,
): boolean {
  const value = headers.get("Content-Length");
  if (value === null || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return false;
  const size = Number(value);
  return Number.isSafeInteger(size) && size > limit;
}

export async function targetResponse(
  input: TargetResponseInput,
): Promise<Response> {
  if (
    declaredResponseExceedsLimit(input.response.headers, input.maxResponseBytes)
  ) {
    await input.response.body?.cancel("response_too_large");
    throw problem(
      "response_too_large",
      "upstream-headers",
      "Target declared a response body larger than the configured limit",
      502,
    );
  }
  const targetHeaders = targetHeaderEntries(input.response.headers);
  const options = input.fetchOptions ?? {};
  const envelope = browserResponseMetadata(options);
  const status = httpTransportStatus(input.response.status, options);
  const statusText = envelope.responseMode ? "OK" : input.response.statusText;
  const setCookie = getSetCookie(input.response.headers);
  const unsigned: OneFetchUnsignedResponseMetaV1 = {
    protocolVersion: 1,
    requestId: input.requestId,
    nonce: input.nonce,
    ...envelope,
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

  const headers = envelope.responseMode
    ? browserEnvelopeHeaders()
    : outerResponseHeaders(input.response.headers);
  headers.set(ONE_FETCH_RESPONSE_HEADER, encoded);
  headers.set("Cache-Control", "no-store");
  const digest = responseBodyDigest();
  if (!input.response.body) {
    input.ctx.waitUntil(
      digest
        .finish()
        .then((hash) => finalize(input, 0, "target", undefined, hash)),
    );
    return new Response(null, {
      status,
      statusText,
      headers,
    });
  }

  let responseBytes = 0;
  let sourceCompleted = false;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
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
      await digest.write(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      sourceCompleted = true;
    },
  });
  const pipeline = input.response.body
    .pipeThrough(limiter)
    .pipeTo(writable)
    .then(() => {
      // workerd can fulfill pipeTo after a downstream cancellation. Only a
      // flushed upstream without cancellation is a complete response body.
      const cancelled = input.cancellationReason?.();
      if (!sourceCompleted || cancelled) {
        throw problem(
          cancelled ?? "upstream_network",
          "upstream-body",
          "Response stream did not complete",
          502,
        );
      }
      return digest.finish();
    })
    .then(
      (hash) => finalize(input, responseBytes, "target", undefined, hash),
      async (error: unknown) => {
        await digest.abort();
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
      },
    );
  input.ctx.waitUntil(pipeline);
  return new Response(readable, {
    status,
    statusText,
    headers,
  });
}

export async function relayErrorResponse(input: {
  fetchOptions?: Pick<FetchOptionsV1, "adapter">;
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
    ...browserResponseMetadata(input.fetchOptions ?? {}),
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
  return Response.json(input.problem, {
    status: httpTransportStatus(input.status, input.fetchOptions ?? {}),
    headers,
  });
}

async function finalize(
  input: TargetResponseInput,
  responseBytes: number,
  outcome: CompletionInput["outcome"],
  errorCode?: string,
  bodySha256?: string,
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
      ...(bodySha256 ? { bodySha256 } : {}),
      ...(errorCode ? { errorCode } : {}),
    });
  } finally {
    input.onFinalize?.();
  }
}
