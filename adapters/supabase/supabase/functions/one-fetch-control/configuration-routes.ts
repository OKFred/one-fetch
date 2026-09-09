import type { Hono } from "hono";
import {
  SetGatewayPausedRequestV1Schema,
  UpdatePolicyRequestV1Schema,
} from "@one-fetch/protocol";
import { stableStringify } from "@one-fetch/core";
import { z } from "zod";

import { createAuditEvent } from "../_shared/audit.ts";
import { sha256Hex } from "../_shared/crypto.ts";
import {
  type Database,
  parseStorageResult,
  StorageContractError,
} from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { readBoundedJson } from "../_shared/http.ts";
import { adminOrResponse, controlError } from "./helpers.ts";
import {
  assertMatchingInstance,
  ConfigSchema,
  configurationResponse,
  configVersion,
  type InitializedStoredConfig,
  InitializedStoredConfigSchema,
} from "./model.ts";
import { parseRequest } from "./request-validation.ts";

function quoteEtag(version: string): string {
  return `"${version}"`;
}

function expectedVersion(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^"([^"\r\n]{1,256})"$/u.exec(value);
  return match?.[1];
}

const UpdateConfigResultSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    version: z.string().min(1).max(256),
    configHash: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

async function readActiveConfiguration(
  environment: SupabaseEnvironment,
  database: Database,
): Promise<InitializedStoredConfig> {
  const stored = parseStorageResult(
    "of_get_active_config",
    InitializedStoredConfigSchema,
    await database.rpc<unknown>("of_get_active_config"),
  );
  assertMatchingInstance(stored, environment.instanceId);
  return stored;
}

async function persistConfiguration(
  stored: InitializedStoredConfig,
  config: ReturnType<typeof ConfigSchema.parse>,
  changedFields: string[],
  action: string,
  adminId: string,
  environment: SupabaseEnvironment,
  database: Database,
) {
  const now = new Date();
  const hash = await sha256Hex(stableStringify(config));
  const version = configVersion(now, hash);
  const audit = await createAuditEvent(
    {
      category: "config",
      action,
      outcome: "success",
      severity: "warning",
      actor: { type: "admin", actorId: adminId },
      correlation: { configVersion: version },
      change: {
        ...(stored.version ? { beforeVersion: stored.version } : {}),
        afterVersion: version,
        changedFields,
      },
    },
    environment,
  );
  const persisted = parseStorageResult(
    "of_update_config",
    UpdateConfigResultSchema,
    await database.rpc<unknown>("of_update_config", {
      p_admin_id: adminId,
      p_expected_revision: stored.revision,
      p_version: version,
      p_config: config,
      p_changed_fields: changedFields,
      p_audit: audit,
    }),
  );
  if (
    persisted.revision !== stored.revision + 1 ||
    persisted.version !== version
  ) {
    throw new StorageContractError("of_update_config");
  }
  return configurationResponse(
    {
      ...stored,
      config,
      gatewayPaused: config.gatewayPaused,
      revision: persisted.revision,
      updatedAt: now.toISOString(),
      version,
    },
    environment.instanceId,
  );
}

export function registerConfigurationRoutes(
  app: Hono,
  environment: SupabaseEnvironment,
  database: Database,
): void {
  app.get("/api/v1/config", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const stored = await readActiveConfiguration(environment, database);
    const configuration = configurationResponse(stored, environment.instanceId);
    return context.json(configuration, 200, {
      etag: quoteEtag(configuration.version),
    });
  });

  app.get("/api/v1/config/policy", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const stored = await readActiveConfiguration(environment, database);
    const configuration = configurationResponse(stored, environment.instanceId);
    return context.json(configuration.policy, 200, {
      etag: quoteEtag(configuration.version),
    });
  });

  app.put("/api/v1/config/policy", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const expected = expectedVersion(context.req.header("If-Match"));
    if (!expected) {
      return controlError("precondition_required", "If-Match is required", 428);
    }
    const input = parseRequest(
      UpdatePolicyRequestV1Schema,
      await readBoundedJson(context.req.raw),
    );
    const stored = await readActiveConfiguration(environment, database);
    const current = stored.config;
    if (
      expected !== stored.version ||
      input.policy.revision !== current.policy.revision
    ) {
      return controlError(
        "version_conflict",
        "Configuration version changed",
        409,
      );
    }
    const configuration = await persistConfiguration(
      stored,
      ConfigSchema.parse({
        ...current,
        policy: { ...input.policy, revision: current.policy.revision + 1 },
      }),
      ["policy"],
      "config.policy.update",
      principal.adminId,
      environment,
      database,
    );
    return context.json(configuration, 200, {
      etag: quoteEtag(configuration.version),
    });
  });

  app.put("/api/v1/config/gateway-paused", async (context) => {
    const principal = await adminOrResponse(
      context.req.raw,
      database,
      environment,
    );
    if (principal instanceof Response) return principal;
    const expected = expectedVersion(context.req.header("If-Match"));
    if (!expected) {
      return controlError("precondition_required", "If-Match is required", 428);
    }
    const input = parseRequest(
      SetGatewayPausedRequestV1Schema,
      await readBoundedJson(context.req.raw),
    );
    const stored = await readActiveConfiguration(environment, database);
    const current = stored.config;
    if (expected !== stored.version) {
      return controlError(
        "version_conflict",
        "Configuration version changed",
        409,
      );
    }
    const configuration = await persistConfiguration(
      stored,
      ConfigSchema.parse({ ...current, gatewayPaused: input.paused }),
      ["gatewayPaused"],
      input.paused ? "config.gateway.pause" : "config.gateway.resume",
      principal.adminId,
      environment,
      database,
    );
    return context.json(configuration, 200, {
      etag: quoteEtag(configuration.version),
    });
  });
}
