import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { PolicySetV1Schema } from "@one-fetch/protocol";
import type { Context, Next } from "hono";

import { auditInsertStatement, buildAuditEvent } from "./audit";
import { createConfigVersion, parseRuntimeConfig } from "./config";
import {
  bootstrapSchema,
  configUpdateSchema,
  executionTokenSchema,
  loginSchema,
  passwordChangeSchema,
  readBoundedJson,
  refreshSchema,
  totpCodeSchema,
} from "./control-schemas";
import { stableStringify } from "./crypto";
import { createCapabilities, ensureInstance } from "./storage";
import type { AccessPrincipal } from "./types";

type ControlAppEnv = {
  Bindings: CloudflareControlEnv;
  Variables: { principal: AccessPrincipal };
};

const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});
const healthRoute = createRoute({
  method: "get",
  path: "/api/v1/health",
  responses: {
    200: {
      description: "Control health",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            initialized: z.boolean(),
            configVersion: z.string(),
          }),
        },
      },
    },
    503: {
      description: "Storage unavailable",
      content: { "application/json": { schema: errorResponseSchema } },
    },
  },
});

export const controlApp = new OpenAPIHono<ControlAppEnv>();

controlApp.use("*", async (context, next) => {
  const origin = context.req.header("Origin");
  const allowed = origin ? allowedOrigins(context.env).includes(origin) : false;
  if (context.req.method === "OPTIONS") {
    if (!origin || !allowed)
      return context.json({ error: "origin_not_allowed" }, 403);
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  await next();
  context.header("Cache-Control", "no-store");
  if (origin && allowed)
    for (const [name, value] of Object.entries(corsHeaders(origin)))
      context.header(name, value);
});

controlApp.openapi(healthRoute, async (context) => {
  try {
    const instance = await ensureInstance(context.env.DB);
    return context.json(
      {
        ok: true as const,
        initialized: instance.initializedAt !== undefined,
        configVersion: instance.configVersion,
      },
      200,
    );
  } catch (error) {
    return context.json(
      { error: "storage_unavailable", message: safeMessage(error) },
      503,
    );
  }
});

controlApp.get("/api/v1/capabilities", async (context) => {
  const instance = await ensureInstance(context.env.DB);
  context.header("ETag", quoteEtag(instance.configVersion));
  return context.json(
    createCapabilities(instance, context.env.ADAPTER_VERSION),
  );
});

controlApp.get("/api/v1/bootstrap", async (context) => {
  const instance = await ensureInstance(context.env.DB);
  return context.json({
    schemaVersion: 1,
    initialized: instance.initializedAt !== undefined,
    instanceId: instance.instanceId,
  });
});

controlApp.post("/api/v1/bootstrap", async (context) => {
  try {
    await ensureInstance(context.env.DB);
    const input = bootstrapSchema.parse(await readBoundedJson(context.req.raw));
    const result = await authStub(context.env).bootstrap({
      bootstrapSecret: input.bootstrapSecret,
      username: input.username,
      password: input.password,
    });
    if (!result.ok)
      return context.json(
        { error: result.code },
        result.code === "already_initialized" ? 409 : 401,
      );
    return context.json(result.value, 201);
  } catch (error) {
    return context.json(
      { error: safeCode(error), message: safeMessage(error) },
      statusForError(error),
    );
  }
});

controlApp.post("/api/v1/auth/login", async (context) => {
  const input = loginSchema.parse(await readBoundedJson(context.req.raw));
  const result = await authStub(context.env).login({
    username: input.username,
    password: input.password,
    ...(input.totpCode ? { totpCode: input.totpCode } : {}),
    ...(input.recoveryCode ? { recoveryCode: input.recoveryCode } : {}),
    ...(input.deviceFingerprint
      ? { fingerprint: input.deviceFingerprint }
      : {}),
  });
  return result.ok
    ? context.json(result.pair)
    : context.json(
        { error: result.code },
        result.code === "totp_required"
          ? 428
          : result.code === "account_locked"
            ? 423
            : 401,
      );
});

controlApp.post("/api/v1/auth/refresh", async (context) => {
  const input = refreshSchema.parse(await readBoundedJson(context.req.raw));
  const pair = await authStub(context.env).refresh(input.refreshToken);
  return pair
    ? context.json(pair)
    : context.json({ error: "invalid_refresh_token" }, 401);
});

controlApp.use("/api/v1/admin/*", requireAdmin);
for (const path of [
  "/api/v1/config",
  "/api/v1/config/*",
  "/api/v1/tokens/execution",
  "/api/v1/tokens/execution/*",
  "/api/v1/audit",
  "/api/v1/audit/*",
  "/api/v1/alerts",
  "/api/v1/backups",
  "/api/v1/backups/*",
]) {
  controlApp.use(path, requireAdmin);
}

controlApp.post("/api/v1/admin/logout", async (context) => {
  const principal = context.get("principal");
  await authStub(context.env).logout(principal.adminId, principal.sessionId);
  return context.body(null, 204);
});

controlApp.get("/api/v1/admin/sessions", async (context) => {
  const sessions = await Promise.resolve(
    authStub(context.env).listSessions(context.get("principal").adminId),
  );
  return context.json({ sessions });
});

controlApp.delete("/api/v1/admin/sessions/:id", async (context) => {
  const deleted = await authStub(context.env).revokeSession(
    context.get("principal").adminId,
    context.req.param("id"),
  );
  return deleted
    ? context.body(null, 204)
    : context.json({ error: "not_found" }, 404);
});

controlApp.post("/api/v1/admin/totp/prepare", async (context) => {
  const principal = context.get("principal");
  return context.json(
    await authStub(context.env).prepareTotp(
      principal.adminId,
      principal.username,
    ),
  );
});

controlApp.post("/api/v1/admin/totp/enable", async (context) => {
  const input = totpCodeSchema.parse(await readBoundedJson(context.req.raw));
  const enabled = await authStub(context.env).enableTotp(
    context.get("principal").adminId,
    input.code,
  );
  return enabled
    ? context.body(null, 204)
    : context.json({ error: "invalid_totp" }, 400);
});

controlApp.post("/api/v1/admin/password", async (context) => {
  const input = passwordChangeSchema.parse(
    await readBoundedJson(context.req.raw),
  );
  const changed = await authStub(context.env).changePassword(
    context.get("principal").adminId,
    input.currentPassword,
    input.nextPassword,
  );
  return changed
    ? context.body(null, 204)
    : context.json({ error: "invalid_credentials" }, 401);
});

controlApp.get("/api/v1/admin/tokens", listExecutionTokens);
controlApp.post("/api/v1/admin/tokens", createExecutionToken);
controlApp.delete("/api/v1/admin/tokens/:id", revokeExecutionToken);
controlApp.get("/api/v1/admin/config", getConfig);
controlApp.put("/api/v1/admin/config", putConfig);
controlApp.get("/api/v1/admin/audit", listAudit);

controlApp.get("/api/v1/tokens/execution", listExecutionTokens);
controlApp.post("/api/v1/tokens/execution", createExecutionToken);
controlApp.delete("/api/v1/tokens/execution/:id", revokeExecutionToken);
controlApp.get("/api/v1/config", getConfig);
controlApp.put("/api/v1/config", putConfig);
controlApp.get("/api/v1/config/policy", getPolicy);
controlApp.put("/api/v1/config/policy", putPolicy);
controlApp.get("/api/v1/audit", listAudit);
controlApp.get("/api/v1/audit/events", listAudit);
controlApp.get("/api/v1/alerts", listAlerts);
controlApp.get("/api/v1/backups", backupCapabilities);

controlApp.get("/api/v1/reports/:id", async (context) => {
  const token = bearerToken(context.req.header("Authorization"));
  if (!token) return context.json({ error: "unauthorized" }, 401);
  const report = await controlService(context.env).getExecutionReport(
    context.req.param("id"),
    token,
  );
  return report
    ? context.json(report)
    : context.json({ error: "not_found" }, 404);
});

async function listExecutionTokens(
  context: Context<ControlAppEnv>,
): Promise<Response> {
  const records = await (authStub(context.env).listExecutionTokens(
    context.get("principal").adminId,
  ) as unknown as Promise<Record<string, unknown>[]>);
  return context.json({ tokens: records.map(publicExecutionTokenRecord) });
}

async function createExecutionToken(
  context: Context<ControlAppEnv>,
): Promise<Response> {
  const input = executionTokenSchema.parse(
    await readBoundedJson(context.req.raw),
  );
  const created = await authStub(context.env).createExecutionToken({
    name: input.name,
    scope: input.scope,
    quota: {
      requestsPerMinute: input.quota.requestsPerMinute,
      burstPerSecond: input.quota.burst,
      concurrentHttp: input.quota.concurrentHttp,
      concurrentTunnels: input.quota.concurrentTunnels,
      bytesPerDay: input.quota.bytesPerDay,
    },
    adminId: context.get("principal").adminId,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });
  return context.json(
    {
      schemaVersion: 1,
      credential: {
        schemaVersion: 1,
        id: created.id,
        name: created.name,
        scope: created.scope,
        quota: publicQuota(created.quota),
        createdAt: created.createdAt,
        ...(created.expiresAt ? { expiresAt: created.expiresAt } : {}),
      },
      token: created.token,
    },
    201,
  );
}

async function revokeExecutionToken(
  context: Context<ControlAppEnv>,
): Promise<Response> {
  const id = context.req.param("id");
  if (!id) return context.json({ error: "not_found" }, 404);
  const revoked = await authStub(context.env).revokeExecutionToken(
    context.get("principal").adminId,
    id,
  );
  return revoked
    ? context.body(null, 204)
    : context.json({ error: "not_found" }, 404);
}

async function getConfig(context: Context<ControlAppEnv>): Promise<Response> {
  const instance = await ensureInstance(context.env.DB);
  context.header("ETag", quoteEtag(instance.configVersion));
  return context.json({
    revision: instance.configRevision,
    version: instance.configVersion,
    updatedAt: instance.configUpdatedAt,
    config: instance.config,
  });
}

async function getPolicy(context: Context<ControlAppEnv>): Promise<Response> {
  const instance = await ensureInstance(context.env.DB);
  context.header("ETag", quoteEtag(instance.configVersion));
  return context.json(instance.config.systemPolicy);
}

async function putConfig(context: Context<ControlAppEnv>): Promise<Response> {
  const body = configUpdateSchema.parse(await readBoundedJson(context.req.raw));
  return updateConfiguration(context, parseRuntimeConfig(body.config), [
    "config",
  ]);
}

async function putPolicy(context: Context<ControlAppEnv>): Promise<Response> {
  const policy = PolicySetV1Schema.parse(
    await readBoundedJson(context.req.raw),
  );
  const current = await ensureInstance(context.env.DB);
  return updateConfiguration(
    context,
    { ...current.config, systemPolicy: policy },
    ["policy"],
    current,
  );
}

async function updateConfiguration(
  context: Context<ControlAppEnv>,
  nextConfig: ReturnType<typeof parseRuntimeConfig>,
  changedFields: string[],
  loaded?: Awaited<ReturnType<typeof ensureInstance>>,
): Promise<Response> {
  const expected = unquoteEtag(context.req.header("If-Match"));
  if (!expected) return context.json({ error: "precondition_required" }, 428);
  const principal = context.get("principal");
  const current = loaded ?? (await ensureInstance(context.env.DB));
  if (current.configVersion !== expected)
    return context.json({ error: "config_conflict" }, 412);
  const revision = current.configRevision + 1;
  const now = new Date();
  const version = await createConfigVersion(revision, nextConfig, now);
  const event = await buildAuditEvent({
    signingKey: context.env.AUDIT_SIGNING_KEY,
    event: {
      occurredAt: now.toISOString(),
      category: "config",
      action: changedFields.includes("policy")
        ? "config.policy.update"
        : "config.update",
      outcome: "success",
      severity: "warning",
      actor: { type: "admin", actorId: principal.adminId },
      correlation: { configVersion: version },
      change: {
        beforeVersion: current.configVersion,
        afterVersion: version,
        changedFields,
      },
    },
  });
  const results = await context.env.DB.batch([
    context.env.DB.prepare(
      "UPDATE instance_state SET config_revision = ?, config_version = ?, config_updated_at = ?, config_json = ? WHERE singleton = 1 AND config_version = ?",
    ).bind(
      revision,
      version,
      now.toISOString(),
      stableStringify(nextConfig),
      expected,
    ),
    auditInsertStatement(context.env.DB, event),
  ]);
  if (results[0]?.meta.changes !== 1)
    return context.json({ error: "config_conflict" }, 412);
  context.header("ETag", quoteEtag(version));
  return context.json({
    revision,
    version,
    updatedAt: now.toISOString(),
    config: nextConfig,
  });
}

async function listAudit(context: Context<ControlAppEnv>): Promise<Response> {
  const limit = Math.min(
    Math.max(
      Number.parseInt(context.req.query("limit") ?? "100", 10) || 100,
      1,
    ),
    500,
  );
  const before = context.req.query("before") ?? "9999-12-31T23:59:59.999Z";
  const rows = await context.env.DB.prepare(
    "SELECT * FROM audit_events WHERE occurred_at < ? ORDER BY occurred_at DESC, event_id DESC LIMIT ?",
  )
    .bind(before, limit)
    .all<Record<string, unknown>>();
  return context.json({
    events: rows.results.map(publicAuditEvent),
    nextCursor: rows.results.at(-1)?.occurred_at ?? null,
  });
}

async function listAlerts(context: Context<ControlAppEnv>): Promise<Response> {
  const instance = await ensureInstance(context.env.DB);
  const alerts = [];
  if (instance.auditDegraded)
    alerts.push({
      type: "audit_degraded",
      severity: "critical",
      summary: "The audit ledger is degraded.",
    });
  if (instance.gatewayPaused)
    alerts.push({
      type: "gateway_paused",
      severity: "warning",
      summary: "The Gateway is paused.",
    });
  return context.json({ configVersion: instance.configVersion, alerts });
}

async function backupCapabilities(
  context: Context<ControlAppEnv>,
): Promise<Response> {
  const instance = await ensureInstance(context.env.DB);
  return context.json({
    supported: false,
    configVersion: instance.configVersion,
    reason:
      "Cloudflare Preview exposes D1 export tooling but does not yet provide an in-app restore transaction.",
  });
}

function publicExecutionTokenRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const quota = record.quota as {
    requestsPerMinute: number;
    burstPerSecond: number;
    concurrentHttp: number;
    concurrentTunnels: number;
    bytesPerDay: number;
  };
  return {
    schemaVersion: 1,
    id: record.id,
    name: record.name,
    scope: record.scope,
    quota: publicQuota(quota),
    createdAt: record.created_at,
    ...(record.expires_at ? { expiresAt: record.expires_at } : {}),
    ...(record.revoked_at ? { revokedAt: record.revoked_at } : {}),
  };
}

