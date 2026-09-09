import { createPrivateKey, createPublicKey, sign } from "node:crypto";

import {
  AuditEventV1Schema,
  type AuditEventV1,
  type UnsignedAuditEventV1,
} from "@one-fetch/protocol";
import { redactAuditEvent } from "@one-fetch/core";

import { randomId, sha256Hex, stableJson } from "./crypto.js";
import type { DatabaseClient } from "./database.js";
import type { SqlOperation } from "./database-protocol.js";

const NEVER_RECORD_KEYS = new Set([
  "body",
  "certificate",
  "clientcertificate",
  "cookie",
  "password",
  "privatekey",
  "recoverycode",
  "set-cookie",
  "token",
  "totp",
]);

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
]);

const removeForbiddenFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(removeForbiddenFields);
  if (!value || typeof value !== "object") return value;
  const entries: [string, unknown][] = [];
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (NEVER_RECORD_KEYS.has(key.toLowerCase().replaceAll(/[^a-z-]/gu, "")))
      continue;
    if (key === "headers" && Array.isArray(nested)) {
      const headers = nested as unknown[];
      entries.push([
        key,
        headers.map((header) => {
          if (!header || typeof header !== "object") return header;
          const entry = header as { name?: unknown; value?: unknown };
          return typeof entry.name === "string" &&
            SENSITIVE_HEADER_NAMES.has(entry.name.toLowerCase())
            ? { ...entry, value: "[REDACTED]" }
            : entry;
        }),
      ]);
      continue;
    }
    entries.push([key, removeForbiddenFields(nested)]);
  }
  return Object.fromEntries(entries);
};

export interface AuditInput
  extends Omit<
    UnsignedAuditEventV1,
    "schemaVersion" | "eventId" | "occurredAt" | "recordedAt"
  > {
  eventId?: string;
  occurredAt?: string;
}

export interface PreparedAuditEvent {
  event: UnsignedAuditEventV1 & {
    integrity: { keyId: string; payloadHash: string; signature: string };
  };
  operation: SqlOperation;
}

export class AuditLedger {
  readonly #database: DatabaseClient;
  readonly #keyId: string;
  readonly #privateKey: ReturnType<typeof createPrivateKey>;

  constructor(database: DatabaseClient, privateKeyBase64: string) {
    this.#database = database;
    this.#privateKey = createPrivateKey({
      format: "der",
      key: Buffer.from(privateKeyBase64, "base64"),
      type: "pkcs8",
    });
    const publicDer = createPublicKey(this.#privateKey).export({
      format: "der",
      type: "spki",
    });
    this.#keyId = `ed25519:${sha256Hex(publicDer).slice(0, 16)}`;
  }

  prepare(input: AuditInput): PreparedAuditEvent {
    const timestamp = new Date().toISOString();
    const unsigned = redactAuditEvent(
      removeForbiddenFields({
        ...input,
        eventId: input.eventId ?? randomId("audit"),
        occurredAt: input.occurredAt ?? timestamp,
        recordedAt: timestamp,
        schemaVersion: 1,
      }) as UnsignedAuditEventV1,
    );
    const canonical = stableJson(unsigned);
    const payloadHash = sha256Hex(canonical);
    const signature = sign(
      null,
      Buffer.from(canonical, "utf8"),
      this.#privateKey,
    ).toString("base64url");
    const event = {
      ...unsigned,
      integrity: { keyId: this.#keyId, payloadHash, signature },
    };
    const operation: SqlOperation = {
      kind: "run",
      sql: `INSERT INTO audit_events(
        event_id, occurred_at, category, action, outcome, actor_json, subject_json,
        details_json, canonical_json, content_sha256, signature, previous_sha256, retention_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        (SELECT content_sha256 FROM audit_events ORDER BY sequence DESC LIMIT 1), ?)`,
      parameters: [
        event.eventId,
        event.occurredAt,
        event.category,
        event.action,
        event.outcome,
        stableJson(event.actor),
        stableJson(event.correlation),
        canonical,
        canonical,
        payloadHash,
        signature,
        event.category === "execution" ? "request-30d" : "security-180d",
      ],
    };
    return { event, operation };
  }

  async append(input: AuditInput): Promise<PreparedAuditEvent["event"]> {
    const prepared = this.prepare(input);
    await this.#database.run(
      prepared.operation.sql,
      prepared.operation.parameters,
    );
    return prepared.event;
  }

  async list(
    limit = 100,
    beforeSequence?: number,
  ): Promise<Record<string, unknown>[]> {
    const bounded = Math.max(1, Math.min(limit, 500));
    const clause = beforeSequence === undefined ? "" : "WHERE sequence < ?";
    const parameters =
      beforeSequence === undefined ? [bounded] : [beforeSequence, bounded];
    return this.#database.all(
      `SELECT sequence, canonical_json, content_sha256, signature, previous_sha256
       FROM audit_events ${clause} ORDER BY sequence DESC LIMIT ?`,
      parameters,
    );
  }

  async listEvents(
    limit = 100,
    cursor?: string,
  ): Promise<{ events: AuditEventV1[]; nextCursor?: string }> {
    if (cursor !== undefined && !/^[1-9][0-9]*$/u.test(cursor)) {
      throw new TypeError("Audit cursor is invalid");
    }
    const bounded = Math.max(1, Math.min(limit, 1_000));
    const beforeSequence = cursor === undefined ? undefined : Number(cursor);
    if (
      beforeSequence !== undefined &&
      (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)
    ) {
      throw new TypeError("Audit cursor is outside the supported range");
    }
    const clause = beforeSequence === undefined ? "" : "WHERE sequence < ?";
    const parameters =
      beforeSequence === undefined ? [bounded] : [beforeSequence, bounded];
    const rows = await this.#database.all<{
      canonical_json: string;
      content_sha256: string;
      sequence: number;
      signature: string;
    }>(
      `SELECT sequence, canonical_json, content_sha256, signature
       FROM audit_events ${clause} ORDER BY sequence DESC LIMIT ?`,
      parameters,
    );
    const events = rows.map((row) =>
      AuditEventV1Schema.parse({
        ...(JSON.parse(row.canonical_json) as Record<string, unknown>),
        integrity: {
          keyId: this.#keyId,
          payloadHash: row.content_sha256,
          signature: row.signature,
        },
      }),
    );
    const next = rows.length === bounded ? rows.at(-1)?.sequence : undefined;
    return {
      events,
      ...(next === undefined ? {} : { nextCursor: String(next) }),
    };
  }
}
