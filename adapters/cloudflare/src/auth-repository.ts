import { AuthExecutionRepository } from "./auth-execution-repository";
import { AuthSessionRepository } from "./auth-session-repository";
import type {
  AuthSecrets,
  ExecutionTokenCreateInput,
  ExecutionTokenCreated,
  ExecutionTokenSummary,
  PasswordChangeResult,
  TotpEnableResult,
  TotpPreparation,
} from "./auth-types";
import type { ExecutionPrincipal } from "./types";

export class AuthRepository extends AuthSessionRepository {
  private readonly execution: AuthExecutionRepository;

  constructor(database: D1Database, secrets: AuthSecrets) {
    super(database, secrets);
    this.execution = new AuthExecutionRepository(database, secrets);
  }

  createExecutionToken(
    input: ExecutionTokenCreateInput,
  ): Promise<ExecutionTokenCreated> {
    return this.execution.create(input);
  }

  listExecutionTokens(adminId: string): Promise<ExecutionTokenSummary[]> {
    return this.execution.list(adminId);
  }

  revokeExecutionToken(
    adminId: string,
    tokenId: string,
  ): Promise<string | null> {
    return this.execution.revoke(adminId, tokenId);
  }

  verifyExecutionToken(token: string): Promise<ExecutionPrincipal | null> {
    return this.execution.verify(token);
  }

  prepareTotp(adminId: string, username: string): Promise<TotpPreparation> {
    return this.security.prepareTotp(adminId, username);
  }

  enableTotp(adminId: string, code: string): Promise<TotpEnableResult | null> {
    return this.security.enableTotp(adminId, code);
  }

  changePassword(
    adminId: string,
    currentSessionId: string,
    currentPassword: string,
    nextPassword: string,
  ): Promise<PasswordChangeResult | null> {
    return this.security.changePassword(
      adminId,
      currentSessionId,
      currentPassword,
      nextPassword,
    );
  }
}

export type { AuthSecrets } from "./auth-types";
