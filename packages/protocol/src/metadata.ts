import { z } from "zod";

import {
  Base64UrlSchema,
  ExactHttpOriginSchema,
  HeaderEntryV1Schema,
  IsoDateTimeSchema,
  NonceSchema,
  RequestIdSchema,
  Sha256HexSchema,
} from "./common.js";
import { ONE_FETCH_LIMITS_V1, PROTOCOL_VERSION } from "./constants.js";
import {
  FetchOptionCapabilityV1Schema,
  FetchOptionsV1Schema,
} from "./fetch-options.js";
import { UserDenyRulesV1Schema } from "./policy.js";

export const TransportV1Schema = z.enum(["http", "websocket", "tcp", "tls"]);
export type TransportV1 = z.infer<typeof TransportV1Schema>;

export const TargetAuthorityV1Schema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
    sni: z.string().min(1).max(253).optional(),
    alpn: z.array(z.string().min(1).max(255)).max(16).optional(),
  })
  .strict();
export type TargetAuthorityV1 = z.infer<typeof TargetAuthorityV1Schema>;

export const OneFetchRequestMetaV1Schema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: RequestIdSchema,
    nonce: NonceSchema,
    transport: TransportV1Schema,
    targetOrigin: ExactHttpOriginSchema.optional(),
    targetAuthority: TargetAuthorityV1Schema.optional(),
    targetUrlTraits: z
      .object({
        hasUserinfo: z.boolean(),
      })
      .strict()
      .optional(),
    targetHeaders: z
      .array(HeaderEntryV1Schema)
      .max(ONE_FETCH_LIMITS_V1.headers),
    fetchOptions: FetchOptionsV1Schema,
    userDenyRules: UserDenyRulesV1Schema.optional(),
    body: z
      .object({
        sizeBytes: z
          .number()
          .int()
          .nonnegative()
          .max(ONE_FETCH_LIMITS_V1.requestBodyBytes)
          .optional(),
        sha256: Sha256HexSchema.optional(),
        contentType: z.string().max(1_024).optional(),
      })
      .strict(),
    hop: z.number().int().min(0).max(8),
    client: z
      .object({
        name: z.string().min(1).max(128),
        version: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const isHttp =
      value.transport === "http" || value.transport === "websocket";
    if (isHttp && value.targetOrigin === undefined) {
      context.addIssue({
        code: "custom",
        message: "HTTP transports require targetOrigin",
        path: ["targetOrigin"],
      });
    }
    if (!isHttp && value.targetAuthority === undefined) {
      context.addIssue({
        code: "custom",
        message: "TCP transports require targetAuthority",
        path: ["targetAuthority"],
      });
    }
    if (isHttp && value.targetAuthority !== undefined) {
      context.addIssue({
        code: "custom",
        message: "HTTP transports cannot include targetAuthority",
        path: ["targetAuthority"],
      });
    }
    if (!isHttp && value.targetOrigin !== undefined) {
      context.addIssue({
        code: "custom",
        message: "TCP transports cannot include targetOrigin",
        path: ["targetOrigin"],
      });
    }
  });
export type OneFetchRequestMetaV1 = z.infer<typeof OneFetchRequestMetaV1Schema>;

export const OneFetchErrorOriginV1Schema = z.enum([
  "one-fetch",
  "adapter",
  "vendor",
]);
export const OneFetchErrorStageV1Schema = z.enum([
  "protocol",
  "authentication",
  "authorization",
  "policy",
  "quota",
  "upload",
  "dns",
  "connect",
  "tls",
  "upstream-headers",
  "upstream-body",
  "gateway-download",
  "timeout",
  "cancellation",
  "storage",
  "internal",
]);

export const OneFetchProblemCodeV1Schema = z.enum([
  "protocol_unsupported",
  "invalid_metadata",
  "signature_invalid",
  "unauthorized",
  "forbidden",
  "target_not_allowed",
  "user_rule_denied",
  "unsupported_request",
  "unsupported_header",
  "unsupported_option",
  "metadata_too_large",
  "payload_too_large",
  "response_too_large",
  "response_metadata_too_large",
  "redirect_disallowed",
  "quota_exceeded",
  "timeout",
  "cancelled",
  "upstream_network",
  "audit_degraded",
  "storage_unavailable",
  "internal",
]);

