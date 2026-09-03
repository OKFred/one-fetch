import { classifyFetchOptions, randomNonce } from "@one-fetch/core";
import {
  decodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_TOKEN_HEADER,
  type OneFetchRequestMetaV1,
} from "@one-fetch/protocol";

import { CLOUDFLARE_FETCH_CAPABILITIES } from "./storage";
import type { AuthorizationResult } from "./types";
import { prepareRequestBody } from "./gateway/body";
import {
  authorizeExecution,
  checkTarget,
  completeExecution,
  releaseDeniedExecution,
} from "./gateway/control-client";
import { asGatewayProblem, problem } from "./gateway/errors";
import { buildUpstreamHeaders } from "./gateway/headers";
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

  try {
    if (!rawMetadata)
      throw problem(
        "invalid_metadata",
        "protocol",
        `${ONE_FETCH_REQUEST_HEADER} is required`,
        400,
      );
    const metadataLimit = parsePositiveInteger(env.MAX_METADATA_BYTES, 49_152);
    if (new TextEncoder().encode(rawMetadata).byteLength > metadataLimit) {
      throw problem(
        "metadata_too_large",
        "protocol",
        "Request metadata exceeds the adapter limit",
        431,
      );
    }
    const meta = decodeRequestMetadata(rawMetadata);
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
    const target = new URL(pathAndQuery, meta.targetOrigin);
    if (target.origin === gatewayUrl.origin)
      throw problem(
        "target_not_allowed",
        "policy",
        "Recursive gateway requests are denied",
        403,
      );
    const declaredBodySize = bodySize(meta, request);
    const authStartedAt = performance.now();
    authorization = await authorizeExecution(env.CONTROL, {
      token,
      requestId,
      transport: meta.transport,
      targetUrl: target.toString(),
      method: request.method,
      requestBytes: declaredBodySize ?? 0,
    });
    const authMs = performance.now() - authStartedAt;
    if (!authorization.allowed) {
      throw problem(
        mapAuthorizationCode(authorization.code),
        authorization.code === "quota_exceeded" ? "quota" : "authorization",
        authorization.message ?? "Request authorization failed",
        authorization.code === "quota_exceeded" ? 429 : 403,
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
      meta.body.contentType ?? findHeader(meta, "content-type"),
      config.bodyInspectionLimitBytes,
      config.maxRequestBytes,
    );
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
    if (decision.decision === "deny") {
      await prepared.body?.cancel("policy_denied");
      await releaseDeniedExecution(
        env.CONTROL,
        authorized.tokenId,
        requestId,
        decision.source === "user-rule"
          ? "user_rule_denied"
          : "target_not_allowed",
      );
      authorization = undefined;
      throw problem(
        decision.source === "user-rule"
          ? "user_rule_denied"
          : "target_not_allowed",
        "policy",
        "System or user policy denied the request",
        403,
        false,
        { ruleId: decision.ruleId ?? null },
      );
    }

    const built = buildUpstreamHeaders(
      meta.targetHeaders,
      meta.fetchOptions.referrer,
    );
    const controller = new AbortController();
    request.signal.addEventListener(
      "abort",
      () => {
        abortReason = "cancelled";
        controller.abort(request.signal.reason);
      },
      { once: true },
    );
    const timeoutMs = Math.min(
      meta.fetchOptions.timeoutMs,
      config.requestTimeoutMs,
    );
    timer = setTimeout(() => {
      abortReason = "timeout";
      controller.abort("timeout");
    }, timeoutMs);

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
      auth: authorized,
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
      onFinalize: () => {
        if (timer) clearTimeout(timer);
      },
      cancellationReason: () => abortReason,
    });
    appendAdapterServerTiming(response.headers, authMs, policyMs, upstreamMs);
    return response;
  } catch (error) {
    if (timer) clearTimeout(timer);
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
    if (authorization?.allowed && authorization.tokenId && reportId) {
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
          requestBytes: 0,
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

function bodySize(
  meta: OneFetchRequestMetaV1,
  request: Request,
): number | undefined {
  if (meta.body.sizeBytes !== undefined) return meta.body.sizeBytes;
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
): "unauthorized" | "forbidden" | "quota_exceeded" {
  if (value === "unauthorized") return "unauthorized";
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
