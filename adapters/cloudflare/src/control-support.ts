import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  ControlErrorV1Schema,
  RuntimeConfigurationV1Schema,
  type RuntimeConfigurationV1,
} from "@one-fetch/protocol";
import type { Context, Next } from "hono";
import { z } from "zod";

import type { InstanceRecord } from "./storage";
import type { AccessPrincipal } from "./types";

export type ControlAppEnv = {
  Bindings: CloudflareControlEnv;
  Variables: { principal: AccessPrincipal };
};

export type ControlApp = OpenAPIHono<ControlAppEnv>;
export type ControlContext = Context<ControlAppEnv>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const PUBLIC_ERROR_CODES = new Set([
  "account_locked",
  "already_initialized",
  "config_conflict",
  "feature_unsupported",
  "invalid_bootstrap_token",
  "invalid_credentials",
  "invalid_cursor",
  "invalid_password",
  "invalid_refresh_token",
  "invalid_request",
  "invalid_totp",
  "not_found",
  "payload_too_large",
  "precondition_required",
  "totp_required",
  "unauthorized",
]);

export function controlError(
  status: number,
  code: string,
  message: string,
  options: { retryable?: boolean; correlationId?: string } = {},
): Response {
  const body = ControlErrorV1Schema.parse({
    error: {
      code,
      message,
      ...(options.retryable === undefined
        ? {}
        : { retryable: options.retryable }),
      ...(options.correlationId === undefined
        ? {}
        : { correlationId: options.correlationId }),
    },
  });
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function handleControlError(error: unknown): Response {
  const code = safeCode(error);
  const status = statusForCode(code);
  const correlationId = code === "internal" ? crypto.randomUUID() : undefined;
  if (code === "internal") {
    console.error(
      JSON.stringify({
        event: "control.request.failed",
        correlationId,
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
  return controlError(
    status,
    code,
    code === "internal"
      ? "The Control service failed the request"
      : code.replaceAll("_", " "),
    {
      retryable: code === "internal" || code === "storage_unavailable",
      ...(correlationId === undefined ? {} : { correlationId }),
    },
  );
}

export async function requireAdmin(
  context: ControlContext,
  next: Next,
): Promise<Response | void> {
  const token = bearerToken(context.req.header("Authorization"));
  if (!token)
    return controlError(401, "unauthorized", "Administrator access required");
  const principal = await authStub(context.env).verifyAccess(token);
  if (!principal)
    return controlError(401, "unauthorized", "Administrator access required");
  context.set("principal", principal);
  await next();
}

export async function applyControlHeaders(
  context: ControlContext,
  next: Next,
): Promise<Response | void> {
  const origin = context.req.header("Origin");
  const allowed = origin ? allowedOrigins(context.env).includes(origin) : false;
  if (context.req.method === "OPTIONS") {
    if (!origin || !allowed)
      return controlError(403, "origin_not_allowed", "Origin is not allowed");
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  await next();
  context.header("Cache-Control", "no-store");
  if (origin && allowed) {
    for (const [name, value] of Object.entries(corsHeaders(origin))) {
      context.header(name, value);
    }
  }
}

export function runtimeConfiguration(
  instance: InstanceRecord,
): RuntimeConfigurationV1 {
  return RuntimeConfigurationV1Schema.parse({
    schemaVersion: 1,
    instanceId: instance.instanceId,
    controlGatewayPairId: instance.instanceId,
    revision: instance.configRevision,
    version: instance.configVersion,
    updatedAt: instance.configUpdatedAt,
    gatewayPaused: instance.gatewayPaused,
    policy: instance.config.systemPolicy,
  });
}

export function bearerToken(
  authorization: string | undefined,
): string | undefined {
  return /^Bearer ([^\s]+)$/iu.exec(authorization ?? "")?.[1];
}

export function authStub(env: CloudflareControlEnv) {
  return env.AUTH.getByName("instance-auth");
}

export function quoteEtag(value: string): string {
  return `"${value}"`;
}

export function unquoteEtag(value?: string): string | null {
  return /^"([^"\r\n]{1,256})"$/u.exec(value ?? "")?.[1] ?? null;
}

export function isIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value);
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

function safeCode(error: unknown): string {
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return "invalid_request";
  if (error instanceof Error && PUBLIC_ERROR_CODES.has(error.message))
    return error.message;
  if (error instanceof Error && error.message === "storage_unavailable")
    return error.message;
  return "internal";
}

function statusForCode(code: string): number {
  if (
    code === "invalid_bootstrap_token" ||
    code === "invalid_credentials" ||
    code === "invalid_refresh_token"
  )
    return 401;
  if (code === "already_initialized") return 409;
  if (code === "payload_too_large") return 413;
  if (code === "account_locked") return 423;
  if (code === "totp_required" || code === "precondition_required") return 428;
  if (code === "feature_unsupported") return 501;
  if (code === "storage_unavailable") return 503;
  return code === "internal" ? 500 : 400;
}