function publicAuditEvent(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const payload = JSON.parse(String(row.payload_json)) as Record<
    string,
    unknown
  >;
  return {
    ...payload,
    integrity: {
      payloadHash: row.payload_hash,
      signature: row.signature,
      keyId: row.key_id,
    },
  };
}

function publicQuota(quota: {
  requestsPerMinute: number;
  burstPerSecond: number;
  concurrentHttp: number;
  concurrentTunnels: number;
  bytesPerDay: number;
}) {
  return {
    requestsPerMinute: quota.requestsPerMinute,
    burst: quota.burstPerSecond,
    concurrentHttp: quota.concurrentHttp,
    concurrentTunnels: quota.concurrentTunnels,
    bytesPerDay: quota.bytesPerDay,
  };
}

controlApp.doc("/api/v1/openapi.json", {
  openapi: "3.1.0",
  info: { title: "one-fetch Control API", version: "0.1.0" },
});
controlApp.notFound((context) => context.json({ error: "not_found" }, 404));
controlApp.onError((error, context) =>
  context.json(
    { error: safeCode(error), message: safeMessage(error) },
    statusForError(error),
  ),
);

async function requireAdmin(
  context: Context<ControlAppEnv>,
  next: Next,
): Promise<Response | void> {
  const token = bearerToken(context.req.header("Authorization"));
  if (!token) return context.json({ error: "unauthorized" }, 401);
  const principal = await authStub(context.env).verifyAccess(token);
  if (!principal) return context.json({ error: "unauthorized" }, 401);
  context.set("principal", principal);
  await next();
}

