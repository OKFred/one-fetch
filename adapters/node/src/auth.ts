import type {
  ChangePasswordResponseV1,
  CreateExecutionTokenRequestV1,
  CreatedExecutionTokenV1,
  ExecutionTokenRecordV1,
  LogoutResponseV1,
  SessionListV1,
  SessionRevokeResponseV1,
  TotpEnableResponseV1,
  TotpPrepareResponseV1,
} from "@one-fetch/protocol";

import type { AuditLedger } from "./audit.js";
import { AdministratorAuthService } from "./auth-administrator.js";
import {
  type AdminSessionIdentity,
  AdminSessionService,
  type IssuedSession,
} from "./auth-sessions.js";
import type { DatabaseClient } from "./database.js";
import {
  type ExecutionCredential,
  ExecutionTokenService,
} from "./execution-tokens.js";
import {
  SecondFactorService,
  type SecondFactorInput,
} from "./second-factor.js";

export { LoginFailure } from "./auth-administrator.js";
export type { LoginFailureCode } from "./auth-administrator.js";
export type { AdminSessionIdentity, IssuedSession } from "./auth-sessions.js";
export type { ExecutionCredential } from "./execution-tokens.js";

export class AuthenticationService {
  readonly executionTokens: ExecutionTokenService;
  readonly secondFactor: SecondFactorService;

  private readonly administrators: AdministratorAuthService;
  private readonly sessions: AdminSessionService;

  constructor(database: DatabaseClient, audit: AuditLedger, pepper: string) {
    this.executionTokens = new ExecutionTokenService(database, audit);
    this.secondFactor = new SecondFactorService(database, audit, pepper);
    this.sessions = new AdminSessionService(database, audit);
    this.administrators = new AdministratorAuthService(
      database,
      audit,
      pepper,
      this.sessions,
      this.secondFactor,
    );
  }

  async ensureBootstrap(): Promise<string | undefined> {
    return this.administrators.ensureBootstrap();
  }

  async bootstrap(
    token: string,
    username: string,
    password: string,
  ): Promise<IssuedSession> {
    return this.administrators.bootstrap(token, username, password);
  }

  async login(
    username: string,
    password: string,
    deviceFingerprint?: string,
    secondFactor: SecondFactorInput = {},
  ): Promise<IssuedSession> {
    return this.administrators.login(
      username,
      password,
      deviceFingerprint,
      secondFactor,
    );
  }

  async refresh(refreshToken: string): Promise<IssuedSession> {
    return this.sessions.refresh(refreshToken);
  }

  async authenticateAdmin(rawToken: string): Promise<string | undefined> {
    return (await this.authenticateAdminSession(rawToken))?.administratorId;
  }

  async authenticateAdminSession(
    rawToken: string,
  ): Promise<AdminSessionIdentity | undefined> {
    return this.sessions.authenticateAdminSession(rawToken);
  }

  async authenticateExecution(
    rawToken: string,
  ): Promise<ExecutionCredential | undefined> {
    return this.executionTokens.authenticate(rawToken);
  }

  async prepareTotp(administratorId: string): Promise<TotpPrepareResponseV1> {
    return this.secondFactor.prepare(administratorId);
  }

  async enableTotp(
    administratorId: string,
    code: string,
  ): Promise<TotpEnableResponseV1 | undefined> {
    return this.secondFactor.enable(administratorId, code);
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
    return this.sessions.logout(rawAccessToken);
  }

  async listSessions(
    administratorId: string,
    currentSessionId: string,
  ): Promise<SessionListV1> {
    return this.sessions.listSessions(administratorId, currentSessionId);
  }

  async revokeSession(
    administratorId: string,
    sessionId: string,
  ): Promise<SessionRevokeResponseV1 | undefined> {
    return this.sessions.revokeSession(administratorId, sessionId);
  }

  async changePassword(
    administratorId: string,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<ChangePasswordResponseV1 | undefined> {
    return this.administrators.changePassword(
      administratorId,
      currentSessionId,
      currentPassword,
      newPassword,
    );
  }
}
