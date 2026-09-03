import {
  AuditEventV1Schema,
  UnsignedAuditEventV1Schema,
  type AuditEventV1,
  type UnsignedAuditEventV1,
} from "@one-fetch/protocol";

import { sha256Hex, signAuditPayload, stableStringify } from "./crypto";

const FORBIDDEN_NAMES =
  /(?:authorization|cookie|password|passwd|secret|token|totp|recovery|private[-_ ]?key|certificate|signature)/iu;
const REDACTED = "[REDACTED]";

export interface AuditWriteInput {
  event: Omit<
    UnsignedAuditEventV1,
    "schemaVersion" | "eventId" | "recordedAt"
  > & {
    eventId?: string;
    recordedAt?: string;
  };
  signingKey: string;
}

function sanitizeString(value: string): string {
  return value.replaceAll(/\r|\n/gu, " ").slice(0, 8_192);
}

function sanitizeUnknown(value: unknown, key = ""): unknown {
  if (FORBIDDEN_NAMES.test(key)) return REDACTED;
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value))
    return value.slice(0, 256).map((entry) => sanitizeUnknown(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 256)
        .map(([childKey, childValue]) => [
          sanitizeString(childKey).slice(0, 256),
          sanitizeUnknown(childValue, childKey),
        ]),
    );
  }
  return value;
}

export function sanitizeAuditEvent(
  event: UnsignedAuditEventV1,
): UnsignedAuditEventV1 {
  const sanitized = sanitizeUnknown(event);
  return UnsignedAuditEventV1Schema.parse(sanitized);
}

export async function buildAuditEvent(
  input: AuditWriteInput,
): Promise<AuditEventV1> {
  const event = sanitizeAuditEvent({
    ...input.event,
    schemaVersion: 1,
    eventId: input.event.eventId ?? crypto.randomUUID(),
    recordedAt: input.event.recordedAt ?? new Date().toISOString(),
  });
  const payload = stableStringify(event);
  const payloadHash = await sha256Hex(payload);
  const signed = await signAuditPayload(payload, input.signingKey);
  return AuditEventV1Schema.parse({
    ...event,
    integrity: {
      payloadHash,
      signature: signed.signature,
      keyId: signed.keyId,
    },
  });
}

export function auditInsertStatement(
  database: D1Database,
  event: AuditEventV1,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO audit_events (
        event_id, occurred_at, recorded_at, category, action, outcome, severity,
        actor_json, correlation_json, detail_json, payload_json, payload_hash, signature, key_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.eventId,
      event.occurredAt,
      event.recordedAt,
      event.category,
      event.action,
      event.outcome,
      event.severity,
      stableStringify(event.actor),
      stableStringify(event.correlation),
      stableStringify({
        request: event.request,
        decision: event.decision,
        result: event.result,
        change: event.change,
        metrics: event.metrics,
      }),
      unsignedPayload(event),
      event.integrity.payloadHash,
      event.integrity.signature,
      event.integrity.keyId,
    );
}

function unsignedPayload(event: AuditEventV1): string {
  const { integrity: _integrity, ...unsigned } = event;
  void _integrity;
  return stableStringify(unsigned);
}

export async function writeAuditEvent(
  database: D1Database,
  event: AuditEventV1,
): Promise<void> {
  await auditInsertStatement(database, event).run();
}
