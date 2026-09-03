import {
  ONE_FETCH_LIMITS_V1,
  OneFetchCapabilitiesV1Schema,
  type FetchOptionCapabilityV1,
  type HeaderMutationNoticeV1,
  type OneFetchCapabilitiesV1,
} from "@one-fetch/protocol";

import type { SupabaseEnvironment } from "./env.ts";

export const SUPABASE_FETCH_OPTIONS: FetchOptionCapabilityV1[] = [
  { option: "redirect", fidelity: "exact" },
  { option: "timeoutMs", fidelity: "exact" },
  {
    option: "credentials",
    fidelity: "translated",
    detail: "Only explicit Cookie headers are forwarded.",
  },
  {
    option: "referrer",
    fidelity: "translated",
    detail:
      "Translated to an upstream Referer header and stripped on cross-origin redirects.",
  },
  {
    option: "referrerPolicy",
    fidelity: "unsupported",
    detail:
      "The Preview adapter cannot reproduce browser referrer-policy processing exactly.",
  },
  {
    option: "cache",
    fidelity: "vendor-mutated",
    detail: "The Supabase gateway or upstream may alter caching.",
  },
  {
    option: "keepalive",
    fidelity: "vendor-mutated",
    detail: "Edge Runtime owns connection reuse.",
  },
  {
    option: "duplex",
    fidelity: "vendor-mutated",
    detail: "Edge Runtime owns request streaming details.",
  },
  { option: "priority", fidelity: "unsupported" },
  { option: "mode", fidelity: "unsupported" },
  { option: "integrity", fidelity: "unsupported" },
  {
    option: "decompress",
    fidelity: "vendor-mutated",
    detail: "Edge Runtime may decode upstream content.",
  },
];

export const SUPABASE_HEADER_MUTATIONS: HeaderMutationNoticeV1[] = [
  {
    side: "request",
    actor: "adapter",
    operation: "merged",
    name: "*",
    detail:
      "The Edge Runtime Headers implementation can merge ordinary duplicate request fields; Cookie values are joined explicitly.",
  },
  {
    side: "request",
    actor: "vendor",
    operation: "possibly-mutated",
    name: "User-Agent",
    detail: "Supabase may add or rewrite transport headers.",
  },
  {
    side: "request",
    actor: "vendor",
    operation: "possibly-mutated",
    name: "Accept-Encoding",
    detail: "Supabase Edge Runtime controls compression negotiation.",
  },
  {
    side: "response",
    actor: "vendor",
    operation: "possibly-mutated",
    name: "*",
    detail:
      "The Supabase edge gateway may merge target fields and add platform-specific response headers. Set-Cookie is carried separately.",
  },
];

interface CapabilityState {
  instanceId?: string;
  initialized: boolean;
  configVersion?: string;
  updatedAt?: string;
  config?: { policy?: { mode?: "allowlist" | "blocklist" } };
}

export function buildSupabaseCapabilities(
  state: CapabilityState,
  environment: SupabaseEnvironment,
): OneFetchCapabilitiesV1 {
  return OneFetchCapabilitiesV1Schema.parse({
    protocolVersion: 1,
    instanceId: state.instanceId ?? environment.instanceId,
    provider: "supabase",
    buildVersion: environment.buildVersion,
    controlGatewayPairId: environment.instanceId,
    configVersion: state.configVersion ?? "uninitialized",
    configUpdatedAt: state.updatedAt ?? new Date(0).toISOString(),
    policyMode: state.config?.policy?.mode ?? "allowlist",
    policyInspection: {
      resolvedIpMatching: false,
      dnsPinning: false,
      userinfoSignal: true,
      detail:
        "Supabase policy can inspect the URL userinfo signal, but the runtime does not expose resolved addresses or connection pinning. Hostname rules are therefore a documented downgrade from Node.",
    },
    transports: {
      http: { state: "stable" },
      websocket: {
        state: "unsupported",
        detail:
          "The Preview adapter does not enable the authenticated tunnel data plane yet.",
      },
      tcp: {
        state: "unsupported",
        detail: "No deployment runtime probe has enabled outbound TCP.",
      },
      tls: {
        state: "unsupported",
        detail: "No deployment runtime probe has enabled outbound TLS.",
      },
    },
    limits: {
      metadataBytes: ONE_FETCH_LIMITS_V1.metadataBytes,
      requestBodyBytes: ONE_FETCH_LIMITS_V1.requestBodyBytes,
      responseBodyBytes: ONE_FETCH_LIMITS_V1.responseBodyBytes,
      inspectableBodyBytes: ONE_FETCH_LIMITS_V1.inspectableBodyBytes,
      timeoutMs: ONE_FETCH_LIMITS_V1.timeoutMs,
      redirects: ONE_FETCH_LIMITS_V1.redirects,
    },
    fetchOptions: SUPABASE_FETCH_OPTIONS,
    headerMutations: SUPABASE_HEADER_MUTATIONS,
    audit: { state: state.initialized ? "healthy" : "unknown" },
  });
}
