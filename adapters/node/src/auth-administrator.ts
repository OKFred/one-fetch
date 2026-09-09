import type { ChangePasswordResponseV1 } from "@one-fetch/protocol";

import type { AuditLedger } from "./audit.js";
import type { AdminSessionService, IssuedSession } from "./auth-sessions.js";
import { randomId, randomToken, sha256Hex } from "./crypto.js";
import {
  DatabaseConditionalWriteError,
  type DatabaseClient,
} from "./database.js";
import type { SqlOperation } from "./database-protocol.js";
import { hashPassword, verifyPassword } from "./password.js";
import type {
  SecondFactorInput,
  SecondFactorService,
} from "./second-factor.js";

const BOOTSTRAP_LIFETIME_MS = 30 * 60 * 1_000;
const MAX_LOGIN_FAILURES = 8;
const LOCKOUT_MS = 15 * 60 * 1_000;

interface AdministratorRow {
  failed_attempts: number;
  id: string;
  locked_until: string | null;
  password_hash: string;
  totp_ciphertext: string | null;
  username: string;
}

export type LoginFailureCode =
  | "invalid_credentials"
  | "invalid_totp"
  | "totp_required";

export class LoginFailure extends Error {
  constructor(readonly code: LoginFailureCode) {
    super(code);
    this.name = "LoginFailure";
  }
}

export class AdministratorAuthService {
  constructor(
    private readonly database: DatabaseClient,
    private readonly audit: AuditLedger,
    private readonly pepper: string,
    private readonly sessions: AdminSessionService,
    private readonly secondFactor: SecondFactorService,
  ) {}

  async ensureBootstrap(): Promise<string | undefined> {
    const administrator = await this.database.get(
      "SELECT id FROM administrators LIMIT 1",
    );
    if (administrator) return undefined;
    const active = await this.database.get(
      "SELECT singleton FROM bootstrap_state WHERE singleton = 1 AND consumed_at IS NULL AND expires_at > ?",
      [new Date().toISOString()],
    );
    if (active) return undefined;
    const token = randomToken();
    const expiresAt = new Date(
      Date.now() + BOOTSTRAP_LIFETIME_MS,
    ).toISOString();
    await this.database.run(
      `INSERT INTO bootstrap_state(singleton, token_digest, expires_at, consumed_at)
       VALUES (1, ?, ?, NULL)
       ON CONFLICT(singleton) DO UPDATE SET
         token_digest = excluded.token_digest, expires_at = excluded.expires_at, consumed_at = NULL`,
      [sha256Hex(token), expiresAt],
    );
    return token;
  }

  async bootstrap(
    token: string,
    username: string,
    password: string,
  ): Promise<IssuedSession> {
    if (!/^[A-Za-z0-9._-]{3,64}$/u.test(username))
      throw new Error("Username format is invalid");
    const state = await this.database.get<{
      consumed_at: string | null;
      expires_at: string;
      token_digest: string;
    }>(
      "SELECT token_digest, expires_at, consumed_at FROM bootstrap_state WHERE singleton = 1",
    );
    if (
      !state ||
      state.consumed_at !== null ||
      state.expires_at <= new Date().toISOString() ||
      sha256Hex(token) !== state.token_digest
    ) {
      throw new Error("Bootstrap token is invalid or expired");
    }
    const existing = await this.database.get(
      "SELECT id FROM administrators LIMIT 1",
    );
    if (existing) throw new Error("Instance is already bootstrapped");

    const tokenDigest = sha256Hex(token);
    const administratorId = randomId("admin");
    const passwordHash = await hashPassword(password, this.pepper);
    const now = new Date().toISOString();
    const issued = this.sessions.prepareSession(administratorId);
    const audit = this.audit.prepare({
      action: "account.bootstrap",
      actor: { actorId: administratorId, type: "admin" },
      category: "account",
      correlation: {},
      outcome: "success",
      severity: "warning",
    });
    try {
      await this.database.transaction([
        {
          expectedChanges: 1,
          kind: "run",
          sql: `UPDATE bootstrap_state SET consumed_at = ?
                WHERE singleton = 1 AND token_digest = ?
                  AND consumed_at IS NULL AND expires_at > ?`,
          parameters: [now, tokenDigest, now],
        },
        {
          kind: "run",
          sql: `INSERT INTO administrators(
            id, username, password_hash, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?)`,
          parameters: [administratorId, username, passwordHash, now, now],
        },
        ...issued.operations,
        audit.operation,
      ]);
    } catch (error) {
      if (error instanceof DatabaseConditionalWriteError) {
        throw new Error("Bootstrap token is invalid or expired");
      }
      throw error;
    }
    return issued.session;
  }

