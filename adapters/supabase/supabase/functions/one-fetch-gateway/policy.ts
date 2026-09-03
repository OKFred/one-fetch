import { PolicySetV1Schema } from "@one-fetch/protocol";
import type { HeaderEntryV1 } from "../_shared/protocol-types.ts";
import {
  createHttpPolicyContext,
  evaluateSystemPolicy,
  evaluateUserDenyRules,
} from "@one-fetch/core";

import type { ActiveConfig, GatewayContext } from "./foundation.ts";

interface PolicyInput {
  context: GatewayContext;
  config: NonNullable<ActiveConfig["config"]>;
  url: URL;
  method: string;
  body: Uint8Array;
  headers: HeaderEntryV1[];
  contentType?: string;
  hops: number;
  initialOrigin: string;
}

export type PolicyDenial = "system" | "user";

export function evaluateRequestPolicy(
  input: PolicyInput,
): PolicyDenial | undefined {
  const bodyAvailable =
    input.body.byteLength <= input.config.bodyInspectionBytes;
  const policyContext = {
    ...createHttpPolicyContext({
      method: input.method,
      targetOrigin: input.url.origin,
      pathAndQuery: `${input.url.pathname}${input.url.search}`,
      headers: input.headers,
      fetchOptions: input.context.metadata.fetchOptions,
      hasUserinfo:
        input.hops === 0
          ? (input.context.metadata.targetUrlTraits?.hasUserinfo ?? false)
          : input.url.username !== "" || input.url.password !== "",
      body: {
        availability: bodyAvailable ? "available" : "too-large",
        ...(bodyAvailable ? { bytes: input.body } : {}),
        sizeBytes: input.body.byteLength,
        ...(input.contentType ? { contentType: input.contentType } : {}),
      },
    }),
    redirect: {
      hops: input.hops,
      crossOrigin: input.url.origin !== input.initialOrigin,
    },
  };
  const system = evaluateSystemPolicy(
    PolicySetV1Schema.parse(input.config.policy),
    policyContext,
  );
  if (system.decision === "deny") return "system";
  const user = evaluateUserDenyRules(
    input.context.metadata.userDenyRules,
    policyContext,
  );
  return user.decision === "deny" ? "user" : undefined;
}