export const OneFetchProblemV1Schema = z
  .object({
    code: OneFetchProblemCodeV1Schema,
    origin: OneFetchErrorOriginV1Schema,
    stage: OneFetchErrorStageV1Schema,
    message: z.string().min(1).max(2_048),
    retryable: z.boolean(),
    details: z
      .record(
        z.string().min(1).max(128),
        z.union([z.string(), z.number(), z.boolean(), z.null()]),
      )
      .optional(),
  })
  .strict();
export type OneFetchProblemV1 = z.infer<typeof OneFetchProblemV1Schema>;

export const TimingPhaseV1Schema = z
  .object({
    name: z.enum([
      "auth",
      "policy",
      "upload",
      "dns",
      "connect",
      "tls",
      "upstream",
      "ttfb",
      "download",
      "total",
      "vendor",
    ]),
    state: z.enum(["measured", "reported", "reused", "unavailable"]),
    source: z.enum(["gateway", "target", "vendor"]),
    durationMs: z.number().nonnegative().finite().optional(),
    detail: z.string().max(512).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.state === "measured" || value.state === "reported") &&
      value.durationMs === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Measured timing requires durationMs",
        path: ["durationMs"],
      });
    }
    if (value.state === "unavailable" && value.durationMs !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Unavailable timing cannot report zero or another duration",
        path: ["durationMs"],
      });
    }
  });
export type TimingPhaseV1 = z.infer<typeof TimingPhaseV1Schema>;

export const ServerTimingMetricV1Schema = z
  .object({
    name: z.string().min(1).max(128),
    durationMs: z.number().nonnegative().finite().optional(),
    description: z.string().max(512).optional(),
  })
  .strict();
export type ServerTimingMetricV1 = z.infer<typeof ServerTimingMetricV1Schema>;

export const OneFetchTimingV1Schema = z
  .object({
    phases: z.array(TimingPhaseV1Schema).max(64),
    serverTiming: z.array(ServerTimingMetricV1Schema).max(128),
  })
  .strict();
export type OneFetchTimingV1 = z.infer<typeof OneFetchTimingV1Schema>;

export const HeaderMutationNoticeV1Schema = z
  .object({
    side: z.enum(["request", "response"]),
    actor: z.enum(["one-fetch", "adapter", "vendor"]),
    operation: z.enum([
      "added",
      "overwritten",
      "removed",
      "merged",
      "possibly-mutated",
    ]),
    name: z.string().min(1).max(256),
    detail: z.string().min(1).max(1_024),
  })
  .strict();
export type HeaderMutationNoticeV1 = z.infer<
  typeof HeaderMutationNoticeV1Schema
>;

export const TargetHttpResponseV1Schema = z
  .object({
    kind: z.literal("http"),
    status: z.number().int().min(100).max(599),
    statusText: z.string().max(1_024),
    headers: z.array(HeaderEntryV1Schema).max(ONE_FETCH_LIMITS_V1.headers),
    setCookie: z
      .array(z.string().max(ONE_FETCH_LIMITS_V1.headerValueBytes))
      .max(128),
    bodyComplete: z.boolean(),
  })
  .strict();
export type TargetHttpResponseV1 = z.infer<typeof TargetHttpResponseV1Schema>;

export const TargetTunnelResponseV1Schema = z
  .object({
    kind: z.literal("tunnel"),
    transport: z.enum(["websocket", "tcp", "tls"]),
    state: z.enum(["established", "closed", "rejected"]),
    selectedSubprotocol: z.string().max(255).optional(),
    close: z
      .object({
        code: z.number().int().min(0).max(65_535).optional(),
        reason: z.string().max(512).optional(),
        clean: z.boolean().optional(),
      })
      .strict()
      .optional(),
    handshake: z
      .object({
        status: z.number().int().min(100).max(599),
        statusText: z.string().max(1_024),
        headers: z.array(HeaderEntryV1Schema).max(ONE_FETCH_LIMITS_V1.headers),
        setCookie: z
          .array(z.string().max(ONE_FETCH_LIMITS_V1.headerValueBytes))
          .max(128),
      })
      .strict()
      .optional(),
    bytesUp: z.number().int().nonnegative().optional(),
    bytesDown: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.transport !== "websocket" &&
      value.selectedSubprotocol !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Only WebSocket tunnels select a subprotocol",
        path: ["selectedSubprotocol"],
      });
    }
    if (value.state === "rejected" && value.handshake === undefined) {
      context.addIssue({
        code: "custom",
        message: "Rejected tunnels require handshake metadata",
        path: ["handshake"],
      });
    }
  });
