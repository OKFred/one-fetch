import { DurableObject } from "cloudflare:workers";

import { AuthRepository } from "../auth-repository";
import type {
  AuthSessionSummary,
  BootstrapInput,
  ExecutionTokenCreateInput,
  ExecutionTokenCreated,
  ExecutionTokenSummary,
  LoginInput,
  LoginResult,
  PasswordChangeResult,
  TotpEnableResult,
  TotpPreparation,
  TokenPair,
} from "../auth-types";
import type { AccessPrincipal, ExecutionPrincipal } from "../types";

export class AuthDurableObject extends DurableObject<CloudflareControlEnv> {
  private repository(): AuthRepository {
    return new AuthRepository(this.env.DB, {
      bootstrapSecret: this.env.BOOTSTRAP_SECRET,
      pepper: this.env.INSTANCE_PEPPER,
      encryptionKey: this.env.ENCRYPTION_KEY,
      auditSigningKey: this.env.AUDIT_SIGNING_KEY,
      accessTtlSeconds: parsePositiveInteger(
        this.env.DEFAULT_ACCESS_TTL_SECONDS,
        900,
      ),
      refreshTtlSeconds: parsePositiveInteger(
        this.env.DEFAULT_REFRESH_TTL_SECONDS,
        2_592_000,
      ),
    });
  }

  async bootstrap(
    input: BootstrapInput,
  ): Promise<
    | { ok: true; value: TokenPair }
    | { ok: false; code: "already_initialized" | "invalid_bootstrap_token" }
  > {
    try {
      return { ok: true, value: await this.repository().bootstrap(input) };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "already_initialized" ||
          error.message === "invalid_bootstrap_token")
      ) {
        return { ok: false, code: error.message };
      }
      throw error;
    }
  }

  async login(input: LoginInput): Promise<LoginResult> {
    return this.repository().login(input);
  }

  async refresh(refreshToken: string): Promise<TokenPair | null> {
    return this.repository().refresh(refreshToken);
  }

  async verifyAccess(accessToken: string): Promise<AccessPrincipal | null> {
    return this.repository().verifyAccess(accessToken);
  }

  async logout(adminId: string, sessionId: string): Promise<string | null> {
    return this.repository().logout(adminId, sessionId);
  }

  async listSessions(adminId: string): Promise<AuthSessionSummary[]> {
    return this.repository().listSessions(adminId);
  }

  async revokeSession(
    adminId: string,
    sessionId: string,
  ): Promise<string | null> {
    return this.repository().revokeSession(adminId, sessionId);
  }

  async createExecutionToken(
    input: ExecutionTokenCreateInput,
  ): Promise<ExecutionTokenCreated> {
    return this.repository().createExecutionToken(input);
  }

  async listExecutionTokens(adminId: string): Promise<ExecutionTokenSummary[]> {
    return this.repository().listExecutionTokens(adminId);
  }

  async revokeExecutionToken(
    adminId: string,
    tokenId: string,
  ): Promise<string | null> {
    return this.repository().revokeExecutionToken(adminId, tokenId);
  }

  async verifyExecutionToken(
    token: string,
  ): Promise<ExecutionPrincipal | null> {
    return this.repository().verifyExecutionToken(token);
  }

  async prepareTotp(
    adminId: string,
    username: string,
  ): Promise<TotpPreparation> {
    return this.repository().prepareTotp(adminId, username);
  }

  async enableTotp(
    adminId: string,
    code: string,
  ): Promise<TotpEnableResult | null> {
    return this.repository().enableTotp(adminId, code);
  }

  async changePassword(
    adminId: string,
    currentSessionId: string,
    currentPassword: string,
    nextPassword: string,
  ): Promise<PasswordChangeResult | null> {
    return this.repository().changePassword(
      adminId,
      currentSessionId,
      currentPassword,
      nextPassword,
    );
  }
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
