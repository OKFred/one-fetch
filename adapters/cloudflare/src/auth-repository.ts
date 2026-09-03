import { compare, hash } from "bcryptjs";

import {
  auditInsertStatement,
  buildAuditEvent,
  type AuditWriteInput,
} from "./audit";
import type {
  BootstrapInput,
  ExecutionTokenCreateInput,
  ExecutionTokenCreated,
  LoginInput,
  LoginResult,
  TokenPair,
} from "./auth-types";
import {
  constantTimeTextEqual,
  decryptSecret,
  encryptSecret,
  hmacSha256Hex,
  randomToken,
  sha256Hex,
  stableStringify,
} from "./crypto";
import {
  createRecoveryCodes,
  createTotpSecret,
  hashRecoveryCode,
  verifyTotp,
} from "./totp";
import type {
  AccessPrincipal,
  ExecutionPrincipal,
  QuotaLimits,
  TokenScope,
} from "./types";

const DUMMY_PASSWORD_HASH =
  "$2b$12$0Ms4AvYQl341nr2/G.xG4OWmpany0ADQNr5HhHuHPCnk3c9ehZ7WS";

interface AdminRow {
  id: string;
  username: string;
  password_hash: string;
  pending_totp_secret: string | null;
  totp_secret: string | null;
  totp_enabled: number;
}

interface SessionRow {
  id: string;
  admin_id: string;
  family_id: string;
  expires_at: string;
  revoked_at: string | null;
}

interface ExecutionTokenRow {
  id: string;
  name: string;
  scope_json: string;
  quota_json: string;
}

export interface AuthSecrets {
  bootstrapSecret: string;
  pepper: string;
  encryptionKey: string;
  auditSigningKey: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

export class AuthRepository {
  constructor(
    private readonly database: D1Database,
    private readonly secrets: AuthSecrets,
  ) {}

  async bootstrap(
    input: BootstrapInput,
  ): Promise<{ adminId: string; username: string }> {
    if (
      !(await constantTimeTextEqual(
        input.bootstrapSecret,
        this.secrets.bootstrapSecret,
      ))
    )
      throw new Error("invalid_bootstrap_token");
    const existing = await this.database
      .prepare("SELECT id FROM admins LIMIT 1")
      .first<{ id: string }>();
    if (existing) throw new Error("already_initialized");
    validateUsername(input.username);
    validatePassword(input.password);
    const now = new Date().toISOString();
    const adminId = crypto.randomUUID();
    const passwordHash = await this.hashPassword(input.password);
    const audit = await buildAuditEvent({
      signingKey: this.secrets.auditSigningKey,
      event: {
        occurredAt: now,
        category: "account",
        action: "account.bootstrap",
        outcome: "success",
        severity: "warning",
        actor: { type: "anonymous" },
        correlation: {},
      },
    });
    await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO admins (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(adminId, input.username, passwordHash, now, now),
      this.database
        .prepare(
          "UPDATE instance_state SET initialized_at = ? WHERE singleton = 1",
        )
        .bind(now),
      auditInsertStatement(this.database, audit),
    ]);
    return { adminId, username: input.username };
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const lock = await this.database
      .prepare(
        "SELECT locked_until FROM auth_login_state WHERE username = ? COLLATE NOCASE",
      )
      .bind(input.username)
      .first<{ locked_until: string | null }>();
    if (lock?.locked_until && Date.parse(lock.locked_until) > Date.now()) {
      await this.recordLogin("denied", undefined, "account_locked");
      return { ok: false, code: "account_locked" };
    }
    const admin = await this.database
      .prepare("SELECT * FROM admins WHERE username = ? COLLATE NOCASE")
      .bind(input.username)
      .first<AdminRow>();
    const passwordAccepted = await compare(
      await this.prehash(input.password),
      admin?.password_hash ?? DUMMY_PASSWORD_HASH,
    );
    if (!admin || !passwordAccepted) {
      await this.recordLoginFailure(input.username, admin?.id);
      await this.recordLogin("denied", undefined, "invalid_credentials");
      return { ok: false, code: "invalid_credentials" };
    }
    if (admin.totp_enabled === 1) {
      if (!input.totpCode && !input.recoveryCode)
        return { ok: false, code: "totp_required" };
      const accepted = input.totpCode
        ? await this.verifyAdminTotp(admin, input.totpCode)
        : await this.consumeRecoveryCode(admin.id, input.recoveryCode!);
      if (!accepted) {
        await this.recordLoginFailure(input.username, admin.id);
        await this.recordLogin("denied", admin.id, "invalid_totp");
        return { ok: false, code: "invalid_totp" };
      }
    }
    await this.database
      .prepare("DELETE FROM auth_login_state WHERE username = ? COLLATE NOCASE")
      .bind(input.username)
      .run();
    const pair = await this.issueSession(admin, input.fingerprint);
    await this.recordLogin("success", admin.id);
    return { ok: true, pair };
  }

