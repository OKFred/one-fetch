import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { performance } from "node:perf_hooks";

import {
  classifyFetchOptions,
  createHttpPolicyContext,
  evaluateSystemPolicy,
  evaluateUserDenyRules,
} from "@one-fetch/core";
import {
  decodeRequestMetadata,
  ONE_FETCH_LIMITS_V1,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_TOKEN_HEADER,
  type OneFetchRequestMetaV1,
  type OneFetchTimingV1,
} from "@one-fetch/protocol";

import type { AuditLedger } from "./audit.js";
import type { AuthenticationService, ExecutionCredential } from "./auth.js";
import { spoolBody, type BodySpool } from "./body-spool.js";
import { createCapabilities } from "./capabilities.js";
import type { NodeAdapterConfig } from "./config.js";
import type {
  ConfigurationStore,
  StoredConfiguration,
} from "./configuration.js";
import type { ExecutionReportStore } from "./execution-reports.js";
import { failure, GatewayFailure } from "./gateway-error.js";
import {
  sendRelayError,
  setTargetResponseMetadata,
  type ResponseContext,
} from "./gateway-response.js";
import { auditAccepted, streamTarget } from "./gateway-stream.js";
import { setCookieValues, validateTargetHeaders } from "./headers.js";
import { parseServerTiming } from "./server-timing.js";
import {
  executeUpstream,
  resolveApprovedTarget,
  TargetPolicyDeniedError,
} from "./upstream.js";

export interface GatewayDependencies {
  audit: AuditLedger;
  auth: AuthenticationService;
  config: NodeAdapterConfig;
  configuration: ConfigurationStore;
  reports: ExecutionReportStore;
}

