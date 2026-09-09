import type {
  AuditEventV1,
  ExecutionTokenRecordV1,
  OneFetchCapabilitiesV1,
  PolicySetV1,
} from "@one-fetch/protocol";

export interface InstanceProfile {
  id: string;
  name: string;
  controlUrl: string;
}

export interface BootstrapState {
  initialized: boolean;
  supported: boolean;
}

export interface RuntimeConfiguration {
  version: string;
  updatedAt: string;
  revision: number;
  gatewayPaused: boolean;
  policy: PolicySetV1;
  raw: Record<string, unknown>;
  etag?: string;
}

export interface AuditPage {
  events: AuditEventV1[];
  nextCursor?: string;
}

export interface FeatureState {
  available: boolean;
  detail?: string;
}

export interface AdminSnapshot {
  capabilities: OneFetchCapabilitiesV1 | null;
  bootstrap: BootstrapState | null;
  configuration: RuntimeConfiguration | null;
  tokens: ExecutionTokenRecordV1[];
  audit: AuditPage;
}

export interface SessionState {
  accessToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  sessionId?: string;
}

export interface AdminSessionPair extends SessionState {
  refreshToken: string;
}

export interface UnsupportedFeature {
  feature: "alerts" | "backup" | "gateway-pause" | "audit-export";
  reason: string;
}

export type ControlPage =
  | "overview"
  | "security"
  | "policy"
  | "tokens"
  | "audit"
  | "alerts"
  | "backup";
