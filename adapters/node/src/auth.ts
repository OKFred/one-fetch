import type {
  CreateExecutionTokenRequestV1,
  CreatedExecutionTokenV1,
  ExecutionTokenRecordV1,
  ChangePasswordResponseV1,
  LogoutResponseV1,
  SessionListV1,
  SessionRecordV1,
  SessionRevokeResponseV1,
  SessionTokenPairV1,
} from "@one-fetch/protocol";

import type { AuditLedger } from "./audit.js";
import { randomId, randomToken, sha256Hex, stableJson } from "./crypto.js";
import type { DatabaseClient } from "./database.js";
import type { SqlOperation } from "./database-protocol.js";
import {
  type ExecutionCredential,
  ExecutionTokenService,
} from "./execution-tokens.js";
import { hashPassword, verifyPassword } from "./password.js";

export type { ExecutionCredential } from "./execution-tokens.js";

const ACCESS_LIFETIME_MS = 15 * 60 * 1_000;
const REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const BOOTSTRAP_LIFETIME_MS = 30 * 60 * 1_000;
const MAX_LOGIN_FAILURES = 8;
const LOCKOUT_MS = 15 * 60 * 1_000;

type TokenKind = "access" | "refresh" | "execution";

interface AdministratorRow {
  failed_attempts: number;
  id: string;
  locked_until: string | null;
  password_hash: string;
  username: string;
}

interface TokenRow {
  administrator_id: string | null;
  created_at: string;
  device_fingerprint: string | null;
  digest: string;
  expires_at: string;
  family_id: string | null;
  id: string;
  kind: TokenKind;
  origin_policy_json: string;
  revoked_at: string | null;
  session_id: string | null;
  scopes_json: string;
  used_at: string | null;
}

export type IssuedSession = SessionTokenPairV1;

export interface AdminSessionIdentity {
  administratorId: string;
  sessionId: string;
}

export class AuthenticationService {
  readonly executionTokens: ExecutionTokenService;

  constructor(
    private readonly database: DatabaseClient,
    private readonly audit: AuditLedger,
    private readonly pepper: string,
  ) {
    this.executionTokens = new ExecutionTokenService(database, audit);
  }

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

