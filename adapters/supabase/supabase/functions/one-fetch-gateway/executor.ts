import { ONE_FETCH_LIMITS_V1 } from "@one-fetch/protocol";

import {
  stripSensitiveRedirectHeaderEntries,
  stripSensitiveRedirectHeaders,
} from "../_shared/upstream.ts";
import {
  type ActiveConfig,
  type GatewayContext,
  milliseconds,
  problem,
  signedError,
} from "./foundation.ts";
import { prepareExecution } from "./execution-setup.ts";
import { finalizeRelayError } from "./recording.ts";
import { isRecursiveServiceTarget, tokenAllows } from "./request.ts";
import { createTargetResponse } from "./target-response.ts";
import { evaluateRequestPolicy } from "./policy.ts";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function executeHttp(
  request: Request,
  context: GatewayContext,
  config: ActiveConfig,
): Promise<Response> {
  const setup = await prepareExecution(request, context, config);
  if (setup instanceof Response) return setup;
  let currentUrl = setup.currentUrl;
  const { initialOrigin, abortController, timeout, body, leaseId, headers } =
    setup;
  const { auditState } = setup;
  let { policyHeaders, contentType } = setup;
  let method = request.method;
  let activeBody = body;
  let hops = 0;
  const relayError = async (
    action: string,
    code: Parameters<typeof problem>[0],
    stage: Parameters<typeof problem>[1],
    message: string,
    target = currentUrl,
    outcome: "denied" | "failure" | "partial" = "failure",
    retryable = false,
  ): Promise<Response> => {
    clearTimeout(timeout);
    const error = problem(code, stage, message, retryable);
    const terminal = await finalizeRelayError(
      context,
      leaseId,
      error,
      auditState,
      {
        action,
        auditOutcome: outcome,
        targetUrl: target.href,
      },
    );
    return signedError(context, error, terminal.auditState, terminal.reportId);
  };

  try {
    while (true) {
      if (
        isRecursiveServiceTarget(currentUrl, [
          context.environment.gatewayBaseUrl,
          context.environment.controlBaseUrl,
        ])
      ) {
        return relayError(
          "execution.recursion-denied",
          "target_not_allowed",
          "policy",
          "Recursive one-fetch target denied",
          currentUrl,
          "denied",
        );
      }
      const policyDenial = evaluateRequestPolicy({
        context,
        config: setup.configuration,
        url: currentUrl,
        method,
        body: activeBody,
        headers: policyHeaders,
        ...(contentType ? { contentType } : {}),
        hops,
        initialOrigin,
      });
      if (policyDenial === "system") {
        return relayError(
          "execution.policy-denied",
          "target_not_allowed",
          "policy",
          "System policy denied the target",
          currentUrl,
          "denied",
        );
      }
      if (policyDenial === "user") {
        return relayError(
          "execution.user-rule-denied",
          "user_rule_denied",
          "policy",
          "User deny rule blocked the target",
          currentUrl,
          "denied",
        );
      }
      if (!tokenAllows(context.principal, context.metadata, currentUrl)) {
        return relayError(
          "execution.scope-denied",
          "forbidden",
          "authorization",
          "Execution token scope does not allow a redirected target",
          currentUrl,
          "denied",
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
          didTimeOut: setup.didTimeOut,
          timeout,
          auditState,
          ttfbMs,
        });
      }

      if (context.metadata.fetchOptions.redirect === "error") {
        await upstream.body?.cancel();
        return relayError(
          "execution.redirect-denied",
          "redirect_disallowed",
          "upstream-headers",
          "Target returned a redirect",
          currentUrl,
          "denied",
        );
      }
      if (hops >= ONE_FETCH_LIMITS_V1.redirects) {
        await upstream.body?.cancel();
        return relayError(
          "execution.redirect-denied",
          "redirect_disallowed",
          "upstream-headers",
          "Redirect limit exceeded",
          currentUrl,
          "denied",
        );
      }
      const next = new URL(upstream.headers.get("location")!, currentUrl);
      if (!["http:", "https:"].includes(next.protocol)) {
        await upstream.body?.cancel();
        return relayError(
          "execution.redirect-denied",
          "redirect_disallowed",
          "upstream-headers",
          "Redirect scheme is unsupported",
          next,
          "denied",
        );
      }
      if (next.origin !== currentUrl.origin) {
        stripSensitiveRedirectHeaders(headers);
        policyHeaders = stripSensitiveRedirectHeaderEntries(policyHeaders);
      }
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
          policyHeaders = policyHeaders.filter(
            (entry) => entry.name.toLowerCase() !== name,
          );
        }
        contentType = undefined;
      }
      await upstream.body?.cancel();
      currentUrl = next;
      hops += 1;
    }
  } catch {
    const cancelled = abortController.signal.aborted;
    const timedOut = setup.didTimeOut();
    const code = timedOut
      ? "timeout"
      : cancelled
        ? "cancelled"
        : "upstream_network";
    return relayError(
      `execution.${code}`,
      code,
      timedOut ? "timeout" : cancelled ? "cancellation" : "connect",
      `Upstream request failed (${code})`,
      currentUrl,
      code === "cancelled" ? "partial" : "failure",
      !cancelled,
    );
  }
}
