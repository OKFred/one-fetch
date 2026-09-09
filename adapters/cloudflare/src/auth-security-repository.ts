import { compare, hash } from "bcryptjs";

import { auditInsertStatement, buildAuditEvent } from "./audit";
import {
  assertAdminPassword,
  type AdminAuthRow,
  type AuthSecrets,
  type LoginInput,
  type LoginStateRow,
  type PasswordChangeResult,
  type TotpEnableResult,
  type TotpPreparation,
} from "./auth-types";
import { decryptSecret, encryptSecret, hmacSha256Hex } from "./crypto";
import {
  createRecoveryCodes,
  createTotpSecret,
  hashRecoveryCode,
  verifyTotp,
} from "./totp";

const DUMMY_PASSWORD_HASH =
  "$2b$12$0Ms4AvYQl341nr2/G.xG4OWmpany0ADQNr5HhHuHPCnk3c9ehZ7WS";
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_LOCK_MS = 15 * 60_000;
const PENDING_TOTP_TTL_MS = 10 * 60_000;
type PendingTotpAdmin = AdminAuthRow & {
  pending_totp_secret: string;
  pending_totp_expires_at: string;
};

export class AuthSecurityRepository {
  constructor(
    private readonly database: D1Database,
    private readonly secrets: AuthSecrets,
  ) {}

  async passwordMatches(
    password: string,
    hashValue?: string,
  ): Promise<boolean> {
    return compare(
      await hmacSha256Hex(this.secrets.pepper, password),
      hashValue ?? DUMMY_PASSWORD_HASH,
    );
  }

  async hashPassword(password: string): Promise<string> {
    assertAdminPassword(password);
    return hash(await hmacSha256Hex(this.secrets.pepper, password), 12);
  }

  async secondFactorFailure(
    admin: AdminAuthRow,
    input: LoginInput,
  ): Promise<"totp_required" | "invalid_totp" | null> {
    if (admin.totp_enabled !== 1) return null;
    if (!input.totpCode && !input.recoveryCode) return "totp_required";
    const accepted = input.totpCode
      ? await this.verifyAdminTotp(admin, input.totpCode)
      : await this.consumeRecoveryCode(admin.id, input.recoveryCode ?? "");
    return accepted ? null : "invalid_totp";
  }

  async isLoginLocked(username?: string): Promise<boolean> {
    const state = await this.loginState(username);
    return Boolean(
      state?.locked_until && Date.parse(state.locked_until) > Date.now(),
    );
  }

  async recordLoginFailure(
    username: string | undefined,
    adminId?: string,
  ): Promise<void> {
    const now = new Date();
    const current = await this.loginState(username);
    const inWindow =
      current &&
      now.getTime() - Date.parse(current.window_started_at) < LOGIN_WINDOW_MS;
    const failures = inWindow ? current.failure_count + 1 : 1;
    const lockedUntil =
      failures >= 5
        ? new Date(now.getTime() + LOGIN_LOCK_MS).toISOString()
        : null;
    const windowStartedAt = inWindow
      ? current.window_started_at
      : now.toISOString();
    const statement = username
      ? this.database
          .prepare(
            `INSERT INTO auth_login_state (username, failure_count, window_started_at, locked_until) VALUES (?, ?, ?, ?)
             ON CONFLICT(username) DO UPDATE SET failure_count = excluded.failure_count,
               window_started_at = excluded.window_started_at, locked_until = excluded.locked_until`,
          )
          .bind(username, failures, windowStartedAt, lockedUntil)
      : this.database
          .prepare(
            `INSERT INTO auth_unknown_login_state (singleton, failure_count, window_started_at, locked_until)
             VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
               failure_count = excluded.failure_count,
               window_started_at = excluded.window_started_at,
               locked_until = excluded.locked_until`,
          )
          .bind(failures, windowStartedAt, lockedUntil);
    const statements = [statement];
    if (lockedUntil) {
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
    }
    await this.database.batch(statements);
  }

  async recordLogin(
    outcome: "success" | "denied",
    adminId?: string,
    code?: string,
  ): Promise<void> {
    await (await this.loginAudit(outcome, adminId, code)).run();
  }

  async loginAudit(
    outcome: "success" | "denied",
    adminId?: string,
    code?: string,
  ): Promise<D1PreparedStatement> {
    return this.audit({
      occurredAt: new Date().toISOString(),
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
    });
  }

