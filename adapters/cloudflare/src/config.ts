import { z } from "zod";
import { PolicySetV1Schema } from "@one-fetch/protocol";

import { sha256Hex, stableStringify } from "./crypto";
import { DEFAULT_CONFIG, type RuntimeConfig } from "./types";

const quotaSchema = z
  .object({
    requestsPerMinute: z.number().int().min(1).max(100_000),
    burstPerSecond: z.number().int().min(1).max(10_000),
    concurrentHttp: z.number().int().min(1).max(10_000),
    concurrentTunnels: z.number().int().min(0).max(10_000),
    bytesPerDay: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const runtimeConfigSchema = z
  .object({
    systemPolicy: PolicySetV1Schema,
    defaultQuota: quotaSchema,
    maxRequestBytes: z.number().int().min(1).max(20_971_520),
    maxResponseBytes: z.number().int().min(1).max(20_971_520),
    maxMetadataBytes: z.number().int().min(1_024).max(49_152),
    maxRedirects: z.number().int().min(0).max(20),
    requestTimeoutMs: z.number().int().min(1_000).max(300_000),
    bodyInspectionLimitBytes: z.number().int().min(0).max(1_048_576),
  })
  .strict();

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  return runtimeConfigSchema.parse(value);
}

export function parseRuntimeConfigJson(value: string): RuntimeConfig {
  return parseRuntimeConfig(JSON.parse(value) as unknown);
}

export async function createConfigVersion(
  revision: number,
  config: RuntimeConfig,
  now: Date,
): Promise<string> {
  const timestamp = now.toISOString().replaceAll(/[-:.]/gu, "");
  const hash = (await sha256Hex(stableStringify(config))).slice(0, 8);
  return `${timestamp}-${revision}-${hash}`;
}

export async function defaultConfigRecord(now = new Date()): Promise<{
  config: RuntimeConfig;
  configJson: string;
  configVersion: string;
}> {
  const config = structuredClone(DEFAULT_CONFIG);
  return {
    config,
    configJson: stableStringify(config),
    configVersion: await createConfigVersion(1, config, now),
  };
}

export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