const singleHeader = (
  request: IncomingMessage,
  name: string,
): string | undefined => {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const requireMetadata = (request: IncomingMessage): OneFetchRequestMetaV1 => {
  const encoded = singleHeader(request, ONE_FETCH_REQUEST_HEADER);
  if (!encoded)
    throw failure(
      "invalid_metadata",
      "protocol",
      "Missing one-fetch request metadata",
      400,
    );
  try {
    return decodeRequestMetadata(encoded);
  } catch (error) {
    throw failure(
      error instanceof Error && error.message.includes("maximum")
        ? "metadata_too_large"
        : "invalid_metadata",
      "protocol",
      "Request metadata is invalid",
      400,
    );
  }
};

const allowedByCredential = (
  credential: ExecutionCredential,
  origin: string,
): boolean =>
  credential.allowedOrigins.includes(origin) ||
  credential.allowedOrigins.includes("*");

const requestContentType = (
  metadata: OneFetchRequestMetaV1,
): string | undefined =>
  metadata.body.contentType ??
  metadata.targetHeaders.find(
    ({ name }) => name.toLowerCase() === "content-type",
  )?.value;

const policyContext = (
  request: IncomingMessage,
  metadata: OneFetchRequestMetaV1,
  body: BodySpool,
  origin = metadata.targetOrigin ?? "",
  headers = metadata.targetHeaders,
  resolvedIps?: string[],
  method = request.method ?? "GET",
  pathAndQuery = request.url ?? "/",
  relaySelf = false,
) => {
  const contentType = requestContentType(metadata);
  return createHttpPolicyContext({
    body: {
      availability: body.contentForPolicy ? "available" : "too-large",
      ...(body.contentForPolicy ? { bytes: body.contentForPolicy } : {}),
      ...(contentType ? { contentType } : {}),
      sizeBytes: body.sizeBytes,
    },
    fetchOptions: metadata.fetchOptions,
    headers,
    method,
    pathAndQuery,
    ...(resolvedIps ? { resolvedIps } : {}),
    relaySelf,
    targetOrigin: origin,
  });
};

const approve = (
  request: IncomingMessage,
  metadata: OneFetchRequestMetaV1,
  body: BodySpool,
  configuration: StoredConfiguration,
  credential: ExecutionCredential,
  gatewayOrigin: string,
  target: URL,
  headers = metadata.targetHeaders,
  resolvedIps?: string[],
  method = request.method ?? "GET",
): void => {
  const relaySelf = target.origin === new URL(gatewayOrigin).origin;
  if (relaySelf)
    throw failure(
      "target_not_allowed",
      "policy",
      "Recursive one-fetch target is not allowed",
      403,
    );
  if (!credential.scopes.includes("http"))
    throw failure("forbidden", "authorization", "HTTP scope is required", 403);
  if (!allowedByCredential(credential, target.origin)) {
    throw failure(
      "target_not_allowed",
      "authorization",
      "Execution token does not allow this target",
      403,
    );
  }
  const context = policyContext(
    request,
    metadata,
    body,
    target.origin,
    headers,
    resolvedIps,
    method,
    `${target.pathname}${target.search}`,
    relaySelf,
  );
  const system = evaluateSystemPolicy(configuration.policy, context);
  if (system.decision === "deny")
    throw failure(
      "target_not_allowed",
      "policy",
      "System policy denied the target",
      403,
    );
  const user = evaluateUserDenyRules(metadata.userDenyRules, context);
  if (user.decision === "deny")
    throw failure(
      "user_rule_denied",
      "policy",
      "User deny rule rejected the target",
      403,
    );
};

const validateRequest = (
  request: IncomingMessage,
  metadata: OneFetchRequestMetaV1,
  body: BodySpool,
  configuration: StoredConfiguration,
  dependencies: GatewayDependencies,
): void => {
  if (metadata.transport !== "http")
    throw failure(
      "unsupported_request",
      "protocol",
      "HTTP listener requires http transport",
      400,
    );
  if (!metadata.targetOrigin)
    throw failure(
      "invalid_metadata",
      "protocol",
      "HTTP request has no target origin",
      400,
    );
  if (
    new URL(metadata.targetOrigin).origin ===
    new URL(dependencies.config.publicGatewayUrl).origin
  ) {
    throw failure(
      "target_not_allowed",
      "policy",
      "Recursive one-fetch target is not allowed",
      403,
    );
  }
  if (metadata.hop > 0)
    throw failure(
      "target_not_allowed",
      "policy",
      "Relayed one-fetch recursion is not allowed",
      403,
    );
  const unsafeHeader = validateTargetHeaders(metadata.targetHeaders);
  if (unsafeHeader)
    throw failure(
      "unsupported_header",
      "protocol",
      `Header ${unsafeHeader} cannot be forwarded`,
      400,
    );
  if (
    metadata.body.sizeBytes !== undefined &&
    metadata.body.sizeBytes !== body.sizeBytes
  ) {
    throw failure(
      "invalid_metadata",
      "upload",
      "Declared request body size does not match payload",
      400,
    );
  }
  if (metadata.body.sha256 && metadata.body.sha256 !== body.sha256) {
    throw failure(
      "invalid_metadata",
      "upload",
      "Request body digest does not match payload",
      400,
    );
  }
  if (
    body.sizeBytes > 0 &&
    ["GET", "HEAD"].includes((request.method ?? "GET").toUpperCase())
  ) {
    throw failure(
      "unsupported_request",
      "upload",
      "GET and HEAD requests cannot carry a body",
      400,
    );
  }
  const options = classifyFetchOptions(
    metadata.fetchOptions,
    createCapabilities(dependencies.config, configuration).fetchOptions,
  );
  if (
    !options.allowed ||
    metadata.fetchOptions.timeoutMs > ONE_FETCH_LIMITS_V1.timeoutMs
  ) {
    throw failure(
      "unsupported_option",
      "protocol",
      "One or more fetch options are unsupported",
      400,
    );
  }
};

const handleGatewayRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: GatewayDependencies,
): Promise<void> => {
  const startedAt = performance.now();
  let metadata: OneFetchRequestMetaV1 | undefined;
  let body: BodySpool | undefined;
  let token = singleHeader(request, ONE_FETCH_TOKEN_HEADER) ?? "";
  let configuration: StoredConfiguration | undefined;
  let responseContext: ResponseContext | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  request.once("aborted", () =>
    abort.abort(new Error("Client upload cancelled")),
  );
  response.once("close", () => {
    if (!response.writableEnded)
      abort.abort(new Error("Client download cancelled"));
  });
  try {
    metadata = requireMetadata(request);
    if (!token)
      throw failure(
        "unauthorized",
        "authentication",
        "Execution token is required",
        401,
      );
    const credential = await dependencies.auth.authenticateExecution(token);
    if (!credential)
      throw failure(
        "unauthorized",
        "authentication",
        "Execution token is invalid",
        401,
      );
    configuration = await dependencies.configuration.get();
    body = await spoolBody(
      request,
      dependencies.config.requestBodyLimitBytes,
      ONE_FETCH_LIMITS_V1.inspectableBodyBytes,
    );
    validateRequest(request, metadata, body, configuration, dependencies);
    timeout = setTimeout(
      () => abort.abort(new Error("Request timeout")),
      metadata.fetchOptions.timeoutMs,
    );
    const targetApprover = async (
      url: URL,
      headers: OneFetchRequestMetaV1["targetHeaders"],
      _hops: number,
      resolvedIps: string[],
      method: string,
    ): Promise<boolean> => {
      try {
        approve(
          request,
          metadata!,
          body!,
          configuration!,
          credential,
          dependencies.config.publicGatewayUrl,
          url,
          headers,
          resolvedIps,
          method,
        );
        return true;
      } catch {
        return false;
      }
    };
    const initialResolution = await resolveApprovedTarget(
      new URL(request.url ?? "/", metadata.targetOrigin!),
      metadata.targetHeaders,
      0,
      request.method ?? "GET",
      targetApprover,
    );
    const auditState = await auditAccepted(
      dependencies,
      request,
      metadata,
      credential,
      configuration,
      body,
    );
    const reportId = metadata.requestId;
    responseContext = {
      auditState,
      configVersion: configuration.version,
      metadata,
      reportId,
      token,
    };
    const upstream = await executeUpstream({
      approveTarget: targetApprover,
      body,
      fetchOptions: metadata.fetchOptions,
      headers: metadata.targetHeaders,
      initialResolution,
      method: request.method ?? "GET",
      pathAndQuery: request.url ?? "/",
      signal: abort.signal,
      targetOrigin: metadata.targetOrigin!,
    });
    const serverTiming = parseServerTiming(
      upstream.response.headers["server-timing"],
    );
    const timing: OneFetchTimingV1 = { phases: upstream.timing, serverTiming };
    await setTargetResponseMetadata(
      response,
      responseContext,
      {
        kind: "http",
        bodyComplete: false,
        headers: upstream.headers,
        setCookie: setCookieValues(upstream.response.headers, upstream.headers),
        status: upstream.status,
        statusText: upstream.statusText,
      },
      timing,
    );
    response.statusCode = upstream.status;
    response.statusMessage = upstream.statusText;
    await streamTarget(
      upstream,
      response,
      dependencies,
      responseContext,
      credential,
      startedAt,
    );
  } catch (error) {
    const gatewayError =
      error instanceof GatewayFailure
        ? error
        : error instanceof TargetPolicyDeniedError
          ? failure(
              "target_not_allowed",
              "policy",
              "Resolved target addresses were denied by policy",
              403,
            )
          : failure(
              abort.signal.aborted ? "cancelled" : "upstream_network",
              abort.signal.aborted ? "cancellation" : "internal",
              abort.signal.aborted
                ? "Request was cancelled"
                : "Gateway request failed",
              abort.signal.aborted ? 499 : 502,
              !abort.signal.aborted,
            );
    if (!response.headersSent && metadata && token && configuration) {
      responseContext ??= {
        auditState: "unknown",
        configVersion: configuration.version,
        metadata,
        token,
      };
      await sendRelayError(
        response,
        responseContext,
        gatewayError.problem,
        gatewayError.status,
      );
    } else if (!response.headersSent) {
      response.writeHead(gatewayError.status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json; charset=utf-8",
      });
      response.end(JSON.stringify({ error: gatewayError.problem }));
    } else {
      response.destroy();
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    await body?.cleanup().catch(() => undefined);
  }
};

export const createGatewayServer = (
  dependencies: GatewayDependencies,
): Server =>
  createServer((request, response) => {
    void handleGatewayRequest(request, response, dependencies);
  });
