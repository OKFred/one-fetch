import { sha256Hex, stableStringify } from "@one-fetch/core";
import {
  IsoDateTimeSchema,
  type OneFetchCapabilitiesV1,
} from "@one-fetch/protocol";
import { z } from "zod";

import type { ConformanceReport } from "./runner.js";

const identifier = z.string().min(1).max(256);
const observedSchema = z
  .object({
    source: z.enum(["target", "relay", "intermediary", "client"]).optional(),
    status: z.number().int().min(100).max(599).optional(),
    errorCode: identifier.optional(),
    responseBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

export const AcceptanceReportV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: IsoDateTimeSchema,
    commit: z.string().regex(/^[a-f0-9]{40}$/u),
    adapter: z.enum(["cloudflare", "supabase", "node"]),
    buildVersion: identifier,
    protocolVersion: z.literal(1),
    instanceId: identifier,
    configVersion: identifier,
    capabilitiesSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    endpoints: z
      .object({
        controlOrigin: z.url(),
        gatewayOrigin: z.url(),
        targetOrigin: z.url(),
      })
      .strict(),
    suite: z
      .object({
        passed: z.boolean(),
        results: z
          .array(
            z
              .object({
                id: identifier,
                passed: z.boolean(),
                failures: z.array(z.string().max(2_048)).max(32),
                durationMs: z.number().nonnegative(),
                observed: observedSchema.optional(),
              })
              .strict(),
          )
          .max(256),
      })
      .strict(),
    cleanup: z
      .object({
        state: z.enum(["pending", "verified", "not-applicable"]),
        resources: z
          .array(z.object({ kind: identifier, id: identifier }).strict())
          .max(64),
      })
      .strict(),
  })
  .strict();

export type AcceptanceReportV1 = z.infer<typeof AcceptanceReportV1Schema>;

export interface AcceptanceReportInput {
  commit: string;
  capabilities: OneFetchCapabilitiesV1;
  controlUrl: string;
  gatewayUrl: string;
  targetUrl: string;
  suite: ConformanceReport;
  cleanup?: AcceptanceReportV1["cleanup"];
}

function serviceOrigin(value: string, label: string): string {
  const url = new URL(value);
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(`${label} must not contain userinfo, query, or hash`);
  }
  return url.origin;
}

export async function createAcceptanceReport(
  input: AcceptanceReportInput,
): Promise<AcceptanceReportV1> {
  return AcceptanceReportV1Schema.parse({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    commit: input.commit,
    adapter: input.capabilities.provider,
    buildVersion: input.capabilities.buildVersion,
    protocolVersion: input.capabilities.protocolVersion,
    instanceId: input.capabilities.instanceId,
    configVersion: input.capabilities.configVersion,
    capabilitiesSha256: await sha256Hex(stableStringify(input.capabilities)),
    endpoints: {
      controlOrigin: serviceOrigin(input.controlUrl, "Control URL"),
      gatewayOrigin: serviceOrigin(input.gatewayUrl, "Gateway URL"),
      targetOrigin: serviceOrigin(input.targetUrl, "Target URL"),
    },
    suite: input.suite,
    cleanup: input.cleanup ?? { state: "pending", resources: [] },
  });
}

export function assertReportDoesNotContain(
  report: AcceptanceReportV1,
  forbiddenValues: readonly string[],
): void {
  const serialized = JSON.stringify(report);
  for (const value of forbiddenValues) {
    if (value.length > 0 && serialized.includes(value)) {
      throw new Error("Acceptance report contains a forbidden secret value");
    }
  }
}
