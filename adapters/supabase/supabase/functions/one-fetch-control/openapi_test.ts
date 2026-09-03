import type { Database } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { createControlTestHandler as createControlHandler } from "./test-support.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const environment: SupabaseEnvironment = {
  instanceId: "00000000-0000-4000-8000-000000000001",
  bootstrapSecret: "b".repeat(32),
  pepper: "p".repeat(32),
  auditSigningPrivateKey: "unused",
  auditKeyId: "test",
  supabaseUrl: "https://example.supabase.co",
  serviceRoleKey: "test-service-role",
  controlBaseUrl: "https://configured.example/functions/v1/one-fetch-control",
  gatewayBaseUrl: "https://example.supabase.co/functions/v1/one-fetch-gateway",
  allowedAdminOrigins: [],
  allowedClientOrigins: [],
  buildVersion: "test",
};

const database: Database = {
  rpc: () => Promise.reject(new Error("unexpected database access")),
};

type OpenApiDocument = {
  servers?: { url?: string }[];
  paths?: Record<
    string,
    { post?: { responses?: Record<string, { description?: string }> } }
  >;
};

Deno.test(
  "Supabase OpenAPI derives the complete Edge Function base URL",
  async () => {
    const response = await createControlHandler(
      environment,
      database,
    )(
      new Request(
        "https://actual.example/functions/v1/one-fetch-control/api/v1/openapi.json?ignored=1",
        { headers: { "x-one-fetch-runtime-control-base": "https://spoofed" } },
      ),
    );
    const document = (await response.json()) as OpenApiDocument;
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(
      document.servers?.[0]?.url ===
        "https://actual.example/functions/v1/one-fetch-control",
      `unexpected server URL ${document.servers?.[0]?.url}`,
    );
  },
);

Deno.test(
  "Supabase OpenAPI exposes adapter-specific login and password errors",
  async () => {
    const response = await createControlHandler(
      environment,
      database,
    )(
      new Request(
        "https://actual.example/functions/v1/one-fetch-control/api/v1/openapi.json",
      ),
    );
    const document = (await response.json()) as OpenApiDocument;
    assert(
      document.paths?.["/api/v1/auth/login"]?.post?.responses?.["501"] !==
        undefined,
      "login does not advertise unsupported TOTP",
    );
    assert(
      document.paths?.["/api/v1/auth/password"]?.post?.responses?.["409"] !==
        undefined,
      "password change does not advertise its CAS conflict",
    );
  },
);

Deno.test(
  "Supabase OpenAPI replaces unavailable TOTP successes with 501",
  async () => {
    const response = await createControlHandler(
      environment,
      database,
    )(
      new Request(
        "https://actual.example/functions/v1/one-fetch-control/api/v1/openapi.json",
      ),
    );
    const document = (await response.json()) as OpenApiDocument;
    for (const path of [
      "/api/v1/auth/totp/prepare",
      "/api/v1/auth/totp/enable",
    ]) {
      const responses = document.paths?.[path]?.post?.responses;
      assert(responses !== undefined, `missing ${path}`);
      assert(responses["200"] === undefined, `${path} still advertises 200`);
      assert(responses["400"] === undefined, `${path} still advertises 400`);
      assert(
        responses["401"] !== undefined,
        `${path} lost authentication error`,
      );
      assert(
        responses["501"]?.description?.includes("Supabase Preview") === true,
        `${path} does not describe the adapter limitation`,
      );
    }
  },
);
