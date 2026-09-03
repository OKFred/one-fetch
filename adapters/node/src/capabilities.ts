import {
  ONE_FETCH_LIMITS_V1,
  type FetchOptionCapabilityV1,
  type OneFetchCapabilitiesV1,
} from "@one-fetch/protocol";

import type { NodeAdapterConfig } from "./config.js";
import type { StoredConfiguration } from "./configuration.js";

const fetchOptions: FetchOptionCapabilityV1[] = [
  { option: "redirect", fidelity: "translated" },
  { option: "timeoutMs", fidelity: "exact" },
  {
    option: "cache",
    fidelity: "unsupported",
    detail: "Node gateway does not implement a cache",
  },
  {
    option: "credentials",
    fidelity: "translated",
    detail:
      "Explicit Cookie and Authorization headers are forwarded; no ambient browser jar exists",
  },
  {
    option: "integrity",
    fidelity: "translated",
    detail: "Verified while streaming the target body",
  },
  {
    option: "keepalive",
    fidelity: "translated",
    detail: "Mapped to the Node connection pool",
  },
  {
    option: "mode",
    fidelity: "unsupported",
    detail: "CORS modes are browser-only",
  },
  { option: "priority", fidelity: "unsupported" },
  {
    option: "referrer",
    fidelity: "translated",
    detail: "Mapped to the Referer header",
  },
  { option: "referrerPolicy", fidelity: "translated" },
  { option: "duplex", fidelity: "exact" },
  { option: "decompress", fidelity: "exact" },
  {
    option: "adapter.proxy",
    fidelity: "unsupported",
    detail:
      "Preview rejects proxies because proxy-side DNS resolution cannot preserve the approved-IP pin",
  },
  { option: "adapter.caPem", fidelity: "exact" },
  { option: "adapter.clientCertificatePem", fidelity: "exact" },
  { option: "adapter.clientPrivateKeyPem", fidelity: "exact" },
  {
    option: "adapter.rejectUnauthorized",
    fidelity: "exact",
    acceptedValues: [true, false],
  },
];

export const createCapabilities = (
  config: NodeAdapterConfig,
  stored: StoredConfiguration,
): OneFetchCapabilitiesV1 => ({
  protocolVersion: 1,
  instanceId: config.instanceId,
  provider: "node",
  buildVersion: "0.1.0",
  controlGatewayPairId: stored.controlGatewayPairId,
  configVersion: stored.version,
  configUpdatedAt: stored.updatedAt,
  policyMode: stored.policy.mode,
  policyInspection: {
    dnsPinning: true,
    resolvedIpMatching: true,
    userinfoSignal: true,
    detail:
      "All A/AAAA answers are resolved before connection and the selected approved address is pinned",
  },
  transports: {
    http: { state: "stable" },
    websocket: { state: "experimental" },
    tcp: { state: "experimental" },
    tls: { state: "experimental" },
  },
  limits: {
    metadataBytes: ONE_FETCH_LIMITS_V1.metadataBytes,
    requestBodyBytes: config.requestBodyLimitBytes,
    responseBodyBytes: config.responseBodyLimitBytes,
    inspectableBodyBytes: ONE_FETCH_LIMITS_V1.inspectableBodyBytes,
    timeoutMs: ONE_FETCH_LIMITS_V1.timeoutMs,
    redirects: ONE_FETCH_LIMITS_V1.redirects,
  },
  fetchOptions,
  headerMutations: [
    {
      actor: "adapter",
      detail: "Node may add framing headers and normalize transfer encoding",
      name: "connection framing",
      operation: "possibly-mutated",
      side: "request",
    },
    {
      actor: "vendor",
      detail:
        "Reverse proxies may add or change vendor-specific response headers",
      name: "vendor-specific headers",
      operation: "possibly-mutated",
      side: "response",
    },
  ],
  audit: { state: "healthy" },
});
