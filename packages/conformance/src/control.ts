import type {
  OneFetchControlClient,
  OneFetchControlError,
} from "@one-fetch/client";
import {
  ControlErrorV1Schema,
  type ControlFeatureV1,
} from "@one-fetch/protocol";

import type { ConformanceCaseResult, ConformanceReport } from "./runner.js";

export const CONTROL_CONFORMANCE_CASES = Object.freeze([
  { id: "control-health", access: "public" },
  { id: "control-capabilities", access: "public" },
  { id: "control-bootstrap-status", access: "public" },
  { id: "control-feature-status", access: "public" },
  { id: "control-runtime-configuration", access: "admin" },
  { id: "control-execution-token-list", access: "admin" },
  { id: "control-audit-page", access: "admin" },
  { id: "control-alert-status", access: "admin" },
  { id: "control-backup-status", access: "admin" },
] as const);

export interface ControlConformanceOptions {
  includeManagement?: boolean;
  expectedInstanceId?: string;
  executionReport?: {
    reportId: string;
    executionToken: string;
    expectedRequestId?: string;
  };
}

async function capture(
  id: string,
  operation: () => Promise<string[]>,
): Promise<ConformanceCaseResult> {
  const startedAt = performance.now();
  try {
    const failures = await operation();
    return {
      id,
      passed: failures.length === 0,
      failures,
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    return {
      id,
      passed: false,
      failures: [error instanceof Error ? error.message : String(error)],
      durationMs: performance.now() - startedAt,
    };
  }
}

function missingFeatures(
  actual: readonly { feature: ControlFeatureV1 }[],
): string[] {
  const present = new Set(actual.map(({ feature }) => feature));
  return (["alerts", "backups"] as const)
    .filter((feature) => !present.has(feature))
    .map((feature) => `missing ${feature} feature status`);
}

async function expectUnsupported(
  operation: () => Promise<unknown>,
): Promise<string[]> {
  try {
    await operation();
    return ["unsupported feature endpoint returned a success response"];
  } catch (error) {
    if (!isCanonicalControlError(error))
      return ["unsupported feature endpoint returned a non-canonical error"];
    const failures: string[] = [];
    if (error.status !== 501)
      failures.push("unsupported feature status was not 501");
    if (error.code !== "feature_unsupported")
      failures.push("unsupported feature used a different error code");
    return failures;
  }
}

export async function runControlConformance(
  client: OneFetchControlClient,
  options: ControlConformanceOptions = {},
): Promise<ConformanceReport> {
  const results: ConformanceCaseResult[] = [];
  let instanceId: string | undefined;
  let pairId: string | undefined;
  let configVersion: string | undefined;
  let policyMode: "allowlist" | "blocklist" | undefined;

  results.push(
    await capture("control-health", async () => {
      const health = await client.getHealth();
      instanceId = health.instanceId;
      const failures: string[] = [];
      if (health.service !== "one-fetch-control")
        failures.push("health returned an unexpected service");
      if (health.status !== "ok" && health.status !== "degraded")
        failures.push("health returned an unexpected status");
      return failures;
    }),
  );

  results.push(
    await capture("control-capabilities", async () => {
      const capabilities = await client.getCapabilities();
      if (instanceId !== undefined && capabilities.instanceId !== instanceId)
        return ["health and capabilities instance IDs differ"];
      instanceId = capabilities.instanceId;
      pairId = capabilities.controlGatewayPairId;
      configVersion = capabilities.configVersion;
      policyMode = capabilities.policyMode;
      return options.expectedInstanceId !== undefined &&
        capabilities.instanceId !== options.expectedInstanceId
        ? [
            `expected instance ${options.expectedInstanceId}, received ${capabilities.instanceId}`,
          ]
        : [];
    }),
  );
  results.push(
    await capture("control-bootstrap-status", async () => {
      const bootstrap = await client.getBootstrapStatus();
      return instanceId !== undefined && bootstrap.instanceId !== instanceId
        ? ["bootstrap and capabilities instance IDs differ"]
        : [];
    }),
  );
  results.push(
    await capture("control-feature-status", async () => {
      const status = await client.getFeatureStatuses();
      return missingFeatures(status.features);
    }),
  );

  if (options.includeManagement === true) {
    results.push(
      await capture("control-runtime-configuration", async () => {
        const configuration = await client.getConfiguration();
        const failures: string[] = [];
        if (instanceId !== undefined && configuration.instanceId !== instanceId)
          failures.push("configuration and capabilities instance IDs differ");
        if (
          pairId !== undefined &&
          configuration.controlGatewayPairId !== pairId
        )
          failures.push("configuration and capabilities pair IDs differ");
        if (
          configVersion !== undefined &&
          configuration.version !== configVersion
        )
          failures.push("configuration and capabilities versions differ");
        if (
          policyMode !== undefined &&
          configuration.policy.mode !== policyMode
        )
          failures.push("configuration and capabilities policy modes differ");
        return failures;
      }),
    );
    results.push(
      await capture("control-execution-token-list", async () => {
        await client.listExecutionTokens();
        return [];
      }),
    );
    results.push(
      await capture("control-audit-page", async () => {
        await client.getAuditPage({ limit: 1 });
        return [];
      }),
    );
    results.push(
      await capture("control-alert-status", () =>
        expectUnsupported(() => client.getAlerts()),
      ),
    );
    results.push(
      await capture("control-backup-status", () =>
        expectUnsupported(() => client.getBackups()),
      ),
    );
  }

  const executionReport = options.executionReport;
  if (executionReport !== undefined) {
    results.push(
      await capture("control-owned-execution-report", async () => {
        const report = await client.getExecutionReport(
          executionReport.reportId,
          executionReport.executionToken,
        );
        return executionReport.expectedRequestId !== undefined &&
          report.requestId !== executionReport.expectedRequestId
          ? ["execution report request ID differs"]
          : [];
      }),
    );
  }

  return { passed: results.every(({ passed }) => passed), results };
}

export async function validateControlErrorResponse(
  response: Response,
): Promise<string[]> {
  if (response.ok) return ["expected a non-success Control response"];
  try {
    const parsed = ControlErrorV1Schema.safeParse(
      await response.clone().json(),
    );
    return parsed.success ? [] : ["response is not a canonical Control error"];
  } catch {
    return ["response is not JSON"];
  }
}

export function isCanonicalControlError(
  error: unknown,
): error is OneFetchControlError {
  return (
    error instanceof Error &&
    error.name === "OneFetchControlError" &&
    "code" in error &&
    typeof error.code === "string"
  );
}