export type TargetTunnelResponseV1 = z.infer<
  typeof TargetTunnelResponseV1Schema
>;

export const TargetResponseV1Schema = z.discriminatedUnion("kind", [
  TargetHttpResponseV1Schema,
  TargetTunnelResponseV1Schema,
]);
export type TargetResponseV1 = z.infer<typeof TargetResponseV1Schema>;

const ResponseMetaBase = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    requestId: RequestIdSchema,
    nonce: NonceSchema,
    outcome: z.enum(["target", "relay-error"]),
    target: TargetResponseV1Schema.optional(),
    error: OneFetchProblemV1Schema.optional(),
    timing: OneFetchTimingV1Schema,
    configVersionUsed: z.string().min(1).max(256),
    mutations: z.array(HeaderMutationNoticeV1Schema).max(256),
    audit: z
      .object({
        state: z.enum(["recorded", "degraded", "unknown"]),
        eventId: z.string().min(1).max(128).optional(),
      })
      .strict(),
    reportId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === "target" && value.target === undefined) {
      context.addIssue({
        code: "custom",
        message: "Target outcome requires target",
        path: ["target"],
      });
    }
    if (value.outcome === "target" && value.error !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Target outcome cannot include relay error",
        path: ["error"],
      });
    }
    if (value.outcome === "relay-error" && value.error === undefined) {
      context.addIssue({
        code: "custom",
        message: "Relay error outcome requires error",
        path: ["error"],
      });
    }
    if (value.outcome === "relay-error" && value.target !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Relay error cannot masquerade as target",
        path: ["target"],
      });
    }
  });

export const OneFetchUnsignedResponseMetaV1Schema = ResponseMetaBase;
export type OneFetchUnsignedResponseMetaV1 = z.infer<
  typeof OneFetchUnsignedResponseMetaV1Schema
>;

export const OneFetchResponseMetaV1Schema = z.intersection(
  ResponseMetaBase,
  z.object({ signature: Base64UrlSchema }).strict(),
);
export type OneFetchResponseMetaV1 = z.infer<
  typeof OneFetchResponseMetaV1Schema
>;

export const OneFetchCapabilitiesV1Schema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    instanceId: z.string().min(1).max(128),
    provider: z.enum(["cloudflare", "supabase", "node"]),
    buildVersion: z.string().min(1).max(128),
    controlGatewayPairId: z.string().min(1).max(128),
    configVersion: z.string().min(1).max(256),
    configUpdatedAt: IsoDateTimeSchema,
    policyMode: z.enum(["allowlist", "blocklist"]),
    policyInspection: z
      .object({
        resolvedIpMatching: z.boolean(),
        dnsPinning: z.boolean(),
        userinfoSignal: z.boolean(),
        detail: z.string().max(1_024).optional(),
      })
      .strict()
      .optional(),
    transports: z.record(
      z.enum(["http", "websocket", "tcp", "tls"]),
      z
        .object({
          state: z.enum(["stable", "experimental", "unsupported"]),
          detail: z.string().max(1_024).optional(),
        })
        .strict(),
    ),
    limits: z
      .object({
        metadataBytes: z.number().int().positive(),
        requestBodyBytes: z.number().int().positive(),
        responseBodyBytes: z.number().int().positive(),
        inspectableBodyBytes: z.number().int().nonnegative(),
        timeoutMs: z.number().int().positive(),
        redirects: z.number().int().nonnegative(),
      })
      .strict(),
    fetchOptions: z.array(FetchOptionCapabilityV1Schema).max(128),
    headerMutations: z.array(HeaderMutationNoticeV1Schema).max(256),
    audit: z
      .object({
        state: z.enum(["healthy", "degraded", "unknown"]),
        lastSealAt: IsoDateTimeSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type OneFetchCapabilitiesV1 = z.infer<
  typeof OneFetchCapabilitiesV1Schema
>;
