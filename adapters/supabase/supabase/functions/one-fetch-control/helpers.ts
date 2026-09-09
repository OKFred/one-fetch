import { ControlErrorV1Schema } from "@one-fetch/protocol";
import { z } from "zod";

import { authenticateAdmin, authenticateExecution } from "../_shared/auth.ts";
import { hmacSha256Hex } from "../_shared/crypto.ts";
import { type Database, StorageContractError } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { bearer, json } from "../_shared/http.ts";

export function controlError(
  code: string,
  message: string,
  status: number,
): Response {
  return json(ControlErrorV1Schema.parse({ error: { code, message } }), {
    status,
  });
}

function managedPlatformClientSource(request: Request): string {
  const source = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(0);
  return source && source.length <= 128 ? source : "unknown";
}

export function originFingerprint(
  request: Request,
  environment: SupabaseEnvironment,
): Promise<string> {
  const forwarded = managedPlatformClientSource(request);
  const userAgent = request.headers.get("user-agent") ?? "unknown";
  return hmacSha256Hex(environment.pepper, `${forwarded}\n${userAgent}`);
}

export function authSourceHash(
  request: Request,
  purpose: "bootstrap" | "refresh",
  environment: SupabaseEnvironment,
): Promise<string> {
  return hmacSha256Hex(
    environment.pepper,
    `${purpose}-source\n${managedPlatformClientSource(request)}`,
  );
}

export async function loginThrottleKeys(
  request: Request,
  username: string,
  environment: SupabaseEnvironment,
): Promise<{ sourceHash: string; usernameHash: string }> {
  const source = managedPlatformClientSource(request);
  const [sourceHash, usernameHash] = await Promise.all([
    hmacSha256Hex(environment.pepper, `login-source\n${source}`),
    hmacSha256Hex(
      environment.pepper,
      `login-username\n${username.trim().toLowerCase()}`,
    ),
  ]);
  return { sourceHash, usernameHash };
}

export async function adminOrResponse(
  request: Request,
  database: Database,
  environment: SupabaseEnvironment,
) {
  try {
    const principal = await authenticateAdmin(
      bearer(request),
      database,
      environment,
    );
    return principal ?? controlError("unauthorized", "Unauthorized", 401);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new StorageContractError("of_authenticate_access");
    }
    throw error;
  }
}

export async function executionOrResponse(
  request: Request,
  database: Database,
  environment: SupabaseEnvironment,
) {
  try {
    const principal = await authenticateExecution(
      bearer(request),
      database,
      environment,
    );
    return principal ?? controlError("unauthorized", "Unauthorized", 401);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new StorageContractError("of_authenticate_execution");
    }
    throw error;
  }
}

export function previewUnsupported(): Response {
  return controlError(
    "unsupported",
    "This Control API capability is not enabled in Preview",
    501,
  );
}