  async refresh(refreshToken: string): Promise<TokenPair | null> {
    const tokenHash = await sha256Hex(refreshToken);
    const session = await this.database
      .prepare("SELECT * FROM auth_sessions WHERE refresh_token_hash = ?")
      .bind(tokenHash)
      .first<SessionRow>();
    if (!session) {
      const reused = await this.database
        .prepare(
          "SELECT family_id FROM refresh_token_history WHERE token_hash = ?",
        )
        .bind(tokenHash)
        .first<{ family_id: string }>();
      if (reused) {
        await this.database
          .prepare(
            "UPDATE auth_sessions SET revoked_at = ? WHERE family_id = ?",
          )
          .bind(new Date().toISOString(), reused.family_id)
          .run();
      }
      return null;
    }
    if (session.revoked_at || Date.parse(session.expires_at) <= Date.now())
      return null;
    const admin = await this.database
      .prepare("SELECT * FROM admins WHERE id = ?")
      .bind(session.admin_id)
      .first<AdminRow>();
    if (!admin) return null;
    const pair = await this.rotateSession(session, admin);
    const event = await this.audit({
      occurredAt: new Date().toISOString(),
      category: "auth",
      action: "token.refresh",
      outcome: "success",
      severity: "info",
      actor: { type: "admin", actorId: admin.id },
      correlation: {},
    });
    await event.run();
    return pair;
  }

  async verifyAccess(accessToken: string): Promise<AccessPrincipal | null> {
    const row = await this.database
      .prepare(
        `SELECT a.admin_id, a.session_id, a.expires_at, a.revoked_at, s.revoked_at AS session_revoked, u.username
         FROM access_tokens a
         JOIN auth_sessions s ON s.id = a.session_id
         JOIN admins u ON u.id = a.admin_id
         WHERE a.token_hash = ?`,
      )
      .bind(await sha256Hex(accessToken))
      .first<{
        admin_id: string;
        session_id: string;
        expires_at: string;
        revoked_at: string | null;
        session_revoked: string | null;
        username: string;
      }>();
    if (
      !row ||
      row.revoked_at ||
      row.session_revoked ||
      Date.parse(row.expires_at) <= Date.now()
    )
      return null;
    return {
      adminId: row.admin_id,
      sessionId: row.session_id,
      username: row.username,
    };
  }

