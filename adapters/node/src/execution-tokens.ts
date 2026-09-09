import {
  CreateExecutionTokenRequestV1Schema,
  ExecutionTokenRecordV1Schema,
  type CreateExecutionTokenRequestV1,
  type CreatedExecutionTokenV1,
  type ExecutionQuotaV1,
  type ExecutionTokenRecordV1,
  type TransportV1,
} from "@one-fetch/protocol";

import type { AuditLedger } from "./audit.js";
import { randomId, randomToken, sha256Hex, stableJson } from "./crypto.js";
import type { DatabaseClient } from "./database.js";

const EXECUTION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;

export const DEFAULT_EXECUTION_QUOTA: ExecutionQuotaV1 = {
  requestsPerMinute: 60,
  burst: 10,
  concurrentHttp: 4,
  concurrentTunnels: 2,
  bytesPerDay: 1024 * 1024 * 1024,
};

interface ExecutionTokenRow {
  administrator_id: string | null;
  credential_json: string | null;
  created_at: string;
  expires_at: string;
  id: string;
  origin_policy_json: string;
  revoked_at: string | null;
  scopes_json: string;
}

export interface ExecutionCredential extends ExecutionTokenRecordV1 {
  allowedOrigins: string[];
  allowedPorts: number[];
  scopes: TransportV1[];
}

export class ExecutionTokenNotFoundError extends Error {
  constructor() {
    super("Execution token was not found");
    this.name = "ExecutionTokenNotFoundError";
  }
}

const unique = <Value>(values: readonly Value[]): Value[] => [
  ...new Set(values),
];

const legacyRecord = (row: ExecutionTokenRow): ExecutionTokenRecordV1 => {
  const origins = (
    JSON.parse(row.origin_policy_json) as { allowedOrigins?: string[] }
  ).allowedOrigins;
  const transports = JSON.parse(row.scopes_json) as TransportV1[];
  return ExecutionTokenRecordV1Schema.parse({
    schemaVersion: 1,
    id: row.id,
    name: `Legacy ${row.id}`,
    scope: {
      transports,
      origins: origins ?? [],
      ports: [],
    },
    quota: DEFAULT_EXECUTION_QUOTA,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  });
};

const recordFromRow = (row: ExecutionTokenRow): ExecutionTokenRecordV1 => {
  const stored = row.credential_json
    ? ExecutionTokenRecordV1Schema.parse(JSON.parse(row.credential_json))
    : legacyRecord(row);
  return ExecutionTokenRecordV1Schema.parse({
    ...stored,
    expiresAt: row.expires_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  });
};

export class ExecutionTokenService {
  constructor(
    private readonly database: DatabaseClient,
    private readonly audit: AuditLedger,
  ) {}

  async authenticate(
    rawToken: string,
  ): Promise<ExecutionCredential | undefined> {
    const row = await this.database.get<ExecutionTokenRow>(
      `SELECT administrator_id, credential_json, created_at, expires_at, id,
       origin_policy_json, revoked_at, scopes_json
       FROM auth_tokens WHERE digest = ? AND kind = 'execution'`,
      [sha256Hex(rawToken)],
    );
    if (!row || row.revoked_at || row.expires_at <= new Date().toISOString()) {
      return undefined;
    }
    try {
      const record = recordFromRow(row);
      return {
        ...record,
        allowedOrigins: record.scope.origins,
        allowedPorts: record.scope.ports,
        scopes: record.scope.transports,
      };
    } catch {
      return undefined;
    }
  }

  async create(
    administratorId: string,
    input: CreateExecutionTokenRequestV1,
  ): Promise<CreatedExecutionTokenV1> {
    const request = CreateExecutionTokenRequestV1Schema.parse(input);
    const token = randomToken();
    const id = randomId("exec");
    const createdAt = new Date().toISOString();
    const expiresAt =
      request.expiresAt ??
      new Date(Date.now() + EXECUTION_LIFETIME_MS).toISOString();
    const credential = ExecutionTokenRecordV1Schema.parse({
      schemaVersion: 1,
      id,
      name: request.name,
      scope: {
        transports: unique(request.scope.transports),
        origins: unique(request.scope.origins),
        ports: unique(request.scope.ports),
      },
      quota: request.quota,
      createdAt,
      expiresAt,
    });
    await this.database.transaction([
      {
        kind: "run",
        sql: `INSERT INTO auth_tokens(
          id, administrator_id, kind, digest, scopes_json, origin_policy_json,
          expires_at, created_at, credential_json
        ) VALUES (?, ?, 'execution', ?, ?, ?, ?, ?, ?)`,
        parameters: [
          id,
          administratorId,
          sha256Hex(token),
          stableJson(credential.scope.transports),
          stableJson({ allowedOrigins: credential.scope.origins }),
          expiresAt,
          createdAt,
          stableJson(credential),
        ],
      },
      this.audit.prepare({
        action: "token.execution.create",
        actor: { actorId: administratorId, type: "admin" },
        category: "security",
        correlation: {},
        outcome: "success",
        severity: "warning",
      }).operation,
    ]);
    return { credential, schemaVersion: 1, token };
  }

  async list(): Promise<ExecutionTokenRecordV1[]> {
    const rows = await this.database.all<ExecutionTokenRow>(
      `SELECT administrator_id, credential_json, created_at, expires_at, id,
       origin_policy_json, revoked_at, scopes_json
       FROM auth_tokens WHERE kind = 'execution' ORDER BY created_at DESC`,
    );
    return rows.map(recordFromRow);
  }

  async revoke(
    administratorId: string,
    id: string,
  ): Promise<{ id: string; revokedAt: string; schemaVersion: 1 }> {
    const existing = await this.database.get<ExecutionTokenRow>(
      `SELECT administrator_id, credential_json, created_at, expires_at, id,
       origin_policy_json, revoked_at, scopes_json
       FROM auth_tokens WHERE id = ? AND kind = 'execution'`,
      [id],
    );
    if (!existing) throw new ExecutionTokenNotFoundError();
    const revokedAt = existing.revoked_at ?? new Date().toISOString();
    if (!existing.revoked_at) {
      await this.database.transaction([
        {
          kind: "run",
          sql: "UPDATE auth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
          parameters: [revokedAt, id],
        },
        this.audit.prepare({
          action: "token.execution.revoke",
          actor: { actorId: administratorId, type: "admin" },
          category: "security",
          correlation: {},
          outcome: "success",
          severity: "warning",
        }).operation,
      ]);
    }
    return { id, revokedAt, schemaVersion: 1 };
  }
}
