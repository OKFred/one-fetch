import {
  ONE_FETCH_LIMITS_V1,
  PolicySetV1Schema,
  type HeaderEntryV1,
} from "@one-fetch/protocol";
import {
  classifyFetchOptions,
  createHttpPolicyContext,
  evaluateSystemPolicy,
  evaluateUserDenyRules,
} from "@one-fetch/core";

import { SUPABASE_FETCH_OPTIONS } from "../_shared/capabilities.ts";
import {
  stripSensitiveRedirectHeaders,
  targetHeaders,
} from "../_shared/upstream.ts";
import {
  milliseconds,
  problem,
  signedError,
  type ActiveConfig,
  type AuditState,
  type GatewayContext,
} from "./foundation.ts";
import { recordExecution } from "./recording.ts";
import {
  isRecursiveServiceTarget,
  pathAndQuery,
  readRequestBody,
  targetUrl,
  tokenAllows,
} from "./request.ts";
import { background } from "./stream.ts";
import { createTargetResponse } from "./target-response.ts";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function executeHttp(
  request: Request,
  context: GatewayContext,
  config: ActiveConfig,
): Promise<Response> {
  if (context.metadata.transport !== "http" || !context.metadata.targetOrigin) {
    return signedError(
      context,
      problem(
        "unsupported_request",
        "protocol",
        "Supabase HTTP Gateway received a non-HTTP transport",
      ),
    );
  }
  if (
    !config.initialized ||
    !config.config ||
    config.gatewayPaused ||
    config.config.gatewayPaused
  ) {
    return signedError(
      context,
      problem(
        "forbidden",
        "authorization",
        "Gateway is not initialized or is paused",
      ),
    );
  }
  const body = await readRequestBody(request, context.metadata);
  if (["GET", "HEAD"].includes(request.method) && body.byteLength > 0) {
    return signedError(
      context,
      problem(
        "unsupported_request",
        "protocol",
        `${request.method} requests cannot contain a body`,
      ),
    );
  }
  const optionAssessment = classifyFetchOptions(
    context.metadata.fetchOptions,
    SUPABASE_FETCH_OPTIONS,
  );
  if (!optionAssessment.allowed)
    return signedError(
      context,
      problem(
        "unsupported_option",
        "protocol",
        "One or more Fetch options are unsupported",
      ),
    );

  let currentUrl = targetUrl(
    context.metadata.targetOrigin,
    pathAndQuery(request),
  );
  if (!tokenAllows(context.principal, context.metadata, currentUrl)) {
    return signedError(
      context,
      problem(
        "forbidden",
        "authorization",
        "Execution token scope does not allow this target",
      ),
    );
  }

  let headers: Headers;
  try {
    headers = targetHeaders(context.metadata.targetHeaders, context.metadata);
  } catch {
    return signedError(
      context,
      problem(
        "unsupported_header",
        "protocol",
        "One or more target headers cannot be represented safely",
      ),
    );
  }

  const policy = PolicySetV1Schema.parse(config.config.policy);
  let method = request.method;
  let activeBody = body;
  let hops = 0;
  let leaseId: string | undefined;
  const abortController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort("timeout");
  }, context.metadata.fetchOptions.timeoutMs);
  request.signal.addEventListener(
    "abort",
    () => abortController.abort("client_cancelled"),
    { once: true },
  );

  let auditState: AuditState = "recorded";
  try {
    await recordExecution(context, "execution.received", "success");
  } catch {
    auditState = "degraded";
  }

  try {
    while (true) {
      if (
        isRecursiveServiceTarget(currentUrl, [
          context.environment.gatewayBaseUrl,
          context.environment.controlBaseUrl,
        ])
      ) {
        await recordExecution(context, "execution.recursion-denied", "denied", {
          code: "target_not_allowed",
        }).catch(() => undefined);
        clearTimeout(timeout);
        return signedError(
          context,
          problem(
            "target_not_allowed",
            "policy",
            "Recursive one-fetch target denied",
          ),
          auditState,
        );
      }
      const pathQuery = `${currentUrl.pathname}${currentUrl.search}`;
      const headerEntries: HeaderEntryV1[] = Array.from(
        headers,
        ([name, value]) => ({ name, value }),
      );
      const bodyAvailable =
        activeBody.byteLength <= config.config.bodyInspectionBytes;
      const policyContext = createHttpPolicyContext({
        method,
        targetOrigin: currentUrl.origin,
        pathAndQuery: pathQuery,
        headers: headerEntries,
        fetchOptions: context.metadata.fetchOptions,
        body: {
          availability: bodyAvailable ? "available" : "too-large",
          ...(bodyAvailable ? { bytes: activeBody } : {}),
          sizeBytes: activeBody.byteLength,
          ...(context.metadata.body.contentType
            ? { contentType: context.metadata.body.contentType }
            : {}),
        },
      });
      const systemDecision = evaluateSystemPolicy(policy, policyContext);
      if (systemDecision.decision === "deny") {
        await recordExecution(context, "execution.policy-denied", "denied", {
          code: "target_not_allowed",
        }).catch(() => undefined);
        clearTimeout(timeout);
        return signedError(
          context,
          problem(
            "target_not_allowed",
            "policy",
            "System policy denied the target",
          ),
          auditState,
        );
      }
      const userDecision = evaluateUserDenyRules(
        context.metadata.userDenyRules,
        policyContext,
      );
      if (userDecision.decision === "deny") {
        await recordExecution(context, "execution.user-rule-denied", "denied", {
          code: "user_rule_denied",
        }).catch(() => undefined);
        clearTimeout(timeout);
        return signedError(
          context,
          problem(
            "user_rule_denied",
            "policy",
            "User deny rule blocked the target",
          ),
          auditState,
        );
      }
      if (!tokenAllows(context.principal, context.metadata, currentUrl)) {
        clearTimeout(timeout);
        return signedError(
          context,
          problem(
            "forbidden",
            "authorization",
            "Execution token scope does not allow a redirected target",
          ),
          auditState,
        );
      }
      if (!leaseId) {
        const lease = await context.database.rpc<{
          allowed: boolean;
          reason?: string;
          leaseId?: string;
        }>("of_acquire_execution", {
          p_token_id: context.principal.tokenId,
          p_request_id: context.metadata.requestId,
          p_transport: "http",
          p_request_bytes: body.byteLength,
          p_lease_seconds: 1200,
        });
        if (!lease.allowed || !lease.leaseId) {
          clearTimeout(timeout);
          return signedError(
            context,
            problem(
              "quota_exceeded",
              "quota",
              `Quota denied: ${lease.reason ?? "unknown"}`,
              true,
            ),
            auditState,
          );
        }
        leaseId = lease.leaseId;
        await recordExecution(context, "execution.accepted", "success").catch(
          () => {
            auditState = "degraded";
          },
        );
      }

      const upstreamStarted = performance.now();
      const upstream = await fetch(currentUrl, {
        method,
        headers,
        redirect: "manual",
        signal: abortController.signal,
        ...(["GET", "HEAD"].includes(method)
          ? {}
          : { body: Uint8Array.from(activeBody).buffer }),
      });
      const ttfbMs = milliseconds(upstreamStarted);
      if (
        !REDIRECT_STATUSES.has(upstream.status) ||
        !upstream.headers.has("location") ||
        context.metadata.fetchOptions.redirect === "manual"
      ) {
        return createTargetResponse({
          request,
          context,
          upstream,
          leaseId,
          abortController,
          didTimeOut: () => timedOut,
          timeout,
          auditState,
          ttfbMs,
        });
      }

      if (context.metadata.fetchOptions.redirect === "error") {
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
            "redirect_disallowed",
            "upstream-headers",
            "Target returned a redirect",
          ),
          auditState,
        );
      }
      if (hops >= ONE_FETCH_LIMITS_V1.redirects) {
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
            "redirect_disallowed",
            "upstream-headers",
            "Redirect limit exceeded",
          ),
          auditState,
        );
      }
      const next = new URL(upstream.headers.get("location")!, currentUrl);
      if (!["http:", "https:"].includes(next.protocol)) {
        clearTimeout(timeout);
        background(
          context.database.rpc("of_release_execution", {
            p_lease_id: leaseId,
            p_response_bytes: 0,
          }),
        );
        return signedError(
          context,
          problem(
            "redirect_disallowed",
            "upstream-headers",
            "Redirect scheme is unsupported",
          ),
          auditState,
        );
      }
      if (next.origin !== currentUrl.origin)
        stripSensitiveRedirectHeaders(headers);
      if (
        (upstream.status === 303 && !["GET", "HEAD"].includes(method)) ||
        ((upstream.status === 301 || upstream.status === 302) &&
          method === "POST")
      ) {
        method = "GET";
        activeBody = new Uint8Array();
        for (const name of [
          "content-encoding",
          "content-language",
          "content-location",
          "content-type",
        ]) {
          headers.delete(name);
        }
      }
      await upstream.body?.cancel();
      currentUrl = next;
      hops += 1;
    }
  } catch {
    clearTimeout(timeout);
    if (leaseId)
      background(
        context.database.rpc("of_release_execution", {
          p_lease_id: leaseId,
          p_response_bytes: 0,
        }),
      );
    const cancelled = abortController.signal.aborted;
    const code = timedOut
      ? "timeout"
      : cancelled
        ? "cancelled"
        : "upstream_network";
    await recordExecution(
      context,
      `execution.${code}`,
      code === "cancelled" ? "partial" : "failure",
      { code },
    ).catch(() => undefined);
    return signedError(
      context,
      problem(
        code,
        timedOut ? "timeout" : cancelled ? "cancellation" : "connect",
        `Upstream request failed (${code})`,
        !cancelled,
      ),
      auditState,
    );
  }
}