    const now = new Date().toISOString();
    const administratorId = randomId("admin");
    const passwordHash = await hashPassword(password, this.pepper);
    const issued = this.prepareSession(administratorId);
    const audit = this.audit.prepare({
      action: "account.bootstrap",
      actor: { actorId: administratorId, type: "admin" },
      category: "account",
      correlation: {},
      outcome: "success",
      severity: "warning",
    });
    await this.database.transaction([
      {
        kind: "run",
        sql: `INSERT INTO administrators(
          id, username, password_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
        parameters: [administratorId, username, passwordHash, now, now],
      },
      {
        kind: "run",
        sql: "UPDATE bootstrap_state SET consumed_at = ? WHERE singleton = 1 AND consumed_at IS NULL",
        parameters: [now],
      },
      ...issued.operations,
      audit.operation,
    ]);
    return issued.session;
  }

  async login(
    username: string,
    password: string,
    deviceFingerprint?: string,
  ): Promise<IssuedSession> {
    const administrator = await this.database.get<AdministratorRow>(
      `SELECT id, username, password_hash, failed_attempts, locked_until
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
      throw new Error("Invalid credentials");
    }
    if (
      !(await verifyPassword(
        password,
        this.pepper,
        administrator.password_hash,
      ))
    ) {
      await this.recordLoginFailure(administrator, username, now);
      throw new Error("Invalid credentials");
    }

    const issued = this.prepareSession(
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
    await this.database.transaction([
      {
        kind: "run",
        sql: "UPDATE administrators SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?",
        parameters: [now.toISOString(), administrator.id],
      },
      ...issued.operations,
      audit.operation,
    ]);
    return issued.session;
  }

  async refresh(refreshToken: string): Promise<IssuedSession> {
    const token = await this.findToken(refreshToken);
    if (!token || token.kind !== "refresh" || !token.administrator_id) {
      throw new Error("Refresh token is invalid");
    }
    if (token.revoked_at || token.used_at) {
      if (token.family_id) {
        await this.database.run(
          "UPDATE auth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
          [new Date().toISOString(), token.family_id],
        );
      }
      throw new Error("Refresh token reuse detected");
    }
    if (token.expires_at <= new Date().toISOString())
      throw new Error("Refresh token expired");

    const issued = this.prepareSession(
      token.administrator_id,
      token.family_id ?? undefined,
      token.id,
      token.session_id ?? undefined,
      token.device_fingerprint ?? undefined,
    );
    const now = new Date().toISOString();
    await this.database.transaction([
      {
        kind: "run",
        sql: "UPDATE auth_tokens SET used_at = ?, revoked_at = ? WHERE id = ? AND used_at IS NULL",
        parameters: [now, now, token.id],
      },
      ...issued.operations,
      this.audit.prepare({
        action: "auth.refresh.rotate",
        actor: { actorId: token.administrator_id, type: "admin" },
        category: "auth",
        correlation: {},
        outcome: "success",
        severity: "info",
      }).operation,
    ]);
    return issued.session;
  }

  async authenticateAdmin(rawToken: string): Promise<string | undefined> {
    return (await this.authenticateAdminSession(rawToken))?.administratorId;
  }

  async authenticateAdminSession(
    rawToken: string,
  ): Promise<AdminSessionIdentity | undefined> {
    const token = await this.findToken(rawToken);
    if (
      !token ||
      token.kind !== "access" ||
      !token.administrator_id ||
      !token.session_id ||
      token.revoked_at ||
      token.expires_at <= new Date().toISOString()
    ) {
      return undefined;
    }
    await this.database.run("UPDATE auth_tokens SET used_at = ? WHERE id = ?", [
      new Date().toISOString(),
      token.id,
    ]);
    return {
      administratorId: token.administrator_id,
      sessionId: token.session_id,
    };
  }

  async authenticateExecution(
    rawToken: string,
  ): Promise<ExecutionCredential | undefined> {
    return this.executionTokens.authenticate(rawToken);
  }

  async createExecutionToken(
    administratorId: string,
    request: CreateExecutionTokenRequestV1,
  ): Promise<CreatedExecutionTokenV1> {
    return this.executionTokens.create(administratorId, request);
  }

  async listExecutionTokens(): Promise<ExecutionTokenRecordV1[]> {
    return this.executionTokens.list();
  }

  async revokeExecutionToken(
    administratorId: string,
    id: string,
  ): Promise<{ id: string; revokedAt: string; schemaVersion: 1 }> {
    return this.executionTokens.revoke(administratorId, id);
  }

  async logout(rawAccessToken: string): Promise<LogoutResponseV1 | undefined> {
    const token = await this.findToken(rawAccessToken);
    if (
      !token ||
      token.kind !== "access" ||
      !token.administrator_id ||
      !token.family_id ||
      token.revoked_at
    ) {
      return undefined;
    }
    const revokedAt = new Date().toISOString();
    await this.database.transaction([
      {
        kind: "run",
        sql: "UPDATE auth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
        parameters: [revokedAt, token.family_id],
      },
      this.audit.prepare({
        action: "auth.logout",
        actor: { actorId: token.administrator_id, type: "admin" },
        category: "auth",
        correlation: {},
        outcome: "success",
        severity: "info",
      }).operation,
    ]);
    return { revokedAt, schemaVersion: 1, sessionId: token.session_id! };
  }

  async listSessions(
    administratorId: string,
    currentSessionId: string,
  ): Promise<SessionListV1> {
    const rows = await this.database.all<{
      created_at: string;
      device_fingerprint: string | null;
      expires_at: string;
      id: string;
      last_seen_at: string;
    }>(
      `SELECT session_id AS id, MIN(created_at) AS created_at,
       MAX(COALESCE(used_at, created_at)) AS last_seen_at,
       MAX(expires_at) AS expires_at,
       MAX(device_fingerprint) AS device_fingerprint
       FROM auth_tokens
       WHERE administrator_id = ? AND kind IN ('access', 'refresh')
         AND session_id IS NOT NULL
         AND (revoked_at IS NULL OR revoked_at > ?)
       GROUP BY session_id ORDER BY created_at DESC`,
      [administratorId, new Date().toISOString()],
    );
    const sessions: SessionRecordV1[] = rows.map((row) => ({
      createdAt: row.created_at,
      current: row.id === currentSessionId,
      expiresAt: row.expires_at,
      id: row.id,
      lastSeenAt: row.last_seen_at,
      schemaVersion: 1,
      ...(row.device_fingerprint
        ? { deviceFingerprint: row.device_fingerprint }
        : {}),
    }));
    return { schemaVersion: 1, sessions };
  }

  async revokeSession(
    administratorId: string,
    sessionId: string,
  ): Promise<SessionRevokeResponseV1 | undefined> {
    const row = await this.database.get(
      `SELECT id FROM auth_tokens
       WHERE administrator_id = ? AND session_id = ?
         AND kind IN ('access', 'refresh') LIMIT 1`,
      [administratorId, sessionId],
    );
    if (!row) return undefined;
    const revokedAt = new Date().toISOString();
    await this.database.transaction([
      {
        kind: "run",
        sql: "UPDATE auth_tokens SET revoked_at = ? WHERE administrator_id = ? AND session_id = ? AND revoked_at IS NULL",
        parameters: [revokedAt, administratorId, sessionId],
      },
      this.audit.prepare({
        action: "auth.session.revoke",
        actor: { actorId: administratorId, type: "admin" },
        category: "auth",
        correlation: {},
        outcome: "success",
        severity: "warning",
      }).operation,
    ]);
    return { revokedAt, schemaVersion: 1, sessionId };
  }

  async changePassword(
    administratorId: string,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<ChangePasswordResponseV1 | undefined> {
    const administrator = await this.database.get<AdministratorRow>(
      `SELECT id, username, password_hash, failed_attempts, locked_until
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
    await this.database.transaction([
      {
        kind: "run",
        sql: "UPDATE administrators SET password_hash = ?, updated_at = ? WHERE id = ?",
        parameters: [passwordHash, changedAt, administratorId],
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
    return {
      changedAt,
      revokedSessionIds: otherSessions.map((row) => row.session_id),
      schemaVersion: 1,
    };
  }

  private async findToken(rawToken: string): Promise<TokenRow | undefined> {
    return this.database.get<TokenRow>(
      `SELECT id, administrator_id, created_at, device_fingerprint, kind, digest,
       family_id, scopes_json, origin_policy_json, expires_at, revoked_at,
       session_id, used_at
       FROM auth_tokens WHERE digest = ?`,
      [sha256Hex(rawToken)],
    );
  }

  private prepareSession(
    administratorId: string,
    previousFamilyId?: string,
    parentId?: string,
    previousSessionId?: string,
    deviceFingerprint?: string,
  ): { operations: SqlOperation[]; session: IssuedSession } {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const familyId = previousFamilyId ?? randomId("family");
    const sessionId = previousSessionId ?? randomId("session");
    const accessExpiresAt = new Date(
      Date.now() + ACCESS_LIFETIME_MS,
    ).toISOString();
    const refreshExpiresAt = new Date(
      Date.now() + REFRESH_LIFETIME_MS,
    ).toISOString();
    return {
      operations: [
        this.tokenOperation({
          administratorId,
          expiresAt: accessExpiresAt,
          familyId,
          deviceFingerprint,
          id: randomId("access"),
          kind: "access",
          originPolicy: {},
          parentId,
          sessionId,
          scopes: ["admin"],
          token: accessToken,
        }),
        this.tokenOperation({
          administratorId,
          expiresAt: refreshExpiresAt,
          familyId,
          deviceFingerprint,
          id: randomId("refresh"),
          kind: "refresh",
          originPolicy: {},
          parentId,
          sessionId,
          scopes: ["refresh"],
          token: refreshToken,
        }),
      ],
      session: {
        accessExpiresAt,
        accessToken,
        refreshExpiresAt,
        refreshToken,
        schemaVersion: 1,
        sessionId,
      },
    };
  }

  private tokenOperation(input: {
    administratorId: string;
    deviceFingerprint: string | undefined;
    expiresAt: string;
    familyId: string | undefined;
    id: string;
    kind: TokenKind;
    originPolicy: object;
    parentId: string | undefined;
    sessionId: string;
    scopes: string[];
    token: string;
  }): SqlOperation {
    return {
      kind: "run",
      sql: `INSERT INTO auth_tokens(
        id, administrator_id, kind, digest, family_id, parent_id, scopes_json,
        origin_policy_json, expires_at, created_at, session_id,
        device_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      parameters: [
        input.id,
        input.administratorId,
        input.kind,
        sha256Hex(input.token),
        input.familyId ?? null,
        input.parentId ?? null,
        stableJson(input.scopes),
        stableJson(input.originPolicy),
        input.expiresAt,
        new Date().toISOString(),
        input.sessionId,
        input.deviceFingerprint ?? null,
      ],
    };
  }

  private async recordLoginFailure(
    administrator: AdministratorRow | undefined,
    username: string,
    now: Date,
  ): Promise<void> {
    const operations: SqlOperation[] = [];
    if (administrator) {
      const failures = administrator.failed_attempts + 1;
      const lockedUntil =
        failures >= MAX_LOGIN_FAILURES
          ? new Date(now.getTime() + LOCKOUT_MS).toISOString()
          : null;
      operations.push({
        kind: "run",
        sql: "UPDATE administrators SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?",
        parameters: [
          failures,
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
