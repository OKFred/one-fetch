import {
  ExecutionReportV1Schema,
  OneFetchCapabilitiesV1Schema,
} from "@one-fetch/protocol";
import { WorkerEntrypoint } from "cloudflare:workers";

import { auditInsertStatement, buildAuditEvent } from "./audit";
import {
  authorizationInputSchema,
  authorizationResultSchema,
  completionInputSchema,
  parseJsonWithSchema,
} from "./service-schemas";
import { ensureInstance, createCapabilities, reportJson } from "./storage";
import type {
  AuthorizationInput,
  AuthorizationResult,
  CompletionInput,
  ExecutionPrincipal,
} from "./types";

export class ControlService extends WorkerEntrypoint<CloudflareControlEnv> {
  async capabilitiesJson(): Promise<string> {
    const instance = await ensureInstance(this.env.DB);
    return JSON.stringify(
      OneFetchCapabilitiesV1Schema.parse(
        createCapabilities(instance, this.env.ADAPTER_VERSION),
      ),
    );
  }

  async authorizeExecutionJson(inputJson: string): Promise<string> {
    const input = parseJsonWithSchema(inputJson, authorizationInputSchema);
    return JSON.stringify(
      authorizationResultSchema.parse(await this.authorizeExecution(input)),
    );
  }

  async checkTargetJson(
    token: string,
    transport: AuthorizationInput["transport"],
    targetUrl: string,
  ): Promise<string> {
    const input = authorizationInputSchema.parse({
      token,
      transport,
      targetUrl,
      requestId: "redirect-check",
      method: "GET",
      requestBytes: 0,
    });
    return JSON.stringify(
      authorizationResultSchema.parse(
        await this.checkTarget(input.token, input.transport, input.targetUrl),
      ),
    );
  }

  async releaseExecutionJson(inputJson: string): Promise<string> {
    const parsed = parseJsonWithSchema(
      inputJson,
      completionInputSchema,
    ) as unknown as CompletionInput;
    return this.releaseExecution(parsed);
  }

  async releaseDeniedExecutionJson(
    tokenId: string,
    requestId: string,
    code: string,
  ): Promise<void> {
    await this.releaseDeniedExecution(tokenId, requestId, code);
  }

  async renewExecutionJson(
    tokenId: string,
    requestId: string,
  ): Promise<boolean> {
    const instance = await ensureInstance(this.env.DB);
    return this.env.QUOTA.getByName(tokenId).renew(
      requestId,
      Date.now(),
      Math.max(instance.config.requestTimeoutMs + 30_000, 90_000),
    );
  }

  private async authorizeExecution(
    input: AuthorizationInput,
  ): Promise<AuthorizationResult> {
    const instance = await ensureInstance(this.env.DB);
    if (instance.gatewayPaused) {
      await this.recordDenied(
        input,
        "forbidden",
        "Gateway is paused",
        instance.configVersion,
      );
      return {
        allowed: false,
        code: "forbidden",
        message: "Gateway is paused",
        auditState: "recorded",
      };
    }

    const auth = this.env.AUTH.getByName("instance-auth");
    const principal = await auth.verifyExecutionToken(input.token);
    if (!principal) {
      await this.recordDenied(
        input,
        "unauthorized",
        "Execution token is invalid",
        instance.configVersion,
      );
      return {
        allowed: false,
        code: "unauthorized",
        message: "Execution token is invalid",
        auditState: "recorded",
      };
    }

    let target: URL;
    try {
      target = new URL(input.targetUrl);
    } catch {
      return {
        allowed: false,
        code: "target_not_allowed",
        message: "Target URL is invalid",
        auditState: "recorded",
      };
    }
    if (!this.scopeAllows(principal, input.transport, target)) {
      await this.recordDenied(
        input,
        "forbidden",
        "Execution token scope denied the target",
        instance.configVersion,
        principal.tokenId,
      );
      return {
        allowed: false,
        code: "forbidden",
        message: "Execution token scope denied the target",
        auditState: "recorded",
      };
    }
    const quota = this.env.QUOTA.getByName(principal.tokenId);
    const acquired = await quota.acquire({
      requestId: input.requestId,
      transport: input.transport,
      now: Date.now(),
      requestBytes: input.requestBytes,
      leaseTtlMs: Math.max(instance.config.requestTimeoutMs + 30_000, 90_000),
      limits: principal.quota,
    });
    if (!acquired.allowed) {
      await this.recordDenied(
        input,
        acquired.code,
        "Execution quota denied the request",
        instance.configVersion,
        principal.tokenId,
      );
      return {
        allowed: false,
        code:
          acquired.code === "rate_limited" ? "quota_exceeded" : acquired.code,
        message: "Execution quota denied the request",
        auditState: "recorded",
      };
    }

    try {
      const eventId = await this.recordAccepted(
        input,
        principal.tokenId,
        instance.configVersion,
      );
      return {
        allowed: true,
        tokenId: principal.tokenId,
        config: instance.config,
        configVersion: instance.configVersion,
        auditState: "recorded",
        auditEventId: eventId,
      };
    } catch (error) {
      await this.markAuditDegraded(error);
      return {
        allowed: true,
        tokenId: principal.tokenId,
        config: instance.config,
        configVersion: instance.configVersion,
        auditState: "degraded",
      };
    }
  }

