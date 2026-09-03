import { auditInsertStatement, buildAuditEvent } from "./audit";
import { AuthSecurityRepository } from "./auth-security-repository";
import {
  assertAdminPassword,
  assertAdminUsername,
  type AdminAuthRow,
  type AuthSecrets,
  type AuthSessionRow,
  type AuthSessionSummary,
  type BootstrapInput,
  type LoginInput,
  type LoginResult,
  type TokenPair,
} from "./auth-types";
import {
  constantTimeTextEqual,
  hmacSha256Hex,
  randomToken,
  sha256Hex,
} from "./crypto";
import type { AccessPrincipal } from "./types";

const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

export class AuthSessionRepository {
  protected readonly security: AuthSecurityRepository;

  constructor(
    protected readonly database: D1Database,
    protected readonly secrets: AuthSecrets,
  ) {
    this.security = new AuthSecurityRepository(database, secrets);
  }

  async bootstrap(input: BootstrapInput): Promise<TokenPair> {
    if (
      !(await constantTimeTextEqual(
        input.bootstrapSecret,
        this.secrets.bootstrapSecret,
      ))
    )
      throw new Error("invalid_bootstrap_token");
    if (await this.database.prepare("SELECT id FROM admins LIMIT 1").first())
      throw new Error("already_initialized");
    assertAdminUsername(input.username);
    assertAdminPassword(input.password);
    const now = new Date();
    const admin: AdminAuthRow = {
      id: crypto.randomUUID(),
      username: input.username,
      password_hash: await this.security.hashPassword(input.password),
      pending_totp_secret: null,
      pending_totp_expires_at: null,
      totp_secret: null,
      totp_enabled: 0,
    };
    const issuance = await this.prepareNewSession(admin, undefined, now);
    const audit = await this.audit({
      occurredAt: now.toISOString(),
      category: "account",
      action: "account.bootstrap",
      outcome: "success",
      severity: "warning",
      actor: { type: "anonymous" },
      correlation: {},
    });
    try {
      await this.database.batch([
        this.database
          .prepare(
            "INSERT INTO admins (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(
            admin.id,
            admin.username,
            admin.password_hash,
            now.toISOString(),
            now.toISOString(),
          ),
        this.database
          .prepare(
            "UPDATE instance_state SET initialized_at = ? WHERE singleton = 1",
          )
          .bind(now.toISOString()),
        ...issuance.statements,
        audit,
      ]);
    } catch (error) {
      if (await this.database.prepare("SELECT id FROM admins LIMIT 1").first())
        throw new Error("already_initialized");
      throw error;
    }
    return issuance.pair;
  }

  async login(input: LoginInput): Promise<LoginResult> {
    assertAdminUsername(input.username);
    const admin = await this.database
      .prepare("SELECT * FROM admins WHERE username = ? COLLATE NOCASE")
      .bind(input.username)
      .first<AdminAuthRow>();
    if (await this.security.isLoginLocked(admin?.username)) {
      await this.security.recordLogin("denied", admin?.id, "account_locked");
      return { ok: false, code: "account_locked" };
    }
    const passwordAccepted = await this.security.passwordMatches(
      input.password,
      admin?.password_hash,
    );
    if (!admin || !passwordAccepted) {
      await this.security.recordLoginFailure(admin?.username, admin?.id);
      await this.security.recordLogin(
        "denied",
        undefined,
        "invalid_credentials",
      );
      return { ok: false, code: "invalid_credentials" };
    }
    const secondFactorFailure = await this.security.secondFactorFailure(
      admin,
      input,
    );
    if (secondFactorFailure) {
      if (secondFactorFailure === "invalid_totp") {
        await this.security.recordLoginFailure(admin.username, admin.id);
        await this.security.recordLogin("denied", admin.id, "invalid_totp");
      }
      return { ok: false, code: secondFactorFailure };
    }
    const issuance = await this.prepareNewSession(
      admin,
      input.fingerprint,
      new Date(),
    );
    await this.database.batch([
      this.database
        .prepare(
          "DELETE FROM auth_login_state WHERE username = ? COLLATE NOCASE",
        )
        .bind(admin.username),
      ...issuance.statements,
      await this.security.loginAudit("success", admin.id),
    ]);
    return { ok: true, pair: issuance.pair };
  }

