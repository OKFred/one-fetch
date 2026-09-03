import type { QuotaLimits, TokenScope } from "./types";

export const ADMIN_USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/u;

export function assertAdminUsername(username: string): void {
  if (!ADMIN_USERNAME_PATTERN.test(username))
    throw new Error("invalid_username");
}

export function assertAdminPassword(password: string): void {
  if (password.length < 12 || password.length > 1_024)
    throw new Error("invalid_password");
}

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

export interface AdminAuthRow {
  id: string;
  username: string;
  password_hash: string;
  pending_totp_secret: string | null;
  pending_totp_expires_at: string | null;
  totp_secret: string | null;
  totp_enabled: number;
}

export interface AuthSessionRow {
  id: string;
  admin_id: string;
  family_id: string;
  refresh_token_hash: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface ExecutionTokenRow {
  id: string;
  name: string;
  scope_json: string;
  quota_json: string;
}

export interface LoginStateRow {
  failure_count: number;
  window_started_at: string;
  locked_until: string | null;
}

export interface AuthSecrets {
  bootstrapSecret: string;
  pepper: string;
  encryptionKey: string;
  auditSigningKey: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

export interface TokenPair {
  schemaVersion: 1;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  sessionId: string;
}

export interface AuthSessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface PasswordChangeResult {
  changedAt: string;
  revokedSessionIds: string[];
}

export interface TotpPreparation {
  secret: string;
  otpauthUri: string;
}

export interface TotpEnableResult {
  enabledAt: string;
  recoveryCodes: string[];
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

export interface ExecutionTokenSummary {
  id: string;
  name: string;
  scope: TokenScope;
  quota: QuotaLimits;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
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
