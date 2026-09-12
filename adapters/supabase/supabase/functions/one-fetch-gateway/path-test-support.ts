import {
  encodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_TOKEN_HEADER,
} from "@one-fetch/protocol";
import type {
  JsonValue,
  OneFetchRequestMetaV1,
  PolicySetV1,
} from "../_shared/protocol-types.ts";
import type { Database } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { bytesToBase64Url } from "../_shared/crypto.ts";
import { createGatewayTestHandler } from "./test-support.ts";

export const pathToken = "ofe_synthetic_path_token_only";
export const targetOrigin = "https://fixture.example";

export async function pathHarness(policy?: PolicySetV1) {
  const key = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in key)) throw new Error("Expected key pair");
  const environment: SupabaseEnvironment = {
    instanceId: "00000000-0000-4000-8000-000000000001",
    bootstrapSecret: "b".repeat(32),
    pepper: "p".repeat(32),
    auditSigningPrivateKey: bytesToBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey)),
    ),
    auditKeyId: "path-test",
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "synthetic-role",
    controlBaseUrl:
      "https://project.supabase.co/functions/v1/one-fetch-control",
    gatewayBaseUrl:
      "https://project.supabase.co/functions/v1/one-fetch-gateway",
    allowedAdminOrigins: [],
    allowedClientOrigins: [],
    buildVersion: "path-test",
  };
  const calls: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const reports: Array<Record<string, unknown>> = [];
  let reportReady: (() => void) | undefined;
  const firstReport = new Promise<void>((resolve) => {
    reportReady = resolve;
  });
  const database: Database = {
    rpc: <T>(name: string, parameters: Record<string, unknown> = {}) => {
      calls.push(name);
      let value: unknown;
      switch (name) {
        case "of_authenticate_execution":
          value = {
            tokenId: "00000000-0000-4000-8000-000000000002",
            name: "path-test",
            scopes: {
              transports: ["http"],
              origins: [targetOrigin],
              ports: [443],
            },
            quotas: {
              requestsPerMinute: 60,
              burst: 10,
              concurrentHttp: 4,
              concurrentTunnels: 0,
              bytesPerDay: 1_073_741_824,
            },
          };
          break;
        case "of_get_active_config":
          value = {
            instanceId: environment.instanceId,
            initialized: true,
            version: "config-path-test",
            config: {
              gatewayPaused: false,
              policy: policy ?? {
                schemaVersion: 1,
                mode: "blocklist",
                revision: 0,
                rules: [],
              },
              bodyInspectionBytes: 1_048_576,
            },
          };
          break;
        case "of_append_audit":
          events.push(parameters.p_event as Record<string, unknown>);
          value = crypto.randomUUID();
          break;
        case "of_acquire_execution":
          value = { allowed: true, leaseId: crypto.randomUUID() };
          break;
        case "of_reconcile_execution_request":
          value = { allowed: true };
          break;
        case "of_finalize_execution":
          reports.push(parameters.p_report as Record<string, unknown>);
          if (parameters.p_audit)
            events.push(parameters.p_audit as Record<string, unknown>);
          value = { status: "finalized", auditState: "recorded" };
          reportReady?.();
          break;
        default:
          throw new Error(`Unexpected RPC ${name}`);
      }
      return Promise.resolve(value as T);
    },
  };
  return {
    environment,
    calls,
    events,
    reports,
    waitForReport: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          firstReport,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Report finalization timed out")),
              5_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    handler: createGatewayTestHandler(environment, database),
  };
}

export function boundPathRequest(
  base: string,
  observed: string,
  binding: JsonValue | undefined,
  options: Pick<OneFetchRequestMetaV1, "userDenyRules"> & {
    redirect?: "manual" | "follow";
  } = {},
) {
  return new Request(`${base}${observed}`, {
    headers: {
      [ONE_FETCH_TOKEN_HEADER]: pathToken,
      [ONE_FETCH_REQUEST_HEADER]: encodeRequestMetadata({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        nonce: crypto.randomUUID().replaceAll("-", ""),
        transport: "http",
        targetOrigin,
        targetHeaders: [],
        fetchOptions: {
          redirect: options.redirect ?? "manual",
          timeoutMs: 60_000,
          adapter: {
            supabaseAcceptMutations: true,
            ...(binding === undefined
              ? {}
              : { supabaseOriginalPathV1: binding }),
          },
        },
        body: { sizeBytes: 0 },
        hop: 0,
        ...(options.userDenyRules
          ? { userDenyRules: options.userDenyRules }
          : {}),
      }),
    },
  });
}
