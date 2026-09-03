import type { PolicyBodyContext } from "@one-fetch/core";
import type {
  OneFetchRequestMetaV1,
  HeaderMutationNoticeV1,
} from "@one-fetch/protocol";

import type { AuthorizationResult, RuntimeConfig } from "../types";
import { problem } from "./errors";
import { removeBodyHeaders, stripCrossOriginCredentials } from "./headers";
import { evaluatePolicies } from "./policy";

export interface UpstreamInput {
  meta: OneFetchRequestMetaV1;
  config: RuntimeConfig;
  token: string;
  requestId: string;
  initialTarget: URL;
  pathAndQuery: string;
  method: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  bodyPolicy: PolicyBodyContext;
  signal: AbortSignal;
  checkTarget(targetUrl: string): Promise<AuthorizationResult>;
}

export interface UpstreamResult {
  response: Response;
  redirects: number;
  mutations: HeaderMutationNoticeV1[];
  finalTarget: URL;
}

export async function fetchUpstream(
  input: UpstreamInput,
): Promise<UpstreamResult> {
  let target = input.initialTarget;
  let method = input.method;
  let body = input.body;
  let hops = 0;
  const headers = new Headers(input.headers);
  const mutations: HeaderMutationNoticeV1[] = [];

  while (true) {
    const response = await fetch(target, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? null : body,
      redirect: "manual",
      signal: input.signal,
    });
    if (!isRedirect(response.status))
      return { response, redirects: hops, mutations, finalTarget: target };

    const mode = input.meta.fetchOptions.redirect;
    if (mode === "manual")
      return { response, redirects: hops, mutations, finalTarget: target };
    if (mode === "error") {
      await response.body?.cancel("redirect_disallowed");
      throw problem(
        "redirect_disallowed",
        "upstream-headers",
        "The target returned a redirect while redirect mode is error",
        502,
      );
    }
    if (hops >= input.config.maxRedirects) {
      await response.body?.cancel("redirect_limit");
      throw problem(
        "redirect_disallowed",
        "upstream-headers",
        "The target exceeded the redirect limit",
        508,
      );
    }
    const location = response.headers.get("location");
    if (!location)
      return { response, redirects: hops, mutations, finalTarget: target };
    const nextTarget = new URL(location, target);
    if (nextTarget.protocol !== "https:") {
      await response.body?.cancel("target_not_allowed");
      throw problem(
        "target_not_allowed",
        "policy",
        "Redirects must remain on HTTPS targets",
        403,
      );
    }

    const bodyCanSwitchToGet =
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        method === "POST");
    if (body && !bodyCanSwitchToGet) {
      return { response, redirects: hops, mutations, finalTarget: target };
    }
    const targetAuthorization = await input.checkTarget(nextTarget.toString());
    if (!targetAuthorization.allowed) {
      await response.body?.cancel("redirect_denied");
      throw problem(
        "target_not_allowed",
        "policy",
        "A redirect target was denied",
        403,
      );
    }
    const crossOrigin = target.origin !== nextTarget.origin;
    const decision = evaluatePolicies({
      meta: input.meta,
      config: input.config,
      method: bodyCanSwitchToGet ? "GET" : method,
      target: nextTarget,
      gatewayPathAndQuery: `${nextTarget.pathname}${nextTarget.search}`,
      body: bodyCanSwitchToGet
        ? { availability: "available", bytes: new Uint8Array(), sizeBytes: 0 }
        : input.bodyPolicy,
      redirectHops: hops + 1,
      crossOrigin,
    });
    if (decision.decision === "deny") {
      await response.body?.cancel("redirect_denied");
      throw problem(
        "target_not_allowed",
        "policy",
        "System or user policy denied a redirect target",
        403,
        false,
        { ruleId: decision.ruleId ?? null },
      );
    }
    await response.body?.cancel("redirect_followed");
    if (crossOrigin) mutations.push(...stripCrossOriginCredentials(headers));
    if (bodyCanSwitchToGet) {
      method = "GET";
      body = null;
      removeBodyHeaders(headers);
    }
    target = nextTarget;
    hops += 1;
  }
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}
