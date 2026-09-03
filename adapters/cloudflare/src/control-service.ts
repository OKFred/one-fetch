import { OneFetchCapabilitiesV1Schema } from "@one-fetch/protocol";
import { WorkerEntrypoint } from "cloudflare:workers";

import { auditInsertStatement, buildAuditEvent } from "./audit";
import { releaseExecution } from "./execution-recording";
import {
  authorizationInputSchema,
  authorizationResultSchema,
  completionInputSchema,
  executionDecisionInputSchema,
  parseJsonWithSchema,
} from "./service-schemas";
import { ensureInstance, createCapabilities } from "./storage";
import type {
  AuthorizationInput,
  AuthorizationResult,
  CompletionInput,
  ExecutionDecisionInput,
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
    return releaseExecution(this.env, parsed);
  }

  async recordExecutionDecisionJson(
    inputJson: string,
  ): Promise<"recorded" | "degraded"> {
    const input = parseJsonWithSchema(
      inputJson,
      executionDecisionInputSchema,
    ) as ExecutionDecisionInput;
    if (input.decision.decision === "deny") {
      await this.env.QUOTA.getByName(input.tokenId).release(
        input.requestId,
        0,
        input.requestBytes,
      );
    }
    return this.recordDecision(input);
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
      const auditState = await this.recordDenied(
        input,
        "forbidden",
        "Gateway is paused",
        instance.configVersion,
        undefined,
        { decision: "deny", source: "system-rule", warnings: [] },
      );
      return {
        allowed: false,
        code: "forbidden",
        message: "Gateway is paused",
        auditState,
      };
    }

    const auth = this.env.AUTH.getByName("instance-auth");
    const principal = await auth.verifyExecutionToken(input.token);
    if (!principal) {
      const auditState = await this.recordDenied(
        input,
        "unauthorized",
        "Execution token is invalid",
        instance.configVersion,
      );
      return {
        allowed: false,
        code: "unauthorized",
        message: "Execution token is invalid",
        auditState,
      };
    }

    let target: URL;
    try {
      target = new URL(input.targetUrl);
    } catch {
      const auditState = await this.recordDenied(
        input,
        "target_not_allowed",
        "Target URL is invalid",
        instance.configVersion,
      );
      return {
        allowed: false,
        code: "target_not_allowed",
        message: "Target URL is invalid",
        auditState,
      };
    }
    if (!this.scopeAllows(principal, input.transport, target)) {
      const auditState = await this.recordDenied(
        input,
        "forbidden",
        "Execution token scope denied the target",
        instance.configVersion,
        principal.tokenId,
        { decision: "deny", source: "system-rule", warnings: [] },
      );
      return {
        allowed: false,
        code: "forbidden",
        message: "Execution token scope denied the target",
        auditState,
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
      const auditState = await this.recordDenied(
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
        auditState,
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

  private async recordDecision(
    input: ExecutionDecisionInput,
  ): Promise<"recorded" | "degraded"> {
    try {
      const denied = input.decision.decision === "deny";
      const event = await buildAuditEvent({
        signingKey: this.env.AUDIT_SIGNING_KEY,
        event: {
          occurredAt: new Date().toISOString(),
          category: "execution",
          action: denied ? "execution.denied" : "execution.accepted",
          outcome: denied ? "denied" : "success",
          severity: denied ? "warning" : "info",
          actor: {
            type: "execution-token",
            credentialId: input.tokenId,
          },
          correlation: {
            requestId: input.requestId,
            configVersion: input.configVersion,
          },
          request: requestSummary(input),
          decision: input.decision,
          ...(input.code
            ? {
                result: {
                  source: "relay" as const,
                  stage: "policy",
                  code: input.code,
                },
              }
            : {}),
          metrics: { requestBytes: input.requestBytes },
        },
      });
      await auditInsertStatement(this.env.DB, event).run();
      return "recorded";
    } catch (error) {
      await this.markAuditDegraded(error);
      return "degraded";
    }
  }

  private async recordDenied(
    input: AuthorizationInput,
    code: string,
    message: string,
    configVersion: string,
    tokenId?: string,
    decision?: ExecutionDecisionInput["decision"],
  ): Promise<"recorded" | "degraded"> {
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
          ...(decision
            ? {
                decision: {
                  ...decision,
                  warnings: [...decision.warnings, message],
                },
              }
            : {}),
          result: { source: "relay", stage: "authorization", code },
          metrics: { requestBytes: input.requestBytes },
        },
      });
      await auditInsertStatement(this.env.DB, event).run();
      return "recorded";
    } catch (error) {
      await this.markAuditDegraded(error);
      return "degraded";
    }
  }

  private async markAuditDegraded(error: unknown): Promise<void> {
    console.error(
      JSON.stringify({
        event: "audit.write.failed",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
    try {
      await this.env.DB.prepare(
        "UPDATE instance_state SET audit_degraded = 1 WHERE singleton = 1",
      ).run();
    } catch (markError) {
      console.error(
        JSON.stringify({
          event: "audit.degraded-marker.failed",
          error: markError instanceof Error ? markError.message : "unknown",
        }),
      );
    }
  }
}

function requestSummary(input: AuthorizationInput | ExecutionDecisionInput) {
  const summary = {
    transport: input.transport,
    ...(input.transport === "http" ? { method: input.method } : {}),
    ...("headers" in input ? { headers: input.headers } : {}),
    ...("contentType" in input && input.contentType
      ? { contentType: input.contentType }
      : {}),
  };
  try {
    const target = new URL(input.targetUrl);
    return {
      ...summary,
      origin: target.origin,
      path: target.pathname,
      query: [...target.searchParams.entries()].slice(0, 256),
    };
  } catch {
    return summary;
  }
}