  private async checkTarget(
    token: string,
    transport: AuthorizationInput["transport"],
    targetUrl: string,
  ): Promise<AuthorizationResult> {
    const instance = await ensureInstance(this.env.DB);
    if (instance.gatewayPaused)
      return {
        allowed: false,
        code: "forbidden",
        message: "Gateway is paused",
        auditState: "recorded",
      };
    const principal =
      await this.env.AUTH.getByName("instance-auth").verifyExecutionToken(
        token,
      );
    if (!principal)
      return {
        allowed: false,
        code: "unauthorized",
        message: "Execution token is invalid",
        auditState: "recorded",
      };
    let target: URL;
    try {
      target = new URL(targetUrl);
    } catch {
      return {
        allowed: false,
        code: "target_not_allowed",
        message: "Target URL is invalid",
        auditState: "recorded",
      };
    }
    if (!this.scopeAllows(principal, transport, target)) {
      return {
        allowed: false,
        code: "forbidden",
        message: "Execution token scope denied the target",
        auditState: "recorded",
      };
    }
    return {
      allowed: true,
      tokenId: principal.tokenId,
      config: instance.config,
      configVersion: instance.configVersion,
      auditState: instance.auditDegraded ? "degraded" : "recorded",
    };
  }

  private async releaseExecution(
    input: CompletionInput,
  ): Promise<"recorded" | "degraded"> {
    const quota = this.env.QUOTA.getByName(input.tokenId);
    await quota.release(
      input.requestId,
      input.responseBytes,
      input.requestBytes,
    );
    const now = new Date();
    const instance = await ensureInstance(this.env.DB);
    try {
      const audit = await buildAuditEvent({
        signingKey: this.env.AUDIT_SIGNING_KEY,
        event: {
          occurredAt: now.toISOString(),
          category: "execution",
          action: `execution.${input.outcome}`,
          outcome:
            input.outcome === "target"
              ? "success"
              : input.outcome === "partial"
                ? "partial"
                : "failure",
          severity: input.outcome === "target" ? "info" : "warning",
          actor: { type: "execution-token", credentialId: input.tokenId },
          correlation: {
            requestId: input.requestId,
            reportId: input.reportId,
            configVersion: instance.configVersion,
          },
          result: {
            source:
              input.outcome === "target" || input.outcome === "partial"
                ? "target"
                : "relay",
            ...(input.status ? { status: input.status } : {}),
            ...(input.errorCode ? { code: input.errorCode } : {}),
          },
          metrics: {
            requestBytes: input.requestBytes,
            responseBytes: input.responseBytes,
            durationMs: input.durationMs,
          },
        },
      });
      const expiresAt = new Date(
        now.getTime() +
          parsePositiveInteger(this.env.REPORT_TTL_SECONDS, 600) * 1_000,
      ).toISOString();
      const report = ExecutionReportV1Schema.parse({
        schemaVersion: 1,
        reportId: input.reportId,
        requestId: input.requestId,
        outcome: reportOutcome(input),
        source:
          input.outcome === "target" || input.outcome === "partial"
            ? "target"
            : "relay",
        ...(input.status === undefined ? {} : { status: input.status }),
        responseBytes: input.responseBytes,
        bodyComplete: input.bodyComplete,
        ...(input.bodySha256 ? { bodySha256: input.bodySha256 } : {}),
        timing: input.timing,
        finishedAt: now.toISOString(),
        auditState: "recorded",
      });
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO execution_reports (report_id, request_id, token_id, created_at, expires_at, report_json)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(request_id, token_id) DO UPDATE SET
               report_id = excluded.report_id, created_at = excluded.created_at,
               expires_at = excluded.expires_at, report_json = excluded.report_json`,
        ).bind(
          input.reportId,
          input.requestId,
          input.tokenId,
          now.toISOString(),
          expiresAt,
          reportJson(report),
        ),
        auditInsertStatement(this.env.DB, audit),
      ]);
      if (instance.auditDegraded)
        await this.env.DB.prepare(
          "UPDATE instance_state SET audit_degraded = 0 WHERE singleton = 1",
        ).run();
      return "recorded";
    } catch (error) {
      await this.markAuditDegraded(error);
      return "degraded";
    }
  }

  private async releaseDeniedExecution(
    tokenId: string,
    requestId: string,
    code: string,
  ): Promise<void> {
    await this.env.QUOTA.getByName(tokenId).release(requestId, 0, 0);
    const instance = await ensureInstance(this.env.DB);
    await this.recordDenied(
      {
        token: "",
        requestId,
        transport: "http",
        targetUrl: "https://redacted.invalid/",
        method: "UNKNOWN",
        requestBytes: 0,
      },
      code,
      "Request denied after authentication",
      instance.configVersion,
      tokenId,
    );
  }

  private scopeAllows(
    principal: ExecutionPrincipal,
    transport: AuthorizationInput["transport"],
    target: URL,
  ): boolean {
    if (!principal.scope.transports.includes(transport)) return false;
    if (
      principal.scope.origins.length > 0 &&
      !principal.scope.origins.includes(target.origin)
    )
      return false;
    const port = target.port
      ? Number.parseInt(target.port, 10)
      : target.protocol === "https:"
        ? 443
        : 80;
    return (
      principal.scope.ports.length === 0 || principal.scope.ports.includes(port)
    );
  }

  private async recordAccepted(
    input: AuthorizationInput,
    tokenId: string,
    configVersion: string,
  ): Promise<string> {
    const event = await buildAuditEvent({
      signingKey: this.env.AUDIT_SIGNING_KEY,
      event: {
        occurredAt: new Date().toISOString(),
        category: "execution",
        action: "execution.accepted",
        outcome: "success",
        severity: "info",
        actor: { type: "execution-token", credentialId: tokenId },
        correlation: { requestId: input.requestId, configVersion },
        request: requestSummary(input),
        decision: { decision: "allow", source: "default", warnings: [] },
        metrics: { requestBytes: input.requestBytes },
      },
    });
    await auditInsertStatement(this.env.DB, event).run();
    return event.eventId;
  }

  private async recordDenied(
    input: AuthorizationInput,
    code: string,
    message: string,
    configVersion: string,
    tokenId?: string,
  ): Promise<void> {
    try {
      const event = await buildAuditEvent({
        signingKey: this.env.AUDIT_SIGNING_KEY,
        event: {
          occurredAt: new Date().toISOString(),
          category: "execution",
          action: "execution.denied",
          outcome: "denied",
          severity: "warning",
          actor: tokenId
            ? { type: "execution-token", credentialId: tokenId }
            : { type: "anonymous" },
          correlation: { requestId: input.requestId, configVersion },
          request: requestSummary(input),
          decision: {
            decision: "deny",
            source: "system-rule",
            warnings: [message],
          },
          result: { source: "relay", stage: "authorization", code },
          metrics: { requestBytes: input.requestBytes },
        },
      });
      await auditInsertStatement(this.env.DB, event).run();
    } catch (error) {
      await this.markAuditDegraded(error);
    }
  }

  private async markAuditDegraded(error: unknown): Promise<void> {
    console.error(
      JSON.stringify({
        event: "audit.write.failed",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
    await this.env.DB.prepare(
      "UPDATE instance_state SET audit_degraded = 1 WHERE singleton = 1",
    ).run();
  }
}

function requestSummary(input: AuthorizationInput) {
  const target = new URL(input.targetUrl);
  return {
    transport: input.transport,
    ...(input.transport === "http" ? { method: input.method } : {}),
    origin: target.origin,
    path: target.pathname,
    query: [...target.searchParams.entries()].slice(0, 256),
  };
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function reportOutcome(
  input: CompletionInput,
): "completed" | "partial" | "timeout" | "cancelled" | "relay-error" {
  if (input.outcome === "target") return "completed";
  if (input.outcome === "partial") return "partial";
  if (input.outcome === "cancelled") return "cancelled";
  return input.errorCode === "timeout" ? "timeout" : "relay-error";
}
