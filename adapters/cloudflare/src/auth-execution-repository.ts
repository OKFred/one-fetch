import { auditInsertStatement, buildAuditEvent } from "./audit";
import type {
  AuthSecrets,
  ExecutionTokenCreateInput,
  ExecutionTokenCreated,
  ExecutionTokenRow,
  ExecutionTokenSummary,
} from "./auth-types";
import { randomToken, sha256Hex, stableStringify } from "./crypto";
import type { ExecutionPrincipal, QuotaLimits, TokenScope } from "./types";

export class AuthExecutionRepository {
  constructor(
    private readonly database: D1Database,
    private readonly secrets: AuthSecrets,
  ) {}

  async create(
    input: ExecutionTokenCreateInput,
  ): Promise<ExecutionTokenCreated> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const token = randomToken(32);
    await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO execution_tokens
           (id, name, token_hash, scope_json, quota_json, created_by, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          input.name,
          await sha256Hex(token),
          stableStringify(input.scope),
          stableStringify(input.quota),
          input.adminId,
          now,
          input.expiresAt ?? null,
        ),
      await this.audit(
        input.adminId,
        "execution-token.create",
        `execution-token:${id}`,
        now,
      ),
    ]);
    return {
      id,
      name: input.name,
      token,
      scope: input.scope,
      quota: input.quota,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      createdAt: now,
    };
  }

  async list(adminId: string): Promise<ExecutionTokenSummary[]> {
    const result = await this.database
      .prepare(
        `SELECT id, name, scope_json, quota_json, created_at, expires_at, revoked_at
         FROM execution_tokens WHERE created_by = ? ORDER BY created_at DESC`,
      )
      .bind(adminId)
      .all<
        ExecutionTokenRow & {
          created_at: string;
          expires_at: string | null;
          revoked_at: string | null;
        }
      >();
    return result.results.map((row) => ({
      id: row.id,
      name: row.name,
      scope: JSON.parse(row.scope_json) as TokenScope,
      quota: JSON.parse(row.quota_json) as QuotaLimits,
      createdAt: row.created_at,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    }));
  }

  async revoke(adminId: string, tokenId: string): Promise<string | null> {
    const exists = await this.database
      .prepare(
        "SELECT id FROM execution_tokens WHERE id = ? AND created_by = ? AND revoked_at IS NULL",
      )
      .bind(tokenId, adminId)
      .first();
    if (!exists) return null;
    const now = new Date().toISOString();
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE execution_tokens SET revoked_at = ? WHERE id = ? AND created_by = ? AND revoked_at IS NULL",
        )
        .bind(now, tokenId, adminId),
      await this.audit(
        adminId,
        "execution-token.revoke",
        `execution-token:${tokenId}`,
        now,
      ),
    ]);
    return now;
  }

  async verify(token: string): Promise<ExecutionPrincipal | null> {
    const row = await this.database
      .prepare(
        `SELECT id, name, scope_json, quota_json FROM execution_tokens
         WHERE token_hash = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .bind(await sha256Hex(token), new Date().toISOString())
      .first<ExecutionTokenRow>();
    if (!row) return null;
    await this.database
      .prepare("UPDATE execution_tokens SET last_used_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), row.id)
      .run();
    return {
      tokenId: row.id,
      name: row.name,
      scope: JSON.parse(row.scope_json) as TokenScope,
      quota: JSON.parse(row.quota_json) as QuotaLimits,
    };
  }

  private async audit(
    adminId: string,
    action: string,
    changedField: string,
    occurredAt: string,
  ): Promise<D1PreparedStatement> {
    return auditInsertStatement(
      this.database,
      await buildAuditEvent({
        signingKey: this.secrets.auditSigningKey,
        event: {
          occurredAt,
          category: "security",
          action,
          outcome: "success",
          severity: "warning",
          actor: { type: "admin", actorId: adminId },
          correlation: {},
          change: { changedFields: [changedField] },
        },
      }),
    );
  }
}
