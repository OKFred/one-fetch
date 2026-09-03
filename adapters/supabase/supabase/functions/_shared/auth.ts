import bcrypt from "bcryptjs";

import type { Database } from "./database.ts";
import type { SupabaseEnvironment } from "./env.ts";
import { hmacSha256Hex, randomToken } from "./crypto.ts";

const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const BCRYPT_COST = 12;
let dummyHash: Promise<string> | undefined;

export interface AdminPrincipal {
  adminId: string;
  sessionId: string;
  familyId: string;
}

export interface ExecutionPrincipal {
  tokenId: string;
  name: string;
  scopes: Record<string, unknown>;
  quotas: Record<string, unknown>;
  expiresAt?: string;
}

export async function hashPassword(
  password: string,
  environment: SupabaseEnvironment,
): Promise<string> {
  const bytes = new TextEncoder().encode(password);
  if (
    password.length < 12 ||
    password.length > 1_024 ||
    bytes.byteLength > 4_096
  ) {
    throw new Error(
      "Password must contain 12-1024 characters and at most 4096 UTF-8 bytes",
    );
  }
  return bcrypt.hash(
    await hmacSha256Hex(environment.pepper, password),
    BCRYPT_COST,
  );
}

export async function verifyPassword(
  password: string,
  passwordHash: string | undefined,
  environment: SupabaseEnvironment,
): Promise<boolean> {
  const prehash = await hmacSha256Hex(environment.pepper, password);
  if (!dummyHash)
    dummyHash = bcrypt.hash(
      await hmacSha256Hex(environment.pepper, "one-fetch-dummy"),
      BCRYPT_COST,
    );
  return bcrypt.compare(prehash, passwordHash ?? (await dummyHash));
}

export async function tokenHash(
  token: string,
  environment: SupabaseEnvironment,
): Promise<string> {
  return hmacSha256Hex(environment.pepper, token);
}

export function issueTokenPair(): {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
} {
  const now = Date.now();
  return {
    accessToken: `ofa_${randomToken()}`,
    refreshToken: `ofr_${randomToken()}`,
    accessExpiresAt: new Date(now + ACCESS_TTL_MS).toISOString(),
    refreshExpiresAt: new Date(now + REFRESH_TTL_MS).toISOString(),
  };
}

export async function authenticateAdmin(
  token: string | undefined,
  database: Database,
  environment: SupabaseEnvironment,
): Promise<AdminPrincipal | undefined> {
  if (!token) return undefined;
  return (
    (await database.rpc<AdminPrincipal | null>("of_authenticate_access", {
      p_token_hash: await tokenHash(token, environment),
    })) ?? undefined
  );
}

export async function authenticateExecution(
  token: string | undefined,
  database: Database,
  environment: SupabaseEnvironment,
): Promise<ExecutionPrincipal | undefined> {
  if (!token) return undefined;
  return (
    (await database.rpc<ExecutionPrincipal | null>(
      "of_authenticate_execution",
      {
        p_token_hash: await tokenHash(token, environment),
      },
    )) ?? undefined
  );
}

export function issueExecutionToken(): string {
  return `ofe_${randomToken()}`;
}
