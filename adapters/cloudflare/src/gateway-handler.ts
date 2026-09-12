import {
  classifyFetchOptions,
  randomNonce,
  targetUrlFromPath,
} from "@one-fetch/core";
import {
  decodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_TOKEN_HEADER,
  type OneFetchRequestMetaV1,
} from "@one-fetch/protocol";

import { CLOUDFLARE_FETCH_CAPABILITIES } from "./storage";
import type { AuthorizationResult, ExecutionDecisionInput } from "./types";
import { prepareRequestBody } from "./gateway/body";
import {
  authorizeExecution,
  checkTarget,
  completeExecution,
  recordExecutionDecision,
} from "./gateway/control-client";
import { asGatewayProblem, problem } from "./gateway/errors";
import { buildUpstreamHeaders } from "./gateway/headers";
import { metadataExceedsAdapterLimit } from "./gateway/metadata";
import { evaluatePolicies, validateFetchOptions } from "./gateway/policy";
import { relayErrorResponse, targetResponse } from "./gateway/response";
import { initialTiming, parseServerTiming } from "./gateway/timing";
import { fetchUpstream } from "./gateway/upstream";

export async function handleGatewayRequest(
  request: Request,
  env: CloudflareGatewayEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const startedAt = performance.now();
  const rawMetadata = request.headers.get(ONE_FETCH_REQUEST_HEADER);
  const token = request.headers.get(ONE_FETCH_TOKEN_HEADER) ?? "";
  let requestId: string = crypto.randomUUID();
  let nonce = randomNonce();
  let reportId: string | undefined;
  let authorization: AuthorizationResult | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortReason: "timeout" | "cancelled" | undefined;
  let leaseFinalized = false;
  let accountedRequestBytes = 0;
  const controller = new AbortController();
  const armTimeout = (timeoutMs: number): void => {
    if (timer) clearTimeout(timer);
    const remainingMs = timeoutMs - (performance.now() - startedAt);
    if (remainingMs <= 0) {
      abortReason = "timeout";
      controller.abort("timeout");
      return;
    }
    timer = setTimeout(() => {
      abortReason = "timeout";
      controller.abort("timeout");
    }, remainingMs);
  };
  const cancel = (): void => {
    abortReason = "cancelled";
    controller.abort(request.signal.reason);
  };
  const cleanupExecutionSignal = (): void => {
    if (timer) clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
  };
  if (request.signal.aborted) cancel();
  else request.signal.addEventListener("abort", cancel, { once: true });

  try {
    if (!rawMetadata)
      throw problem(
        "invalid_metadata",
        "protocol",
        `${ONE_FETCH_REQUEST_HEADER} is required`,
        400,
      );
    const metadataLimit = parsePositiveInteger(env.MAX_METADATA_BYTES, 49_152);
    if (metadataExceedsAdapterLimit(rawMetadata, metadataLimit)) {
      throw problem(
        "metadata_too_large",
        "protocol",
        "Request metadata exceeds the adapter limit",
        431,
      );
    }
    const meta = decodeRequestMetadata(rawMetadata);
    armTimeout(meta.fetchOptions.timeoutMs);
    requestId = meta.requestId;
    nonce = meta.nonce;
    reportId = crypto.randomUUID();
    if (meta.hop !== 0)
      throw problem(
        "target_not_allowed",
        "policy",
        "Recursive one-fetch forwarding is denied",
        403,
      );
    if (!token)
      throw problem(
        "unauthorized",
        "authentication",
        `${ONE_FETCH_TOKEN_HEADER} is required`,
        401,
      );
    if (meta.transport !== "http") {
      throw problem(
        "unsupported_request",
        "protocol",
        `Transport ${meta.transport} is not available on the HTTP gateway entrypoint`,
        400,
      );
    }
    if (!meta.targetOrigin)
      throw problem(
        "invalid_metadata",
        "protocol",
        "HTTP requests require targetOrigin",
        400,
      );
    const gatewayUrl = new URL(request.url);
    const pathAndQuery = `${gatewayUrl.pathname}${gatewayUrl.search}`;
    const target = targetUrlFromPath(meta.targetOrigin, pathAndQuery);
    if (target.origin === gatewayUrl.origin)
      throw problem(
        "target_not_allowed",
        "policy",
        "Recursive gateway requests are denied",
        403,
      );
    const declaredBodySize = meta.body.sizeBytes;
    const transportBodySize = contentLength(request);
    const estimatedBodySize = Math.max(
      declaredBodySize ?? 0,
      transportBodySize ?? 0,
    );
    accountedRequestBytes = estimatedBodySize;
    const authStartedAt = performance.now();
    authorization = await authorizeExecution(env.CONTROL, {
      token,
      requestId,
      transport: meta.transport,
      targetUrl: target.toString(),
      method: request.method,
      requestBytes: estimatedBodySize,
    });
    const authMs = performance.now() - authStartedAt;
    if (!authorization.allowed) {
      const code = mapAuthorizationCode(authorization.code);
      throw problem(
        code,
        code === "storage_unavailable"
          ? "storage"
          : code === "quota_exceeded"
            ? "quota"
            : "authorization",
        authorization.message ?? "Request authorization failed",
        code === "storage_unavailable"
          ? 503
          : code === "quota_exceeded"
            ? 429
            : 403,
        code === "storage_unavailable",
      );
    }
    if (
      !authorization.tokenId ||
      !authorization.config ||
      !authorization.configVersion
    ) {
      throw problem(
        "internal",
        "internal",
        "Control service returned an incomplete authorization",
        500,
      );
    }
    const authorized = {
      ...authorization,
      allowed: true as const,
      tokenId: authorization.tokenId,
      config: authorization.config,
      configVersion: authorization.configVersion,
    };
    const config = authorized.config;
    validateFetchOptions(meta);
    const prepared = await prepareRequestBody(
      request.body,
      declaredBodySize,
      transportBodySize,
      meta.body.sha256,
      meta.body.contentType ?? findHeader(meta, "content-type"),
      config.bodyInspectionLimitBytes,
      config.maxRequestBytes,
      controller.signal,
    );
    accountedRequestBytes = prepared.sizeBytes ?? estimatedBodySize;
    const policyStartedAt = performance.now();
    const decision = evaluatePolicies({
      meta,
      config,
      method: request.method,
      target,
      gatewayPathAndQuery: pathAndQuery,
      body: prepared.policy,
      redirectHops: 0,
      crossOrigin: false,
    });
    const policyMs = performance.now() - policyStartedAt;
    const contentType =
      meta.body.contentType ?? findHeader(meta, "content-type");
    const decisionInput = {
      tokenId: authorized.tokenId,
      requestId,
      transport: meta.transport,
      targetUrl: target.toString(),
      method: request.method,
      requestBytes: prepared.sizeBytes ?? estimatedBodySize,
      configVersion: authorized.configVersion,
      headers: meta.targetHeaders.slice(0, 256),
      ...(contentType === undefined ? {} : { contentType }),
      decision,
    };
    if (decision.decision === "deny") {
      await prepared.body?.cancel("policy_denied");
      const code =
        decision.source === "user-rule"
          ? "user_rule_denied"
          : "target_not_allowed";
      const auditState = await recordDecisionSafely(env.CONTROL, {
        ...decisionInput,
        code,
      });
      authorization = { ...authorized, auditState };
      leaseFinalized = true;
      throw problem(
        code,
        "policy",
        "System or user policy denied the request",
        403,
        false,
        { ruleId: decision.ruleId ?? null },
      );
    }
    const auditedAuthorization = {
      ...authorized,
      auditState: await recordDecisionSafely(env.CONTROL, decisionInput),
    };
    authorization = auditedAuthorization;

    const built = buildUpstreamHeaders(
      meta.targetHeaders,
      meta.fetchOptions.referrer,
    );
    const timeoutMs = Math.min(
      meta.fetchOptions.timeoutMs,
      config.requestTimeoutMs,
    );
    armTimeout(timeoutMs);

    const upstreamStartedAt = performance.now();
    const upstream = await fetchUpstream({
      meta,
      config,
      token,
      requestId,
      initialTarget: target,
      pathAndQuery,
      method: request.method,
      headers: built.headers,
      body: prepared.body,
      bodyPolicy: prepared.policy,
      signal: controller.signal,
      checkTarget: async (targetUrl) =>
        checkTarget(env.CONTROL, token, meta.transport, targetUrl),
    });
    const upstreamMs = performance.now() - upstreamStartedAt;
    const timing = initialTiming(
      authMs,
      policyMs,
      upstreamMs,
      parseServerTiming(upstream.response.headers.get("server-timing")),
    );
    const mutations = [
      ...built.mutations,
      ...upstream.mutations,
      ...classifyFetchOptions(meta.fetchOptions, CLOUDFLARE_FETCH_CAPABILITIES)
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
        })),
    ];
    const response = await targetResponse({
      response: upstream.response,
      token,
      requestId,
      nonce,
      reportId,
      auth: auditedAuthorization,
      timing,
      mutations,
      maxMetadataBytes: config.maxMetadataBytes,
      maxResponseBytes: config.maxResponseBytes,
      requestBytes: prepared.getUploadedBytes(),
      startedAt,
      redirects: upstream.redirects,
      complete: async (completion) =>
        completeExecution(env.CONTROL, completion),
      ctx,
      onFinalize: cleanupExecutionSignal,
      cancellationReason: () => abortReason,
    });
    appendAdapterServerTiming(response.headers, authMs, policyMs, upstreamMs);
    return response;
  } catch (error) {
    cleanupExecutionSignal();
    let gatewayProblem = asGatewayProblem(error);
    if (abortReason === "timeout")
      gatewayProblem = problem(
        "timeout",
        "timeout",
        "The request exceeded its timeout",
        504,
        true,
      );
    if (abortReason === "cancelled")
      gatewayProblem = problem(
        "cancelled",
        "cancellation",
        "The client cancelled the request",
        499,
      );
    if (
      authorization?.allowed &&
      authorization.tokenId &&
      reportId &&
      !leaseFinalized
    ) {
      const configVersion = authorization.configVersion ?? "unknown";
      ctx.waitUntil(
        completeExecution(env.CONTROL, {
          tokenId: authorization.tokenId,
          requestId,
          reportId,
          outcome:
            gatewayProblem.problem.code === "cancelled"
              ? "cancelled"
              : "relay-error",
          requestBytes: accountedRequestBytes,
          responseBytes: 0,
          durationMs: performance.now() - startedAt,
          timing: {
            phases: [
              {
                name: "total",
                state: "measured",
                source: "gateway",
                durationMs: performance.now() - startedAt,
              },
            ],
            serverTiming: [],
          },
          bodyComplete: false,
          errorCode: gatewayProblem.problem.code,
        }).catch((completionError: unknown) => {
          console.error(
            JSON.stringify({
              event: "execution.completion.failed",
              error:
                completionError instanceof Error
                  ? completionError.message
                  : "unknown",
            }),
          );
        }),
      );
      authorization = { ...authorization, configVersion };
    }
    return relayErrorResponse({
      problem: gatewayProblem.problem,
      status: gatewayProblem.status,
      token,
      requestId,
      nonce,
      configVersion: authorization?.configVersion ?? "unknown",
      audit: authorization?.auditState ?? "unknown",
      ...(reportId ? { reportId } : {}),
    });
  }
}

function contentLength(request: Request): number | undefined {
  const value = request.headers.get("content-length");
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function findHeader(
  meta: OneFetchRequestMetaV1,
  name: string,
): string | undefined {
  return meta.targetHeaders.find((entry) => entry.name.toLowerCase() === name)
    ?.value;
}

function mapAuthorizationCode(
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

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function appendAdapterServerTiming(
  headers: Headers,
  authMs: number,
  policyMs: number,
  upstreamMs: number,
): void {
  headers.append(
    "Server-Timing",
    `of_auth;dur=${authMs.toFixed(2)}, of_policy;dur=${policyMs.toFixed(2)}, of_ttfb;dur=${upstreamMs.toFixed(2)}`,
  );
}

async function recordDecisionSafely(
  control: CloudflareGatewayEnv["CONTROL"],
  input: ExecutionDecisionInput,
): Promise<"recorded" | "degraded"> {
  let result: Awaited<ReturnType<typeof recordExecutionDecision>>;
  try {
    result = await recordExecutionDecision(control, input);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "audit.decision.rpc.failed",
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
