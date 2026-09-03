import {
  decodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_TOKEN_HEADER,
  ProtocolCodecError,
} from "@one-fetch/protocol";
import type { OneFetchRequestMetaV1 } from "../_shared/protocol-types.ts";

import {
  authenticateExecution,
  type ExecutionPrincipal,
} from "../_shared/auth.ts";
import { applyCors, preflight } from "../_shared/cors.ts";
import { createDatabase, DatabaseError } from "../_shared/database.ts";
import { getEnvironment } from "../_shared/env.ts";
import { json } from "../_shared/http.ts";
import {
  createMigrationCompatibilityGuard,
  MigrationCompatibilityError,
} from "../_shared/migration-compatibility.ts";
import { assertNoOuterProtocolHeaders } from "../_shared/upstream.ts";
import { executeHttp } from "./executor.ts";
import {
  type ActiveConfig,
  ActiveConfigSchema,
  type GatewayContext,
  problem,
  signedError,
} from "./foundation.ts";
import { pathAndQuery } from "./request.ts";

export function createGatewayHandler(
  environment = getEnvironment(),
  database = createDatabase(environment),
) {
  const assertCompatible = createMigrationCompatibilityGuard(database);
  return async (request: Request): Promise<Response> => {
    const preflightResponse = preflight(
      request,
      environment.allowedClientOrigins,
    );
    if (preflightResponse) return preflightResponse;
    const startedAt = performance.now();
    try {
      assertNoOuterProtocolHeaders(request.headers);
    } catch {
      return applyCors(
        request,
        json({ error: "invalid_metadata" }, { status: 400 }),
        environment.allowedClientOrigins,
      );
    }
    const encoded = request.headers.get(ONE_FETCH_REQUEST_HEADER);
    const token = request.headers.get(ONE_FETCH_TOKEN_HEADER)?.trim();
    if (!encoded || !token) {
      return applyCors(
        request,
        json({ error: "invalid_metadata" }, { status: 400 }),
        environment.allowedClientOrigins,
      );
    }

    let metadata: OneFetchRequestMetaV1;
    try {
      metadata = decodeRequestMetadata(encoded);
    } catch (error) {
      const code =
        error instanceof ProtocolCodecError ? error.code : "invalid_metadata";
      return applyCors(
        request,
        json(
          { error: code },
          { status: code === "metadata_too_large" ? 413 : 400 },
        ),
        environment.allowedClientOrigins,
      );
    }
    const unknownPrincipal: ExecutionPrincipal = {
      tokenId: "00000000-0000-4000-8000-000000000000",
      name: "unknown",
      scopes: { transports: ["http"], origins: [], ports: [] },
      quotas: {
        requestsPerMinute: 1,
        burst: 1,
        concurrentHttp: 0,
        concurrentTunnels: 0,
        bytesPerDay: 1,
      },
    };
    const unsignedBase = {
      environment,
      database,
      token,
      metadata,
      configVersion: "unknown",
      startedAt,
      requestMethod: request.method,
      targetPathAndQuery: pathAndQuery(request),
    };
    try {
      await assertCompatible();
    } catch (error) {
      return applyCors(
        request,
        await signedError(
          { ...unsignedBase, principal: unknownPrincipal },
          problem(
            "storage_unavailable",
            "storage",
            error instanceof MigrationCompatibilityError
              ? "Gateway storage schema is incompatible"
              : "Migration compatibility storage is unavailable",
            true,
          ),
        ),
        environment.allowedClientOrigins,
      );
    }
    let principal: ExecutionPrincipal | undefined;
    try {
      principal = await authenticateExecution(token, database, environment);
    } catch {
      return applyCors(
        request,
        await signedError(
          { ...unsignedBase, principal: unknownPrincipal },
          problem(
            "storage_unavailable",
            "storage",
            "Authentication storage is unavailable",
            true,
          ),
        ),
        environment.allowedClientOrigins,
      );
    }
    if (!principal) {
      return applyCors(
        request,
        await signedError(
          { ...unsignedBase, principal: unknownPrincipal },
          problem(
            "unauthorized",
            "authentication",
            "Execution token is invalid",
          ),
        ),
        environment.allowedClientOrigins,
      );
    }
    let config: ActiveConfig;
    try {
      config = ActiveConfigSchema.parse(
        await database.rpc("of_get_active_config"),
      );
    } catch {
      return applyCors(
        request,
        await signedError(
          { ...unsignedBase, principal },
          problem(
            "storage_unavailable",
            "storage",
            "Configuration storage is unavailable",
            true,
          ),
        ),
        environment.allowedClientOrigins,
      );
    }
    if (
      config.instanceId !== undefined &&
      config.instanceId !== environment.instanceId
    ) {
      return applyCors(
        request,
        await signedError(
          { ...unsignedBase, principal },
          problem(
            "storage_unavailable",
            "storage",
            "Control and Gateway instance IDs do not match",
          ),
        ),
        environment.allowedClientOrigins,
      );
    }
    const base: GatewayContext = {
      ...unsignedBase,
      principal,
      configVersion: config.version ?? "unknown",
    };

    try {
      return applyCors(
        request,
        await executeHttp(request, base, config),
        environment.allowedClientOrigins,
      );
    } catch (error) {
      const code =
        error instanceof DatabaseError
          ? "storage_unavailable"
          : error instanceof RangeError
            ? "payload_too_large"
            : error instanceof TypeError
              ? "invalid_metadata"
              : "internal";
      const stage =
        code === "storage_unavailable"
          ? "storage"
          : code === "internal"
            ? "internal"
            : "upload";
      return applyCors(
        request,
        await signedError(
          base,
          problem(
            code,
            stage,
            code === "payload_too_large"
              ? "Request body exceeds 20 MiB"
              : code === "storage_unavailable"
                ? "Gateway storage is unavailable"
                : code === "internal"
                  ? "Gateway execution failed"
                  : "Request body metadata mismatch",
            code === "storage_unavailable" || code === "internal",
          ),
        ),
        environment.allowedClientOrigins,
      );
    }
  };
}