function bearerToken(authorization: string | undefined): string | undefined {
  const matched = /^Bearer ([^\s]+)$/iu.exec(authorization ?? "");
  return matched?.[1];
}

function authStub(env: CloudflareControlEnv) {
  return env.AUTH.getByName("instance-auth");
}

function controlService(env: CloudflareControlEnv) {
  return new (class {
    async getExecutionReport(reportId: string, token: string) {
      const principal = await authStub(env).verifyExecutionToken(token);
      if (!principal) return null;
      const row = await env.DB.prepare(
        "SELECT report_json, expires_at FROM execution_reports WHERE report_id = ? AND token_id = ?",
      )
        .bind(reportId, principal.tokenId)
        .first<{ report_json: string; expires_at: string }>();
      return row && Date.parse(row.expires_at) > Date.now()
        ? (JSON.parse(row.report_json) as Record<string, unknown>)
        : null;
    }
  })();
}

function allowedOrigins(env: CloudflareControlEnv): string[] {
  return env.ADMIN_ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function quoteEtag(value: string): string {
  return `"${value}"`;
}
function unquoteEtag(value?: string): string | null {
  return value?.replace(/^W\//u, "").replace(/^"|"$/gu, "") ?? null;
}
const PUBLIC_ERROR_CODES = new Set([
  "account_locked",
  "already_initialized",
  "config_conflict",
  "invalid_bootstrap_token",
  "invalid_credentials",
  "invalid_password",
  "invalid_request",
  "invalid_totp",
  "invalid_username",
  "payload_too_large",
  "precondition_required",
]);
function safeMessage(error: unknown): string {
  const code = safeCode(error);
  return code === "internal"
    ? "The Control service failed the request"
    : code.replaceAll("_", " ");
}
function safeCode(error: unknown): string {
  if (error instanceof z.ZodError) return "invalid_request";
  return error instanceof Error && PUBLIC_ERROR_CODES.has(error.message)
    ? error.message
    : "internal";
}
function statusForError(error: unknown): 400 | 401 | 409 | 413 | 500 {
  const code = safeCode(error);
  if (code === "invalid_bootstrap_token") return 401;
  if (code === "already_initialized") return 409;
  if (code === "payload_too_large") return 413;
  return code === "internal" ? 500 : 400;
}
