import {
  classifyFetchOptions,
  createHttpPolicyContext,
  evaluateSystemPolicy,
  evaluateUserDenyRules,
  type PolicyBodyContext,
  type PolicyDecision,
} from "@one-fetch/core";
import type { OneFetchRequestMetaV1 } from "@one-fetch/protocol";

import { CLOUDFLARE_FETCH_CAPABILITIES } from "../storage";
import type { RuntimeConfig } from "../types";
import { problem } from "./errors";

export function validateFetchOptions(meta: OneFetchRequestMetaV1): void {
  const classification = classifyFetchOptions(
    meta.fetchOptions,
    CLOUDFLARE_FETCH_CAPABILITIES,
  );
  if (!classification.allowed) {
    const unsupported = classification.assessments
      .filter(({ fidelity }) => fidelity === "unsupported")
      .map(({ option }) => option);
    throw problem(
      "unsupported_option",
      "protocol",
      `Cloudflare cannot preserve: ${unsupported.join(", ")}`,
      400,
      false,
      { options: unsupported.join(",") },
    );
  }
  if (
    classification.requiresConfirmation &&
    meta.fetchOptions.adapter?.cloudflareAcceptMutations !== true
  ) {
    throw problem(
      "unsupported_option",
      "protocol",
      "Translated or vendor-mutated Fetch options require explicit confirmation",
      409,
      false,
      { confirmation: "fetchOptions.adapter.cloudflareAcceptMutations" },
    );
  }
}

export function evaluatePolicies(input: {
  meta: OneFetchRequestMetaV1;
  config: RuntimeConfig;
  method: string;
  target: URL;
  gatewayPathAndQuery: string;
  body: PolicyBodyContext;
  redirectHops: number;
  crossOrigin: boolean;
}): PolicyDecision {
  const context = createHttpPolicyContext({
    method: input.method,
    targetOrigin: input.target.origin,
    pathAndQuery: input.gatewayPathAndQuery,
    headers: input.meta.targetHeaders,
    fetchOptions: input.meta.fetchOptions,
    body: input.body,
    transport: input.meta.transport === "websocket" ? "websocket" : "http",
    hasUserinfo:
      input.meta.targetUrlTraits?.hasUserinfo === true ||
      input.target.username !== "" ||
      input.target.password !== "",
  });
  context.redirect = {
    hops: input.redirectHops,
    crossOrigin: input.crossOrigin,
  };
  const system = evaluateSystemPolicy(input.config.systemPolicy, context);
  if (system.decision === "deny") return system;
  return evaluateUserDenyRules(input.meta.userDenyRules, context);
}
