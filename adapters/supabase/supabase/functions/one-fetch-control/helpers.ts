import { ControlErrorV1Schema } from "@one-fetch/protocol";

import { authenticateAdmin } from "../_shared/auth.ts";
import { hmacSha256Hex } from "../_shared/crypto.ts";
import type { Database } from "../_shared/database.ts";
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

export function originFingerprint(
  request: Request,
  environment: SupabaseEnvironment,
): Promise<string> {
  const forwarded =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const userAgent = request.headers.get("user-agent") ?? "unknown";
  return hmacSha256Hex(environment.pepper, `${forwarded}\n${userAgent}`);
}

export async function adminOrResponse(
  request: Request,
  database: Database,
  environment: SupabaseEnvironment,
) {
  const principal = await authenticateAdmin(
    bearer(request),
    database,
    environment,
  );
  return principal ?? controlError("unauthorized", "Unauthorized", 401);
}

export function previewUnsupported(): Response {
  return controlError(
    "unsupported",
    "This Control API capability is not enabled in Preview",
    501,
  );
}