  async refresh(refreshToken: string): Promise<TokenPair | null> {
    const initialHash = await sha256Hex(refreshToken);
    const session = await this.database
      .prepare("SELECT * FROM auth_sessions WHERE refresh_token_hash = ?")
      .bind(initialHash)
      .first<AuthSessionRow>();
    if (!session) {
      await this.revokeReusedRefreshFamily(initialHash);
      return null;
    }
    if (session.revoked_at || Date.parse(session.expires_at) <= Date.now())
      return null;
    const admin = await this.database
      .prepare("SELECT * FROM admins WHERE id = ?")
      .bind(session.admin_id)
      .first<AdminAuthRow>();
    if (!admin) return null;
    const now = new Date();
    const rotation = await this.prepareSessionRotation(
      session,
      admin,
      initialHash,
      now,
    );
    try {
      const results = await this.database.batch([
        ...rotation.statements,
        await this.audit({
          occurredAt: now.toISOString(),
          category: "auth",
          action: "token.refresh",
          outcome: "success",
          severity: "info",
          actor: { type: "admin", actorId: admin.id },
          correlation: {},
        }),
      ]);
      if (results[1]?.meta.changes !== 1) {
        await this.revokeReusedRefreshFamily(initialHash);
        return null;
      }
      return rotation.pair;
    } catch (error) {
      if (await this.revokeReusedRefreshFamily(initialHash)) return null;
      throw error;
    }
  }

  async verifyAccess(accessToken: string): Promise<AccessPrincipal | null> {
    const row = await this.database
      .prepare(
        `SELECT a.admin_id, a.session_id, a.expires_at, a.revoked_at,
                s.expires_at AS session_expires_at, s.revoked_at AS session_revoked,
                s.last_used_at, u.username FROM access_tokens a
         JOIN auth_sessions s ON s.id = a.session_id
         JOIN admins u ON u.id = a.admin_id WHERE a.token_hash = ?`,
      )
      .bind(await sha256Hex(accessToken))
      .first<{
        admin_id: string;
        session_id: string;
        expires_at: string;
        revoked_at: string | null;
        session_expires_at: string;
        session_revoked: string | null;
        last_used_at: string;
        username: string;
      }>();
    if (
      !row ||
      row.revoked_at ||
      row.session_revoked ||
      Date.parse(row.expires_at) <= Date.now() ||
      Date.parse(row.session_expires_at) <= Date.now()
    )
      return null;
    await this.updateLastSeen(row.session_id, row.last_used_at);
    return {
      adminId: row.admin_id,
      sessionId: row.session_id,
      username: row.username,
    };
  }

  async logout(adminId: string, sessionId: string): Promise<string | null> {
    return this.revokeSessionRecord(adminId, sessionId, "auth.logout", "info");
  }

