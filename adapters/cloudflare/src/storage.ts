import type {
  FetchOptionCapabilityV1,
  OneFetchCapabilitiesV1,
} from "@one-fetch/protocol";

import { defaultConfigRecord, parseRuntimeConfigJson } from "./config";
import { stableStringify } from "./crypto";
import type { RuntimeConfig } from "./types";

interface InstanceRow {
  instance_id: string;
  initialized_at: string | null;
  config_revision: number;
  config_version: string;
  config_updated_at: string;
  config_json: string;
  gateway_paused: number;
  audit_degraded: number;
}

export interface InstanceRecord {
  instanceId: string;
  initializedAt?: string;
  configRevision: number;
  configVersion: string;
  configUpdatedAt: string;
  config: RuntimeConfig;
  gatewayPaused: boolean;
  auditDegraded: boolean;
}

export const CLOUDFLARE_FETCH_CAPABILITIES: FetchOptionCapabilityV1[] = [
  {
    option: "redirect",
    fidelity: "exact",
    acceptedValues: ["follow", "manual", "error"],
  },
  { option: "timeoutMs", fidelity: "exact" },
  {
    option: "cache",
    fidelity: "vendor-mutated",
    detail: "Cloudflare may apply cache semantics independently.",
  },
  {
    option: "credentials",
    fidelity: "translated",
    detail: "Only explicit target Cookie headers are forwarded.",
  },
  { option: "integrity", fidelity: "unsupported" },
  { option: "keepalive", fidelity: "unsupported" },
  {
    option: "mode",
    fidelity: "translated",
    detail: "Server-side fetch has no browser CORS mode.",
  },
  { option: "priority", fidelity: "unsupported" },
  {
    option: "referrer",
    fidelity: "translated",
    detail: "Translated to a Referer header when permitted.",
  },
  { option: "referrerPolicy", fidelity: "translated" },
  { option: "duplex", fidelity: "translated", acceptedValues: ["half"] },
  {
    option: "decompress",
    fidelity: "vendor-mutated",
    detail: "Cloudflare controls upstream content decoding.",
  },
  {
    option: "adapter.cloudflareAcceptMutations",
    fidelity: "exact",
    acceptedValues: [true],
  },
];

export async function ensureInstance(
  database: D1Database,
): Promise<InstanceRecord> {
  const existing = await database
    .prepare("SELECT * FROM instance_state WHERE singleton = 1")
    .first<InstanceRow>();
  if (existing) return mapInstance(existing);

  const now = new Date();
  const defaults = await defaultConfigRecord(now);
  await database
    .prepare(
      `INSERT OR IGNORE INTO instance_state (
        singleton, instance_id, config_revision, config_version, config_updated_at, config_json
      ) VALUES (1, ?, 1, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      defaults.configVersion,
      now.toISOString(),
      defaults.configJson,
    )
    .run();
  const created = await database
    .prepare("SELECT * FROM instance_state WHERE singleton = 1")
    .first<InstanceRow>();
  if (!created) throw new Error("Unable to initialize instance state");
  return mapInstance(created);
}

function mapInstance(row: InstanceRow): InstanceRecord {
  return {
    instanceId: row.instance_id,
    ...(row.initialized_at ? { initializedAt: row.initialized_at } : {}),
    configRevision: row.config_revision,
    configVersion: row.config_version,
    configUpdatedAt: row.config_updated_at,
    config: parseRuntimeConfigJson(row.config_json),
    gatewayPaused: row.gateway_paused === 1,
    auditDegraded: row.audit_degraded === 1,
  };
}

export function createCapabilities(
  instance: InstanceRecord,
  adapterVersion: string,
): OneFetchCapabilitiesV1 {
  const config = instance.config;
  return {
    protocolVersion: 1,
    instanceId: instance.instanceId,
    provider: "cloudflare",
    buildVersion: adapterVersion,
    controlGatewayPairId: instance.instanceId,
    configVersion: instance.configVersion,
    configUpdatedAt: instance.configUpdatedAt,
    policyMode: config.systemPolicy.mode,
    policyInspection: {
      resolvedIpMatching: false,
      dnsPinning: false,
      userinfoSignal: true,
      detail:
        "Cloudflare validates request URLs but does not expose or pin resolved target IPs for fetch().",
    },
    transports: {
      http: { state: "stable" },
      websocket: {
        state: "experimental",
        detail:
          "Uses the signed first-frame one-fetch tunnel handshake; outer WebSocket subprotocol is fixed to one-fetch.v1.",
      },
      tcp: {
        state: "unsupported",
        detail: "The 0.1 Cloudflare adapter currently exposes only HTTP/SSE.",
      },
      tls: {
        state: "unsupported",
        detail: "The 0.1 Cloudflare adapter currently exposes only HTTP/SSE.",
      },
    },
    limits: {
      metadataBytes: config.maxMetadataBytes,
      requestBodyBytes: config.maxRequestBytes,
      responseBodyBytes: config.maxResponseBytes,
      inspectableBodyBytes: config.bodyInspectionLimitBytes,
      timeoutMs: config.requestTimeoutMs,
      redirects: config.maxRedirects,
    },
    fetchOptions: CLOUDFLARE_FETCH_CAPABILITIES,
    headerMutations: [
      {
        side: "request",
        actor: "vendor",
        operation: "possibly-mutated",
        name: "Accept-Encoding",
        detail: "Cloudflare may normalize transport-level request headers.",
      },
      {
        side: "request",
        actor: "vendor",
        operation: "added",
        name: "CF-Connecting-IP / X-Forwarded-For",
        detail:
          "Cloudflare can add or normalize network identity headers on outbound subrequests; they are not user-controlled target headers.",
      },
      {
        side: "response",
        actor: "vendor",
        operation: "possibly-mutated",
        name: "Server-Timing",
        detail: "Cloudflare can append its own Server-Timing metrics.",
      },
      {
        side: "response",
        actor: "vendor",
        operation: "added",
        name: "CF-Ray / Server",
        detail:
          "The Cloudflare edge can add outer response headers after one-fetch signs target response metadata.",
      },
    ],
    audit: { state: instance.auditDegraded ? "degraded" : "healthy" },
  };
}

export async function purgeExpiredRecords(
  database: D1Database,
  now = new Date(),
): Promise<void> {
  const nowIso = now.toISOString();
  const executionCutoff = new Date(
    now.getTime() - 30 * 86_400_000,
  ).toISOString();
  const securityCutoff = new Date(
    now.getTime() - 180 * 86_400_000,
  ).toISOString();
  await database.batch([
    database
      .prepare("DELETE FROM execution_reports WHERE expires_at <= ?")
      .bind(nowIso),
    database
      .prepare(
        "DELETE FROM access_tokens WHERE expires_at <= ? OR revoked_at IS NOT NULL",
      )
      .bind(nowIso),
    database
      .prepare(
        "DELETE FROM audit_events WHERE category = 'execution' AND occurred_at < ?",
      )
      .bind(executionCutoff),
    database
      .prepare(
        "DELETE FROM audit_events WHERE category != 'execution' AND occurred_at < ?",
      )
      .bind(securityCutoff),
  ]);
}

export function reportJson(value: unknown): string {
  return stableStringify(value);
}