  async login(
    username: string,
    password: string,
    deviceFingerprint?: string,
    secondFactor: SecondFactorInput = {},
  ): Promise<IssuedSession> {
    const administrator = await this.database.get<AdministratorRow>(
      `SELECT id, username, password_hash, failed_attempts, locked_until,
       totp_ciphertext
       FROM administrators WHERE username = ?`,
      [username],
    );
    const now = new Date();
    if (
      !administrator ||
      (administrator.locked_until &&
        administrator.locked_until > now.toISOString())
    ) {
      await this.recordLoginFailure(administrator, username, now);
      throw new LoginFailure("invalid_credentials");
    }
    if (
      !(await verifyPassword(
        password,
        this.pepper,
        administrator.password_hash,
      ))
    ) {
      await this.recordLoginFailure(administrator, username, now);
      throw new LoginFailure("invalid_credentials");
    }

    const secondFactorResult = await this.secondFactor.verify(
      administrator.id,
      administrator.totp_ciphertext,
      secondFactor,
    );
    if (secondFactorResult === "required")
      throw new LoginFailure("totp_required");
    if (secondFactorResult === "invalid") {
      await this.recordLoginFailure(administrator, username, now);
      throw new LoginFailure("invalid_totp");
    }

    const issued = this.sessions.prepareSession(
      administrator.id,
      undefined,
      undefined,
      undefined,
      deviceFingerprint,
    );
    const audit = this.audit.prepare({
      action: "auth.login",
      actor: { actorId: administrator.id, type: "admin" },
      category: "auth",
      correlation: {},
      outcome: "success",
      severity: "info",
    });
    try {
      await this.database.transaction([
        {
          expectedChanges: 1,
          kind: "run",
          sql: `UPDATE administrators
                SET failed_attempts = 0, locked_until = NULL, updated_at = ?
                WHERE id = ? AND password_hash = ?
                  AND (locked_until IS NULL OR locked_until <= ?)`,
          parameters: [
            now.toISOString(),
            administrator.id,
            administrator.password_hash,
            now.toISOString(),
          ],
        },
        ...issued.operations,
        audit.operation,
      ]);
    } catch (error) {
      if (error instanceof DatabaseConditionalWriteError) {
        await this.recordLoginFailure(administrator, username, new Date());
        throw new LoginFailure("invalid_credentials");
      }
      throw error;
    }
    return issued.session;
  }

  async changePassword(
    administratorId: string,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<ChangePasswordResponseV1 | undefined> {
    const administrator = await this.database.get<AdministratorRow>(
      `SELECT id, username, password_hash, failed_attempts, locked_until,
       totp_ciphertext
       FROM administrators WHERE id = ?`,
      [administratorId],
    );
    if (
      !administrator ||
      !(await verifyPassword(
        currentPassword,
        this.pepper,
        administrator.password_hash,
      ))
    ) {
      return undefined;
    }
    const otherSessions = await this.database.all<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM auth_tokens
       WHERE administrator_id = ? AND session_id IS NOT NULL
         AND session_id <> ? AND revoked_at IS NULL`,
      [administratorId, currentSessionId],
    );
    const changedAt = new Date().toISOString();
    const passwordHash = await hashPassword(newPassword, this.pepper);
    try {
      await this.database.transaction([
        {
          expectedChanges: 1,
          kind: "run",
          sql: `UPDATE administrators SET password_hash = ?, updated_at = ?
                WHERE id = ? AND password_hash = ?`,
          parameters: [
            passwordHash,
            changedAt,
            administratorId,
            administrator.password_hash,
          ],
        },
        {
          kind: "run",
          sql: "UPDATE auth_tokens SET revoked_at = ? WHERE administrator_id = ? AND session_id <> ? AND revoked_at IS NULL",
          parameters: [changedAt, administratorId, currentSessionId],
        },
        this.audit.prepare({
          action: "auth.password.change",
          actor: { actorId: administratorId, type: "admin" },
          category: "security",
          correlation: {},
          outcome: "success",
          severity: "warning",
        }).operation,
      ]);
    } catch (error) {
      if (error instanceof DatabaseConditionalWriteError) return undefined;
      throw error;
    }
    return {
      changedAt,
      revokedSessionIds: otherSessions.map((row) => row.session_id),
      schemaVersion: 1,
    };
  }

  private async recordLoginFailure(
    administrator: AdministratorRow | undefined,
    username: string,
    now: Date,
  ): Promise<void> {
    const operations: SqlOperation[] = [];
    if (administrator) {
      const lockedUntil = new Date(now.getTime() + LOCKOUT_MS).toISOString();
      operations.push({
        kind: "run",
        sql: `UPDATE administrators
              SET failed_attempts = failed_attempts + 1,
                  locked_until = CASE
                    WHEN locked_until IS NOT NULL AND locked_until > ?
                      THEN locked_until
                    WHEN failed_attempts + 1 >= ? THEN ?
                    ELSE NULL
                  END,
                  updated_at = ?
              WHERE id = ?`,
        parameters: [
          now.toISOString(),
          MAX_LOGIN_FAILURES,
          lockedUntil,
          now.toISOString(),
          administrator.id,
        ],
      });
    }
    operations.push(
      this.audit.prepare({
        action: "auth.login.failure",
        actor: {
          actorId: administrator?.id,
          type: administrator ? "admin" : "anonymous",
        },
        category: "auth",
        correlation: {},
        outcome: "failure",
        severity: "warning",
      }).operation,
    );
    await this.database.transaction(operations);
    void username;
  }
}
