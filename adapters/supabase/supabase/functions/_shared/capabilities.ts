import {
  ONE_FETCH_LIMITS_V1,
  OneFetchCapabilitiesV1Schema,
  SUPABASE_ORIGINAL_PATH_V1,
} from "@one-fetch/protocol";
import type {
  FetchOptionCapabilityV1,
  HeaderMutationNoticeV1,
  OneFetchCapabilitiesV1,
} from "./protocol-types.ts";

import type { SupabaseEnvironment } from "./env.ts";

export const SUPABASE_FETCH_OPTIONS: FetchOptionCapabilityV1[] = [
  {
    option: `adapter.${SUPABASE_ORIGINAL_PATH_V1}`,
    fidelity: "exact",
    detail:
      "Required original path/query binding. Only repeated path slash collapse and percent-escape case changes at ingress are accepted; other rewrites fail closed.",
  },
  { option: "redirect", fidelity: "exact" },
  { option: "timeoutMs", fidelity: "exact" },
  {
    option: "credentials",
    fidelity: "unsupported",
    detail:
      "Preview does not translate Fetch credential modes; explicit target headers remain separate.",
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
    fidelity: "unsupported",
    detail: "Preview does not pass Fetch cache modes to the upstream request.",
  },
  {
    option: "keepalive",
    fidelity: "unsupported",
    detail: "Preview does not expose Fetch keepalive semantics.",
  },
  {
    option: "duplex",
    fidelity: "unsupported",
    detail: "Preview does not expose Fetch duplex semantics.",
  },
  { option: "priority", fidelity: "unsupported" },
  { option: "mode", fidelity: "unsupported" },
  { option: "integrity", fidelity: "unsupported" },
  {
    option: "decompress",
    fidelity: "unsupported",
    detail: "Preview does not implement configurable response decompression.",
  },
  {
    option: "adapter.supabaseAcceptMutations",
    fidelity: "exact",
    acceptedValues: [true],
    detail:
      "Confirms adapter translations and documented platform mutations for this request.",
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
  auditDegraded?: boolean;
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
      http: {
        state: "stable",
        detail:
          "Requires negotiated supabaseOriginalPathV1. Hosted ingress may normalize path/query; the original bytes are restored only after binding validation. Unsupported rewrites are rejected. Clients must refresh capabilities after upgrades.",
      },
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
    audit: {
      state: state.auditDegraded
        ? "degraded"
        : state.initialized
          ? "healthy"
          : "unknown",
    },
  });
}
