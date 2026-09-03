import { auditInsertWhenConfigVersionMatches, buildAuditEvent } from "./audit";
import { createConfigVersion } from "./config";
import {
  gatewayPausedSchema,
  policyUpdateSchema,
  readBoundedJson,
} from "./control-schemas";
import {
  controlError,
  quoteEtag,
  runtimeConfiguration,
  unquoteEtag,
  type ControlApp,
  type ControlContext,
} from "./control-support";
import { stableStringify } from "./crypto";
import { ensureInstance, type InstanceRecord } from "./storage";
import type { RuntimeConfig } from "./types";

export function registerConfigurationRoutes(app: ControlApp): void {
  app.get("/api/v1/config", async (context) => {
    const instance = await ensureInstance(context.env.DB);
    context.header("ETag", quoteEtag(instance.configVersion));
    return context.json(runtimeConfiguration(instance));
  });

  app.get("/api/v1/config/policy", async (context) => {
    const instance = await ensureInstance(context.env.DB);
    context.header("ETag", quoteEtag(instance.configVersion));
    return context.json(instance.config.systemPolicy);
  });

  app.put("/api/v1/config/policy", async (context) => {
    const input = policyUpdateSchema.parse(
      await readBoundedJson(context.req.raw),
    );
    const current = await ensureInstance(context.env.DB);
    return updateConfiguration(context, current, {
      config: { ...current.config, systemPolicy: input.policy },
      gatewayPaused: current.gatewayPaused,
      action: "config.policy.update",
      changedFields: ["policy"],
    });
  });

  app.put("/api/v1/config/gateway-paused", async (context) => {
    const input = gatewayPausedSchema.parse(
      await readBoundedJson(context.req.raw),
    );
    const current = await ensureInstance(context.env.DB);
    return updateConfiguration(context, current, {
      config: current.config,
      gatewayPaused: input.paused,
      action: input.paused ? "gateway.pause" : "gateway.resume",
      changedFields: ["gatewayPaused"],
    });
  });
}

interface ConfigurationUpdate {
  config: RuntimeConfig;
  gatewayPaused: boolean;
  action: string;
  changedFields: string[];
}

async function updateConfiguration(
  context: ControlContext,
  current: InstanceRecord,
  update: ConfigurationUpdate,
): Promise<Response> {
  const expected = unquoteEtag(context.req.header("If-Match"));
  if (!expected)
    return controlError(
      428,
      "precondition_required",
      "If-Match with the current configuration version is required",
    );
  if (current.configVersion !== expected)
    return controlError(
      412,
      "config_conflict",
      "The configuration version does not match",
    );

  const revision = current.configRevision + 1;
  const now = new Date();
  const version = await createConfigVersion(revision, update.config, now);
  const event = await buildAuditEvent({
    signingKey: context.env.AUDIT_SIGNING_KEY,
    event: {
      occurredAt: now.toISOString(),
      category: "config",
      action: update.action,
      outcome: "success",
      severity: "warning",
      actor: {
        type: "admin",
        actorId: context.get("principal").adminId,
      },
      correlation: { configVersion: version },
      change: {
        beforeVersion: current.configVersion,
        afterVersion: version,
        changedFields: update.changedFields,
      },
    },
  });
  const results = await context.env.DB.batch([
    auditInsertWhenConfigVersionMatches(context.env.DB, event, expected),
    context.env.DB.prepare(
      `UPDATE instance_state
       SET config_revision = ?, config_version = ?, config_updated_at = ?,
           config_json = ?, gateway_paused = ?
       WHERE singleton = 1 AND config_version = ?`,
    ).bind(
      revision,
      version,
      now.toISOString(),
      stableStringify(update.config),
      update.gatewayPaused ? 1 : 0,
      expected,
    ),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1)
    return controlError(
      412,
      "config_conflict",
      "The configuration changed before the update completed",
    );

  const next: InstanceRecord = {
    ...current,
    configRevision: revision,
    configVersion: version,
    configUpdatedAt: now.toISOString(),
    config: update.config,
    gatewayPaused: update.gatewayPaused,
  };
  context.header("ETag", quoteEtag(version));
  return context.json(runtimeConfiguration(next));
}