  async prepareTotp(
    adminId: string,
    username: string,
  ): Promise<TotpPreparation> {
    const secret = createTotpSecret();
    const encrypted = await encryptSecret(secret, this.secrets.encryptionKey);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + PENDING_TOTP_TTL_MS).toISOString();
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE admins SET pending_totp_secret = ?, pending_totp_expires_at = ?,
             updated_at = ? WHERE id = ?`,
        )
        .bind(encrypted, expiresAt, now, adminId),
      await this.audit({
        occurredAt: now,
        category: "security",
        action: "totp.prepare",
        outcome: "success",
        severity: "warning",
        actor: { type: "admin", actorId: adminId },
        correlation: {},
        change: { changedFields: ["totp"] },
      }),
    ]);
    return {
      secret,
      otpauthUri: `otpauth://totp/${encodeURIComponent(`one-fetch:${username}`)}?secret=${secret}&issuer=one-fetch&algorithm=SHA1&digits=6&period=30`,
    };
  }

  async enableTotp(
    adminId: string,
    code: string,
  ): Promise<TotpEnableResult | null> {
    const admin = await this.database
      .prepare("SELECT * FROM admins WHERE id = ?")
      .bind(adminId)
      .first<AdminAuthRow>();
    const pending = await this.usablePendingTotp(admin);
    if (!pending) return null;
    const secret = await decryptSecret(
      pending.pending_totp_secret,
      this.secrets.encryptionKey,
    );
    if (!(await verifyTotp(secret, code))) return null;
    const now = new Date().toISOString();
    const recoveryCodes = createRecoveryCodes();
    const statements: D1PreparedStatement[] = [
      this.database
        .prepare(
          `UPDATE admins SET totp_secret = pending_totp_secret,
             pending_totp_secret = NULL, pending_totp_expires_at = NULL,
             totp_enabled = 1, updated_at = ? WHERE id = ?`,
        )
        .bind(now, adminId),
      this.database
        .prepare(
          "DELETE FROM recovery_codes WHERE admin_id = ? AND used_at IS NULL",
        )
        .bind(adminId),
      await this.audit({
        occurredAt: now,
        category: "security",
        action: "totp.enable",
        outcome: "success",
        severity: "warning",
        actor: { type: "admin", actorId: adminId },
        correlation: {},
        change: { changedFields: ["totp"] },
      }),
    ];
    for (const recoveryCode of recoveryCodes) {
      statements.push(
        this.database
          .prepare(
            "INSERT INTO recovery_codes (id, admin_id, code_hash, created_at) VALUES (?, ?, ?, ?)",
          )
          .bind(
            crypto.randomUUID(),
            adminId,
            await hashRecoveryCode(recoveryCode, this.secrets.pepper),
            now,
          ),
      );
    }
    await this.database.batch(statements);
    return { enabledAt: now, recoveryCodes };
  }

  async changePassword(
    adminId: string,
    currentSessionId: string,
    currentPassword: string,
    nextPassword: string,
  ): Promise<PasswordChangeResult | null> {
    assertAdminPassword(nextPassword);
    const admin = await this.database
      .prepare("SELECT * FROM admins WHERE id = ?")
      .bind(adminId)
      .first<AdminAuthRow>();
    if (
      !admin ||
      !(await this.passwordMatches(currentPassword, admin.password_hash))
    )
      return null;
    const now = new Date().toISOString();
    const sessions = await this.database
      .prepare(
        "SELECT id FROM auth_sessions WHERE admin_id = ? AND id <> ? AND revoked_at IS NULL",
      )
      .bind(adminId, currentSessionId)
      .all<{ id: string }>();
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?",
        )
        .bind(await this.hashPassword(nextPassword), now, adminId),
      this.database
        .prepare(
          "UPDATE auth_sessions SET revoked_at = ? WHERE admin_id = ? AND id <> ? AND revoked_at IS NULL",
        )
        .bind(now, adminId, currentSessionId),
      this.database
        .prepare(
          "UPDATE access_tokens SET revoked_at = ? WHERE admin_id = ? AND session_id <> ? AND revoked_at IS NULL",
        )
        .bind(now, adminId, currentSessionId),
      await this.audit({
        occurredAt: now,
        category: "security",
        action: "password.change",
        outcome: "success",
        severity: "warning",
        actor: { type: "admin", actorId: adminId },
        correlation: {},
        change: { changedFields: ["password", "sessions"] },
      }),
    ]);
    return {
      changedAt: now,
      revokedSessionIds: sessions.results.map(({ id }) => id),
    };
  }

  private async usablePendingTotp(
    admin: AdminAuthRow | null,
  ): Promise<PendingTotpAdmin | null> {
    if (
      admin?.pending_totp_secret &&
      admin.pending_totp_expires_at &&
      Date.parse(admin.pending_totp_expires_at) > Date.now()
    )
      return admin as PendingTotpAdmin;
    if (admin?.pending_totp_secret) {
      await this.database
        .prepare(
          "UPDATE admins SET pending_totp_secret = NULL, pending_totp_expires_at = NULL WHERE id = ?",
        )
        .bind(admin.id)
        .run();
    }
    return null;
  }

  private async verifyAdminTotp(
    admin: AdminAuthRow,
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
    const result = await this.database
      .prepare(
        "UPDATE recovery_codes SET used_at = ? WHERE admin_id = ? AND code_hash = ? AND used_at IS NULL",
      )
      .bind(
        new Date().toISOString(),
        adminId,
        await hashRecoveryCode(code, this.secrets.pepper),
      )
      .run();
    return result.meta.changes === 1;
  }

  private async loginState(username?: string): Promise<LoginStateRow | null> {
    const columns = "failure_count, window_started_at, locked_until";
    return username
      ? this.database
          .prepare(
            `SELECT ${columns} FROM auth_login_state WHERE username = ? COLLATE NOCASE`,
          )
          .bind(username)
          .first<LoginStateRow>()
      : this.database
          .prepare(
            `SELECT ${columns} FROM auth_unknown_login_state WHERE singleton = 1`,
          )
          .first<LoginStateRow>();
  }

  private async audit(
    event: Parameters<typeof buildAuditEvent>[0]["event"],
  ): Promise<D1PreparedStatement> {
    return auditInsertStatement(
      this.database,
      await buildAuditEvent({
        signingKey: this.secrets.auditSigningKey,
        event,
      }),
    );
  }
}
