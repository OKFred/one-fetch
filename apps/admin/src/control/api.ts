import { OneFetchControlClient, OneFetchControlError } from "@one-fetch/client";
import {
  AuditEventV1Schema,
  BootstrapRequestV1Schema,
  BootstrapStatusV1Schema,
  CreatedExecutionTokenV1Schema,
  CreateExecutionTokenRequestV1Schema,
  ExecutionTokenRecordV1Schema,
  LoginRequestV1Schema,
  OneFetchCapabilitiesV1Schema,
  PolicySetV1Schema,
  SessionTokenPairV1Schema,
  type CreateExecutionTokenRequestV1,
  type CreatedExecutionTokenV1,
  type LoginRequestV1,
  type OneFetchCapabilitiesV1,
  type PolicySetV1,
} from "@one-fetch/protocol";
import type {
  AdminSessionPair,
  AuditPage,
  BootstrapState,
  RuntimeConfiguration,
} from "./types";

type Provider = OneFetchCapabilitiesV1["provider"];
type JsonObject = Record<string, unknown>;

export class UnsupportedControlFeatureError extends Error {
  constructor(readonly feature: string) {
    super(`${feature} is not implemented by this control adapter`);
    this.name = "UnsupportedControlFeatureError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function integer(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : fallback;
}

async function parseError(error: unknown): Promise<Error> {
  if (!(error instanceof OneFetchControlError))
    return error instanceof Error ? error : new Error(String(error));
  let detail = "";
  try {
    const payload: unknown = await error.response.json();
    if (isObject(payload)) {
      const nested = isObject(payload.error) ? payload.error : undefined;
      detail =
        text(nested?.message) || text(payload.message) || text(payload.error);
    }
  } catch {
    // Keep the status-only error when the body is not JSON.
  }
  return new Error(
    detail || `Control request failed with HTTP ${error.status}`,
  );
}

function normalizeSession(value: unknown): AdminSessionPair {
  const parsed = SessionTokenPairV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!isObject(value)) throw new Error("Control returned an invalid session");
  const accessToken = text(value.accessToken);
  const refreshToken = text(value.refreshToken);
  const accessExpiresAt = text(value.accessExpiresAt);
  const refreshExpiresAt = text(value.refreshExpiresAt);
  if (
    accessToken.length < 32 ||
    refreshToken.length < 32 ||
    !Number.isFinite(Date.parse(accessExpiresAt)) ||
    !Number.isFinite(Date.parse(refreshExpiresAt))
  ) {
    throw new Error("Control returned an invalid session");
  }
  const sessionId = text(value.sessionId);
  return {
    accessToken,
    accessExpiresAt,
    refreshToken,
    refreshExpiresAt,
    ...(sessionId ? { sessionId } : {}),
  };
}

export class AdminControlApi {
  private client: OneFetchControlClient;
  private provider: Provider | null = null;

  constructor(controlUrl: string, accessToken?: string) {
    this.client = new OneFetchControlClient({
      controlUrl,
      ...(accessToken ? { accessToken } : {}),
    });
  }

  setAccessToken(token: string | undefined): void {
    this.client.setAccessToken(token);
  }

  async capabilities(): Promise<OneFetchCapabilitiesV1> {
    try {
      const value = OneFetchCapabilitiesV1Schema.parse(
        await this.client.getCapabilities(),
      );
      this.provider = value.provider;
      return value;
    } catch (error) {
      throw await parseError(error);
    }
  }

  async bootstrapStatus(): Promise<BootstrapState> {
    try {
      const response = await this.requestFirst(
        ["/api/v1/bootstrap/status", "/api/v1/bootstrap"],
        { method: "GET" },
      );
      const value: unknown = await response.json();
      const protocol = BootstrapStatusV1Schema.safeParse(value);
      if (protocol.success)
        return { initialized: protocol.data.initialized, supported: true };
      if (isObject(value) && typeof value.required === "boolean")
        return { initialized: !value.required, supported: true };
      throw new Error("Control returned an invalid bootstrap state");
    } catch (error) {
      if (isUnsupported(error)) return { initialized: true, supported: false };
      throw await parseError(error);
    }
  }

