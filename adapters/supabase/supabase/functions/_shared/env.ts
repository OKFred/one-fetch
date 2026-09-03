import { z } from "zod";

const HttpOriginSchema = z
  .string()
  .url()
  .transform((value, context) => {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Expected an HTTP(S) origin without path, credentials, query, or fragment",
      });
      return z.NEVER;
    }
    return url.origin;
  });

function commaSeparatedOrigins(
  value: string | undefined,
  allowExtension = false,
): string[] {
  if (!value?.trim()) return [];
  return value.split(",").map((item) => {
    const candidate = item.trim().replace(/\/$/u, "");
    if (allowExtension && /^chrome-extension:\/\/[a-p]{32}$/u.test(candidate)) {
      return candidate;
    }
    return HttpOriginSchema.parse(candidate);
  });
}

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export interface SupabaseEnvironment {
  instanceId: string;
  bootstrapSecret: string;
  pepper: string;
  auditSigningPrivateKey: string;
  auditKeyId: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  controlBaseUrl: string;
  gatewayBaseUrl: string;
  allowedAdminOrigins: string[];
  allowedClientOrigins: string[];
  buildVersion: string;
}

let cached: SupabaseEnvironment | undefined;

export function getEnvironment(): SupabaseEnvironment {
  if (cached) return cached;
  const instanceId = z.string().uuid().parse(required("ONE_FETCH_INSTANCE_ID"));
  const bootstrapSecret = required("ONE_FETCH_BOOTSTRAP_SECRET");
  const pepper = required("ONE_FETCH_PEPPER");
  if (bootstrapSecret.length < 32 || pepper.length < 32) {
    throw new Error("one-fetch secrets must contain at least 32 characters");
  }

  cached = {
    instanceId,
    bootstrapSecret,
    pepper,
    auditSigningPrivateKey: required("ONE_FETCH_AUDIT_SIGNING_PRIVATE_KEY"),
    auditKeyId: required("ONE_FETCH_AUDIT_KEY_ID"),
    supabaseUrl: required("SUPABASE_URL").replace(/\/$/u, ""),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    controlBaseUrl: required("ONE_FETCH_CONTROL_BASE_URL").replace(/\/$/u, ""),
    gatewayBaseUrl: required("ONE_FETCH_GATEWAY_BASE_URL").replace(/\/$/u, ""),
    allowedAdminOrigins: commaSeparatedOrigins(
      Deno.env.get("ONE_FETCH_ALLOWED_ADMIN_ORIGINS"),
    ),
    allowedClientOrigins: commaSeparatedOrigins(
      Deno.env.get("ONE_FETCH_ALLOWED_CLIENT_ORIGINS"),
      true,
    ),
    buildVersion: Deno.env.get("ONE_FETCH_BUILD_VERSION") ?? "0.1.0-preview",
  };
  return cached;
}

export function clearEnvironmentCacheForTests(): void {
  cached = undefined;
}
