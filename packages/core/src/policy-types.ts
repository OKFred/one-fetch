import type {
  FetchOptionsV1,
  HeaderEntryV1,
  TransportV1,
} from "@one-fetch/protocol";

import type { IpKind } from "./ip.js";

export interface PolicyBodyContext {
  availability: "available" | "streaming" | "too-large" | "unavailable";
  bytes?: Uint8Array;
  sizeBytes?: number;
  contentType?: string;
}

export interface PolicyRequestContext {
  transport: TransportV1;
  method?: string;
  scheme?: "http" | "https" | "ws" | "wss";
  hasUserinfo?: boolean;
  hostKind?: "dns" | IpKind;
  resolvedIps?: string[];
  relaySelf?: boolean;
  origin?: string;
  host?: string;
  port?: number;
  rawPath?: string;
  normalizedPath?: string;
  query: Array<readonly [string, string]>;
  headers: HeaderEntryV1[];
  fetchOptions: FetchOptionsV1;
  body: PolicyBodyContext;
  redirect?: { hops: number; crossOrigin: boolean };
  websocketSubprotocols?: string[];
  sni?: string;
  alpn?: string[];
}

export interface PolicyDecision {
  decision: "allow" | "deny";
  source: "default" | "system-rule" | "user-rule";
  ruleId?: string;
  warnings: string[];
}
