import type {
  HeaderEntryV1,
  OneFetchTimingV1,
  PolicySetV1,
} from "@one-fetch/protocol";
import type { PolicyDecision } from "@one-fetch/core";

export type Transport = "http" | "websocket" | "tcp" | "tls";

export interface HeaderEntry {
  name: string;
  value: string;
}

export interface TokenScope {
  transports: Transport[];
  origins: string[];
  ports: number[];
}

export interface QuotaLimits {
  requestsPerMinute: number;
  burstPerSecond: number;
  concurrentHttp: number;
  concurrentTunnels: number;
  bytesPerDay: number;
}

export interface RuntimeConfig {
  systemPolicy: PolicySetV1;
  defaultQuota: QuotaLimits;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxMetadataBytes: number;
  maxRedirects: number;
  requestTimeoutMs: number;
  bodyInspectionLimitBytes: number;
}

export interface AccessPrincipal {
  adminId: string;
  sessionId: string;
  username: string;
}

export interface ExecutionPrincipal {
  tokenId: string;
  name: string;
  scope: TokenScope;
  quota: QuotaLimits;
}

export interface AuthorizationInput {
  token: string;
  requestId: string;
  transport: Transport;
  targetUrl: string;
  method: string;
  requestBytes: number;
}

export interface AuthorizationResult {
  allowed: boolean;
  code?: string;
  message?: string;
  tokenId?: string;
  config?: RuntimeConfig;
  configVersion?: string;
  auditState: "recorded" | "degraded";
  auditEventId?: string;
}

export interface ExecutionDecisionInput {
  tokenId: string;
  requestId: string;
  transport: Transport;
  targetUrl: string;
  method: string;
  requestBytes: number;
  configVersion: string;
  headers: HeaderEntryV1[];
  contentType?: string;
  code?: string;
  decision: PolicyDecision;
}

export interface CompletionInput {
  tokenId: string;
  requestId: string;
  reportId: string;
  outcome: "target" | "relay-error" | "partial" | "cancelled";
  status?: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  timing: OneFetchTimingV1;
  bodyComplete: boolean;
  bodySha256?: string;
  errorCode?: string;
}

export interface QuotaAcquireInput {
  requestId: string;
  transport: Transport;
  now: number;
  requestBytes: number;
  leaseTtlMs: number;
  limits: QuotaLimits;
}

export type QuotaAcquireResult =
  | { allowed: true; leaseExpiresAt: number }
  | {
      allowed: false;
      code: "rate_limited" | "concurrency_limited" | "quota_exceeded";
      retryAfterMs: number;
    };

export interface QuotaSnapshot {
  minuteRequests: number;
  secondRequests: number;
  activeHttp: number;
  activeTunnels: number;
  dailyBytes: number;
}

export const DEFAULT_QUOTA: QuotaLimits = {
  requestsPerMinute: 60,
  burstPerSecond: 10,
  concurrentHttp: 4,
  concurrentTunnels: 2,
  bytesPerDay: 1_073_741_824,
};

export const DEFAULT_CONFIG: RuntimeConfig = {
  systemPolicy: {
    schemaVersion: 1,
    mode: "allowlist",
    revision: 1,
    rules: [],
  },
  defaultQuota: DEFAULT_QUOTA,
  maxRequestBytes: 20_971_520,
  maxResponseBytes: 20_971_520,
  maxMetadataBytes: 49_152,
  maxRedirects: 20,
  requestTimeoutMs: 60_000,
  bodyInspectionLimitBytes: 1_048_576,
};