  async listSessions(adminId: string): Promise<AuthSessionSummary[]> {
    const result = await this.database
      .prepare(
        `SELECT id, created_at, last_used_at, expires_at FROM auth_sessions
         WHERE admin_id = ? AND revoked_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC`,
      )
      .bind(adminId, new Date().toISOString())
      .all<{
        id: string;
        created_at: string;
        last_used_at: string;
        expires_at: string;
      }>();
    return result.results.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastSeenAt: row.last_used_at,
      expiresAt: row.expires_at,
    }));
  }

  async revokeSession(
    adminId: string,
    sessionId: string,
  ): Promise<string | null> {
    return this.revokeSessionRecord(
      adminId,
      sessionId,
      "session.revoke",
      "warning",
    );
  }

  private async revokeSessionRecord(
    adminId: string,
    sessionId: string,
    action: string,
    severity: "info" | "warning",
  ): Promise<string | null> {
    const active = await this.database
      .prepare(
        "SELECT id FROM auth_sessions WHERE id = ? AND admin_id = ? AND revoked_at IS NULL",
      )
      .bind(sessionId, adminId)
      .first();
    if (!active) return null;
    const now = new Date().toISOString();
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND admin_id = ? AND revoked_at IS NULL",
        )
        .bind(now, sessionId, adminId),
      this.database
        .prepare(
          "UPDATE access_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
        )
        .bind(now, sessionId),
      await this.audit({
        occurredAt: now,
        category: "auth",
        action,
        outcome: "success",
        severity,
        actor: { type: "admin", actorId: adminId },
        correlation: {},
        change: { changedFields: [`session:${sessionId}`] },
      }),
    ]);
    return now;
  }

  private async prepareNewSession(
    admin: AdminAuthRow,
    fingerprint: string | undefined,
    now: Date,
  ): Promise<{ pair: TokenPair; statements: D1PreparedStatement[] }> {
    const refreshToken = randomToken(32);
    const session: AuthSessionRow = {
      id: crypto.randomUUID(),
      admin_id: admin.id,
      family_id: crypto.randomUUID(),
      refresh_token_hash: await sha256Hex(refreshToken),
      expires_at: new Date(
        now.getTime() + this.secrets.refreshTtlSeconds * 1_000,
      ).toISOString(),
      revoked_at: null,
    };
    const access = await this.prepareAccessPair(
      session,
      admin,
      refreshToken,
      now,
    );
    return {
      pair: access.pair,
      statements: [
        this.database
          .prepare(
            `INSERT INTO auth_sessions
             (id, admin_id, family_id, refresh_token_hash, fingerprint_hash, created_at, last_used_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            session.id,
            admin.id,
            session.family_id,
            session.refresh_token_hash,
            fingerprint
              ? await hmacSha256Hex(this.secrets.pepper, fingerprint)
              : null,
            now.toISOString(),
            now.toISOString(),
            session.expires_at,
          ),
        access.statement,
      ],
    };
  }

  private async prepareSessionRotation(
    session: AuthSessionRow,
    admin: AdminAuthRow,
    initialHash: string,
    now: Date,
  ): Promise<{ pair: TokenPair; statements: D1PreparedStatement[] }> {
    const refreshToken = randomToken(32);
    const access = await this.prepareAccessPair(
      session,
      admin,
      refreshToken,
      now,
    );
    return {
      pair: access.pair,
      statements: [
        this.database
          .prepare(
            "INSERT INTO refresh_token_history (token_hash, session_id, family_id, replaced_at) VALUES (?, ?, ?, ?)",
          )
          .bind(initialHash, session.id, session.family_id, now.toISOString()),
        this.database
          .prepare(
            `UPDATE auth_sessions SET refresh_token_hash = ?, last_used_at = ?
             WHERE id = ? AND refresh_token_hash = ?`,
          )
          .bind(
            await sha256Hex(refreshToken),
            now.toISOString(),
            session.id,
            initialHash,
          ),
        this.database
          .prepare(
            "UPDATE access_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
          )
          .bind(now.toISOString(), session.id),
        access.statement,
      ],
    };
  }

  private async prepareAccessPair(
    session: AuthSessionRow,
    admin: AdminAuthRow,
    refreshToken: string,
    now: Date,
  ): Promise<{ pair: TokenPair; statement: D1PreparedStatement }> {
    const accessToken = randomToken(32);
    const accessExpiresAt = new Date(
      now.getTime() + this.secrets.accessTtlSeconds * 1_000,
    ).toISOString();
    return {
      pair: {
        schemaVersion: 1,
        accessToken,
        accessExpiresAt,
        refreshToken,
        refreshExpiresAt: session.expires_at,
        sessionId: session.id,
      },
      statement: this.database
        .prepare(
          "INSERT INTO access_tokens (token_hash, session_id, admin_id, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(
          await sha256Hex(accessToken),
          session.id,
          admin.id,
          now.toISOString(),
          accessExpiresAt,
        ),
    };
  }

  private async revokeReusedRefreshFamily(tokenHash: string): Promise<boolean> {
    const reused = await this.database
      .prepare(
        `SELECT h.family_id, s.admin_id FROM refresh_token_history h
         JOIN auth_sessions s ON s.id = h.session_id WHERE h.token_hash = ?`,
      )
      .bind(tokenHash)
      .first<{ family_id: string; admin_id: string }>();
    if (!reused) return false;
    const now = new Date().toISOString();
    await this.database.batch([
      this.database
        .prepare(
          "UPDATE auth_sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
        )
        .bind(now, reused.family_id),
      this.database
        .prepare(
          `UPDATE access_tokens SET revoked_at = ? WHERE revoked_at IS NULL
           AND session_id IN (SELECT id FROM auth_sessions WHERE family_id = ?)`,
        )
        .bind(now, reused.family_id),
      await this.audit({
        occurredAt: now,
        category: "security",
        action: "refresh-token.reuse",
        outcome: "denied",
        severity: "critical",
        actor: { type: "admin", actorId: reused.admin_id },
        correlation: {},
        result: {
          source: "relay",
          stage: "authentication",
          code: "refresh_token_reuse",
        },
        change: { changedFields: [`session-family:${reused.family_id}`] },
      }),
    ]);
    return true;
  }

  private async updateLastSeen(
    sessionId: string,
    lastSeenAt: string,
  ): Promise<void> {
    const threshold = new Date(Date.now() - LAST_SEEN_WRITE_INTERVAL_MS);
    if (Date.parse(lastSeenAt) > threshold.getTime()) return;
    await this.database
      .prepare(
        "UPDATE auth_sessions SET last_used_at = ? WHERE id = ? AND last_used_at < ?",
      )
      .bind(new Date().toISOString(), sessionId, threshold.toISOString())
      .run();
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
