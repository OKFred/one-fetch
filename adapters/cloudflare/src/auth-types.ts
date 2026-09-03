import type { QuotaLimits, TokenScope } from "./types";

export interface BootstrapInput {
  bootstrapSecret: string;
  username: string;
  password: string;
}

export interface LoginInput {
  username: string;
  password: string;
  totpCode?: string;
  recoveryCode?: string;
  fingerprint?: string;
}

export interface TokenPair {
  schemaVersion: 1;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  sessionId: string;
}

export interface ExecutionTokenCreateInput {
  adminId: string;
  name: string;
  scope: TokenScope;
  quota: QuotaLimits;
  expiresAt?: string;
}

export interface ExecutionTokenCreated {
  id: string;
  name: string;
  token: string;
  scope: TokenScope;
  quota: QuotaLimits;
  expiresAt?: string;
  createdAt: string;
}

export type LoginResult =
  | { ok: true; pair: TokenPair }
  | {
      ok: false;
      code:
        | "invalid_credentials"
        | "totp_required"
        | "invalid_totp"
        | "account_locked";
    };