  async logout(adminId: string, sessionId: string): Promise<void> {
    const now = new Date().toISOString();
    const audit = await this.audit({
      occurredAt: now,
      category: "auth",
      action: "auth.logout",
      outcome: "success",
      severity: "info",
      actor: { type: "admin", actorId: adminId },
      correlation: {},
    });
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .bind(now, sessionId),
      this.database
        .prepare(
          "UPDATE access_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
        )
        .bind(now, sessionId),
      audit,
    ]);
  }

  async listSessions(adminId: string): Promise<Record<string, unknown>[]> {
    const result = await this.database
      .prepare(
        "SELECT id, created_at, last_used_at, expires_at, revoked_at, fingerprint_hash FROM auth_sessions WHERE admin_id = ? ORDER BY created_at DESC",
      )
      .bind(adminId)
      .all<Record<string, unknown>>();
    return result.results;
  }

  async revokeSession(adminId: string, sessionId: string): Promise<boolean> {
    const exists = await this.database
      .prepare(
        "SELECT id FROM auth_sessions WHERE id = ? AND admin_id = ? AND revoked_at IS NULL",
      )
      .bind(sessionId, adminId)
      .first();
    if (!exists) return false;
    const now = new Date().toISOString();
    const audit = await this.audit({
      occurredAt: now,
      category: "auth",
      action: "session.revoke",
      outcome: "success",
      severity: "warning",
      actor: { type: "admin", actorId: adminId },
      correlation: {},
      change: { changedFields: ["session"] },
    });
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND admin_id = ? AND revoked_at IS NULL",
        )
        .bind(now, sessionId, adminId),
      this.database
        .prepare("UPDATE access_tokens SET revoked_at = ? WHERE session_id = ?")
        .bind(now, sessionId),
      audit,
    ]);
    return true;
  }

  async createExecutionToken(
    input: ExecutionTokenCreateInput,
  ): Promise<ExecutionTokenCreated> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const token = randomToken(32);
    const audit = await this.audit({
      occurredAt: now,
      category: "security",
      action: "execution-token.create",
      outcome: "success",
      severity: "warning",
      actor: { type: "admin", actorId: input.adminId },
      correlation: {},
      change: { changedFields: ["execution-token"] },
    });
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
      audit,
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

  async listExecutionTokens(
    adminId: string,
  ): Promise<Record<string, unknown>[]> {
    const result = await this.database
      .prepare(
        `SELECT id, name, scope_json, quota_json, created_at, last_used_at, expires_at, revoked_at
         FROM execution_tokens WHERE created_by = ? ORDER BY created_at DESC`,
      )
      .bind(adminId)
      .all<Record<string, unknown>>();
    return result.results.map((row) => ({
      ...row,
      scope: JSON.parse(String(row.scope_json)) as unknown,
      quota: JSON.parse(String(row.quota_json)) as unknown,
      scope_json: undefined,
      quota_json: undefined,
    }));
  }

  async revokeExecutionToken(
    adminId: string,
    tokenId: string,
  ): Promise<boolean> {
    const exists = await this.database
      .prepare(
        "SELECT id FROM execution_tokens WHERE id = ? AND created_by = ? AND revoked_at IS NULL",
      )
      .bind(tokenId, adminId)
      .first();
    if (!exists) return false;
    const now = new Date().toISOString();
    const audit = await this.audit({
      occurredAt: now,
      category: "security",
      action: "execution-token.revoke",
      outcome: "success",
      severity: "warning",
      actor: { type: "admin", actorId: adminId },
      correlation: {},
      change: { changedFields: ["execution-token"] },
    });
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE execution_tokens SET revoked_at = ? WHERE id = ? AND created_by = ? AND revoked_at IS NULL",
        )
        .bind(now, tokenId, adminId),
      audit,
    ]);
    return true;
  }

  async verifyExecutionToken(
    token: string,
  ): Promise<ExecutionPrincipal | null> {
    const row = await this.database
      .prepare(
        `SELECT id, name, scope_json, quota_json FROM execution_tokens
         WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
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

  async prepareTotp(
    adminId: string,
    username: string,
  ): Promise<{ secret: string; uri: string; recoveryCodes: string[] }> {
    const secret = createTotpSecret();
    const recoveryCodes = createRecoveryCodes();
    const encrypted = await encryptSecret(secret, this.secrets.encryptionKey);
    const now = new Date().toISOString();
    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          "UPDATE admins SET pending_totp_secret = ?, updated_at = ? WHERE id = ?",
        )
        .bind(encrypted, now, adminId),
      this.database
        .prepare(
          "DELETE FROM recovery_codes WHERE admin_id = ? AND used_at IS NULL",
        )
        .bind(adminId),
    ];
    for (const code of recoveryCodes) {
      statements.push(
        this.database
          .prepare(
            "INSERT INTO recovery_codes (id, admin_id, code_hash, created_at) VALUES (?, ?, ?, ?)",
          )
          .bind(
            crypto.randomUUID(),
            adminId,
            await hashRecoveryCode(code, this.secrets.pepper),
            now,
          ),
      );
    }
    statements.push(
      await this.audit({
        occurredAt: now,
        category: "security",
        action: "totp.prepare",
        outcome: "success",
        severity: "warning",
        actor: { type: "admin", actorId: adminId },
        correlation: {},
        change: { changedFields: ["totp", "recovery-codes"] },
      }),
    );
    await this.database.batch(statements);
    return {
      secret,
      uri: `otpauth://totp/${encodeURIComponent(`one-fetch:${username}`)}?secret=${secret}&issuer=one-fetch&algorithm=SHA1&digits=6&period=30`,
      recoveryCodes,
    };
  }

  async enableTotp(adminId: string, code: string): Promise<boolean> {
    const admin = await this.database
      .prepare("SELECT * FROM admins WHERE id = ?")
      .bind(adminId)
      .first<AdminRow>();
    if (!admin?.pending_totp_secret) return false;
    const secret = await decryptSecret(
      admin.pending_totp_secret,
      this.secrets.encryptionKey,
    );
    if (!(await verifyTotp(secret, code))) return false;
    const now = new Date().toISOString();
    const audit = await this.audit({
      occurredAt: now,
      category: "security",
      action: "totp.enable",
      outcome: "success",
      severity: "warning",
      actor: { type: "admin", actorId: adminId },
      correlation: {},
      change: { changedFields: ["totp"] },
    });
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE admins SET totp_secret = pending_totp_secret, pending_totp_secret = NULL, totp_enabled = 1, updated_at = ? WHERE id = ?",
        )
        .bind(now, adminId),
      audit,
    ]);
    return true;
  }

  async changePassword(
    adminId: string,
    currentPassword: string,
    nextPassword: string,
  ): Promise<boolean> {
    validatePassword(nextPassword);
    const admin = await this.database
      .prepare("SELECT * FROM admins WHERE id = ?")
      .bind(adminId)
      .first<AdminRow>();
    if (
      !admin ||
      !(await compare(await this.prehash(currentPassword), admin.password_hash))
    )
      return false;
    const now = new Date().toISOString();
    const audit = await this.audit({
      occurredAt: now,
      category: "security",
      action: "password.change",
      outcome: "success",
      severity: "warning",
      actor: { type: "admin", actorId: adminId },
      correlation: {},
      change: { changedFields: ["password", "sessions"] },
    });
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?",
        )
        .bind(await this.hashPassword(nextPassword), now, adminId),
      this.database
        .prepare(
          "UPDATE auth_sessions SET revoked_at = ? WHERE admin_id = ? AND revoked_at IS NULL",
        )
        .bind(now, adminId),
      this.database
        .prepare(
          "UPDATE access_tokens SET revoked_at = ? WHERE admin_id = ? AND revoked_at IS NULL",
        )
        .bind(now, adminId),
      audit,
    ]);
    return true;
  }

  private async issueSession(
    admin: AdminRow,
    fingerprint?: string,
  ): Promise<TokenPair> {
    const now = new Date();
    const session: SessionRow = {
      id: crypto.randomUUID(),
      admin_id: admin.id,
      family_id: crypto.randomUUID(),
      expires_at: new Date(
        now.getTime() + this.secrets.refreshTtlSeconds * 1_000,
      ).toISOString(),
      revoked_at: null,
    };
    const refreshToken = randomToken(32);
    await this.database
      .prepare(
        `INSERT INTO auth_sessions
         (id, admin_id, family_id, refresh_token_hash, fingerprint_hash, created_at, last_used_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        session.id,
        admin.id,
        session.family_id,
        await sha256Hex(refreshToken),
        fingerprint
          ? await hmacSha256Hex(this.secrets.pepper, fingerprint)
          : null,
        now.toISOString(),
        now.toISOString(),
        session.expires_at,
      )
      .run();
    return this.issueAccessPair(session, admin, refreshToken, now);
  }

  private async rotateSession(
    session: SessionRow,
    admin: AdminRow,
  ): Promise<TokenPair> {
    const now = new Date();
    const refreshToken = randomToken(32);
    const previous = await this.database
      .prepare("SELECT refresh_token_hash FROM auth_sessions WHERE id = ?")
      .bind(session.id)
      .first<{ refresh_token_hash: string }>();
    if (!previous) throw new Error("session_not_found");
    await this.database.batch([
      this.database
        .prepare(
          "INSERT INTO refresh_token_history (token_hash, session_id, family_id, replaced_at) VALUES (?, ?, ?, ?)",
        )
        .bind(
          previous.refresh_token_hash,
          session.id,
          session.family_id,
          now.toISOString(),
        ),
      this.database
        .prepare(
          "UPDATE auth_sessions SET refresh_token_hash = ?, last_used_at = ? WHERE id = ?",
        )
        .bind(await sha256Hex(refreshToken), now.toISOString(), session.id),
      this.database
        .prepare(
          "UPDATE access_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
        )
        .bind(now.toISOString(), session.id),
    ]);
    return this.issueAccessPair(session, admin, refreshToken, now);
  }

  private async issueAccessPair(
    session: SessionRow,
    admin: AdminRow,
    refreshToken: string,
    now: Date,
  ): Promise<TokenPair> {
    const accessToken = randomToken(32);
    const accessExpiresAt = new Date(
      now.getTime() + this.secrets.accessTtlSeconds * 1_000,
    ).toISOString();
    await this.database
      .prepare(
        "INSERT INTO access_tokens (token_hash, session_id, admin_id, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        await sha256Hex(accessToken),
        session.id,
        admin.id,
        now.toISOString(),
        accessExpiresAt,
      )
      .run();
    return {
      schemaVersion: 1,
      accessToken,
      accessExpiresAt,
      refreshToken,
      refreshExpiresAt: session.expires_at,
      sessionId: session.id,
    };
  }

  private async verifyAdminTotp(
    admin: AdminRow,
    code: string,
  ): Promise<boolean> {
    if (!admin.totp_secret) return false;
    return verifyTotp(
      await decryptSecret(admin.totp_secret, this.secrets.encryptionKey),
      code,
    );
  }

  private async consumeRecoveryCode(
    adminId: string,
    code: string,
  ): Promise<boolean> {
    const codeHash = await hashRecoveryCode(code, this.secrets.pepper);
    const result = await this.database
      .prepare(
        "UPDATE recovery_codes SET used_at = ? WHERE admin_id = ? AND code_hash = ? AND used_at IS NULL",
      )
      .bind(new Date().toISOString(), adminId, codeHash)
      .run();
    return result.meta.changes === 1;
  }

  private async recordLogin(
    outcome: "success" | "denied",
    adminId?: string,
    code?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const event = await buildAuditEvent({
      signingKey: this.secrets.auditSigningKey,
      event: {
        occurredAt: now,
        category: "auth",
        action: "auth.login",
        outcome,
        severity: outcome === "success" ? "info" : "warning",
        actor: adminId
          ? { type: "admin", actorId: adminId }
          : { type: "anonymous" },
        correlation: {},
        ...(code
          ? { result: { source: "relay", stage: "authentication", code } }
          : {}),
      },
    });
    await auditInsertStatement(this.database, event).run();
  }

  private async recordLoginFailure(
    username: string,
    adminId?: string,
  ): Promise<void> {
    const now = new Date();
    const current = await this.database
      .prepare(
        "SELECT failure_count, window_started_at FROM auth_login_state WHERE username = ? COLLATE NOCASE",
      )
      .bind(username)
      .first<{ failure_count: number; window_started_at: string }>();
    const inWindow =
      current &&
      now.getTime() - Date.parse(current.window_started_at) < 15 * 60_000;
    const failures = inWindow ? current.failure_count + 1 : 1;
    const lockedUntil =
      failures >= 5
        ? new Date(now.getTime() + 15 * 60_000).toISOString()
        : null;
    const statements = [
      this.database
        .prepare(
          `INSERT INTO auth_login_state (username, failure_count, window_started_at, locked_until) VALUES (?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET failure_count = excluded.failure_count,
           window_started_at = excluded.window_started_at, locked_until = excluded.locked_until`,
        )
        .bind(
          username,
          failures,
          inWindow ? current.window_started_at : now.toISOString(),
          lockedUntil,
        ),
    ];
    if (lockedUntil)
      statements.push(
        await this.audit({
          occurredAt: now.toISOString(),
          category: "security",
          action: "account.locked",
          outcome: "denied",
          severity: "error",
          actor: adminId
            ? { type: "admin", actorId: adminId }
            : { type: "anonymous" },
          correlation: {},
          result: {
            source: "relay",
            stage: "authentication",
            code: "account_locked",
          },
        }),
      );
    await this.database.batch(statements);
  }

  private async audit(
    event: AuditWriteInput["event"],
  ): Promise<D1PreparedStatement> {
    return auditInsertStatement(
      this.database,
      await buildAuditEvent({
        signingKey: this.secrets.auditSigningKey,
        event,
      }),
    );
  }

  private async prehash(password: string): Promise<string> {
    return hmacSha256Hex(this.secrets.pepper, password);
  }

  private async hashPassword(password: string): Promise<string> {
    validatePassword(password);
    return hash(await this.prehash(password), 12);
  }
}

function validateUsername(username: string): void {
  if (!/^[A-Za-z0-9._-]{3,64}$/u.test(username))
    throw new Error("invalid_username");
}

function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 1_024)
    throw new Error("invalid_password");
}