  async bootstrap(input: {
    bootstrapSecret: string;
    username: string;
    password: string;
  }): Promise<AdminSessionPair | null> {
    const canonical = BootstrapRequestV1Schema.parse({
      schemaVersion: 1,
      ...input,
    });
    const body = this.provider === "supabase" ? canonical : input;
    try {
      const response = await this.client.request("/api/v1/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status === 204) return null;
      const payload: unknown = await response.json();
      if (isObject(payload) && typeof payload.accessToken === "string")
        return normalizeSession(payload);
      return null;
    } catch (error) {
      throw await parseError(error);
    }
  }

  async login(input: LoginRequestV1): Promise<AdminSessionPair> {
    const canonical = LoginRequestV1Schema.parse(input);
    if (this.provider === "supabase") {
      try {
        return await this.client.login(canonical);
      } catch (error) {
        throw await parseError(error);
      }
    }
    const body = {
      username: canonical.username,
      password: canonical.password,
      ...(canonical.totpCode ? { totpCode: canonical.totpCode } : {}),
      ...(canonical.recoveryCode
        ? { recoveryCode: canonical.recoveryCode }
        : {}),
      ...(canonical.deviceFingerprint
        ? { fingerprint: canonical.deviceFingerprint }
        : {}),
    };
    return this.postSession("/api/v1/auth/login", body);
  }

  async refresh(refreshToken: string): Promise<AdminSessionPair> {
    const body =
      this.provider === "supabase"
        ? { schemaVersion: 1, refreshToken }
        : { refreshToken };
    return this.postSession("/api/v1/auth/refresh", body);
  }

  async configuration(): Promise<RuntimeConfiguration> {
    const path =
      this.provider === "cloudflare"
        ? "/api/v1/admin/config"
        : "/api/v1/config";
    const response = await this.client.request(path);
    const etag = response.headers.get("etag") ?? undefined;
    const payload: unknown = await response.json();
    return parseConfiguration(payload, etag);
  }

  async savePolicy(
    config: RuntimeConfiguration,
    policy: PolicySetV1,
  ): Promise<RuntimeConfiguration> {
    const validated = PolicySetV1Schema.parse(policy);
    if (this.provider === "node") {
      return this.putConfiguration(
        "/api/v1/config/policy",
        validated,
        undefined,
      );
    }
    const raw = structuredClone(config.raw);
    if (this.provider === "cloudflare") raw.systemPolicy = validated;
    else raw.policy = validated;
    const body = this.provider === "cloudflare" ? { config: raw } : raw;
    const match =
      this.provider === "cloudflare"
        ? (config.etag ?? config.version)
        : String(config.revision);
    const path =
      this.provider === "cloudflare"
        ? "/api/v1/admin/config"
        : "/api/v1/config";
    return this.putConfiguration(path, body, match);
  }

  async setGatewayPaused(
    config: RuntimeConfiguration,
    paused: boolean,
  ): Promise<RuntimeConfiguration> {
    if (this.provider === "supabase") {
      const raw = { ...config.raw, gatewayPaused: paused };
      return this.putConfiguration(
        "/api/v1/config",
        raw,
        String(config.revision),
      );
    }
    throw new UnsupportedControlFeatureError("gateway-pause");
  }

  async listTokens() {
    const path =
      this.provider === "cloudflare"
        ? "/api/v1/admin/tokens"
        : this.provider === "supabase"
          ? "/api/v1/tokens"
          : "/api/v1/tokens/execution";
    try {
      const payload: unknown = await (await this.client.request(path)).json();
      const list = Array.isArray(payload)
        ? payload
        : isObject(payload) && Array.isArray(payload.tokens)
          ? payload.tokens
          : [];
      return ExecutionTokenRecordV1Schema.array().parse(list);
    } catch (error) {
      if (isUnsupported(error))
        throw new UnsupportedControlFeatureError("execution-token-list");
      throw await parseError(error);
    }
  }

  async createToken(
    input: CreateExecutionTokenRequestV1,
  ): Promise<CreatedExecutionTokenV1> {
    const body = CreateExecutionTokenRequestV1Schema.parse(input);
    const path =
      this.provider === "cloudflare"
        ? "/api/v1/admin/tokens"
        : this.provider === "supabase"
          ? "/api/v1/tokens"
          : "/api/v1/tokens/execution";
    const payload: unknown = await (
      await this.client.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          this.provider === "node"
            ? {
                scopes: body.scope.transports,
                allowedOrigins: body.scope.origins,
              }
            : body,
        ),
      })
    ).json();
    const direct = CreatedExecutionTokenV1Schema.safeParse(payload);
    if (direct.success) return direct.data;
    if (isObject(payload) && typeof payload.token === "string") {
      const credential = isObject(payload.credential)
        ? payload.credential
        : { ...payload, token: undefined };
      return CreatedExecutionTokenV1Schema.parse({
        schemaVersion: 1,
        credential: { schemaVersion: 1, ...credential },
        token: payload.token,
      });
    }
    throw new Error("Control returned an invalid execution token");
  }

  async revokeToken(id: string): Promise<void> {
    const base =
      this.provider === "cloudflare"
        ? "/api/v1/admin/tokens"
        : this.provider === "supabase"
          ? "/api/v1/tokens"
          : "/api/v1/tokens/execution";
    try {
      await this.client.request(
        `${base}/${encodeURIComponent(id)}` as `/api/v1/${string}`,
        { method: "DELETE" },
      );
    } catch (error) {
      if (isUnsupported(error))
        throw new UnsupportedControlFeatureError("execution-token-revoke");
      throw await parseError(error);
    }
  }

  async auditPage(cursor?: string): Promise<AuditPage> {
    const base =
      this.provider === "cloudflare" ? "/api/v1/admin/audit" : "/api/v1/audit";
    const query = cursor
      ? `?limit=50&before=${encodeURIComponent(cursor)}`
      : "?limit=50";
    const payload: unknown = await (
      await this.client.request(`${base}${query}` as `/api/v1/${string}`)
    ).json();
    const rawEvents = isObject(payload)
      ? Array.isArray(payload.events)
        ? payload.events
        : Array.isArray(payload.items)
          ? payload.items
          : []
      : Array.isArray(payload)
        ? payload
        : [];
    const events = rawEvents.flatMap((event) => {
      const result = AuditEventV1Schema.safeParse(event);
      return result.success ? [result.data] : [];
    });
    const cursorValue = isObject(payload)
      ? (payload.nextCursor ?? payload.nextBeforeSequence)
      : undefined;
    const next =
      typeof cursorValue === "string" || typeof cursorValue === "number"
        ? String(cursorValue)
        : "";
    return { events, ...(next ? { nextCursor: next } : {}) };
  }

  async exportAudit(): Promise<Blob> {
    try {
      const response = await this.requestFirst([
        "/api/v1/audit/export",
        "/api/v1/admin/audit/export",
      ]);
      return response.blob();
    } catch (error) {
      if (isUnsupported(error))
        throw new UnsupportedControlFeatureError("audit-export");
      throw await parseError(error);
    }
  }

  async requestFeature(
    path: `/api/v1/${string}`,
    init?: RequestInit,
  ): Promise<unknown> {
    try {
      const response = await this.client.request(path, init);
      if (response.status === 204) return null;
      return (await response.json()) as unknown;
    } catch (error) {
      if (isUnsupported(error)) throw new UnsupportedControlFeatureError(path);
      throw await parseError(error);
    }
  }

  private async postSession(path: `/api/v1/${string}`, body: unknown) {
    try {
      const response = await this.client.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const session = normalizeSession(await response.json());
      this.setAccessToken(session.accessToken);
      return session;
    } catch (error) {
      throw await parseError(error);
    }
  }

  private async putConfiguration(
    path: `/api/v1/${string}`,
    body: unknown,
    match: string | undefined,
  ): Promise<RuntimeConfiguration> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (match)
      headers["If-Match"] = match.startsWith('"') ? match : `"${match}"`;
    const response = await this.client.request(path, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
    return parseConfiguration(
      await response.json(),
      response.headers.get("etag") ?? undefined,
    );
  }

  private async requestFirst(
    paths: readonly `/api/v1/${string}`[],
    init?: RequestInit,
  ): Promise<Response> {
    for (const [index, path] of paths.entries()) {
      try {
        return await this.client.request(path, init);
      } catch (error) {
        if (index === paths.length - 1 || !isUnsupported(error)) throw error;
      }
    }
    throw new UnsupportedControlFeatureError(paths[0] ?? "feature");
  }
}

function parseConfiguration(
  value: unknown,
  etag?: string,
): RuntimeConfiguration {
  if (!isObject(value))
    throw new Error("Control returned an invalid configuration");
  const raw = isObject(value.config) ? value.config : value;
  const policyValue = raw.policy ?? raw.systemPolicy ?? value.policy;
  const policy = PolicySetV1Schema.parse(policyValue);
  return {
    version: text(value.version, text(value.configVersion, "unknown")),
    updatedAt: text(value.updatedAt, text(value.configUpdatedAt, "")),
    revision: integer(value.revision, policy.revision),
    gatewayPaused:
      typeof raw.gatewayPaused === "boolean" ? raw.gatewayPaused : false,
    policy,
    raw,
    ...(etag ? { etag } : {}),
  };
}

function isUnsupported(error: unknown): boolean {
  return (
    error instanceof UnsupportedControlFeatureError ||
    (error instanceof OneFetchControlError &&
      (error.status === 404 || error.status === 405 || error.status === 501))
  );
}
