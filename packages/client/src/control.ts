import {
  AlertsResponseV1Schema,
  AuditPageQueryV1Schema,
  AuditPageV1Schema,
  BackupsResponseV1Schema,
  BootstrapRequestV1Schema,
  BootstrapStatusV1Schema,
  CONTROL_ROUTES_V1,
  ChangePasswordRequestV1Schema,
  ChangePasswordResponseV1Schema,
  ControlErrorV1Schema,
  ControlFeatureStatusListV1Schema,
  ControlFeatureStatusV1Schema,
  CreateExecutionTokenRequestV1Schema,
  CreatedExecutionTokenV1Schema,
  ExecutionReportV1Schema,
  ExecutionTokenListV1Schema,
  ExecutionTokenRevokeResponseV1Schema,
  HealthResponseV1Schema,
  LoginRequestV1Schema,
  LogoutResponseV1Schema,
  OneFetchCapabilitiesV1Schema,
  RefreshRequestV1Schema,
  RuntimeConfigurationV1Schema,
  SessionListV1Schema,
  SessionRevokeResponseV1Schema,
  SessionTokenPairV1Schema,
  SetGatewayPausedRequestV1Schema,
  TotpEnableRequestV1Schema,
  TotpEnableResponseV1Schema,
  TotpPrepareResponseV1Schema,
  UpdatePolicyRequestV1Schema,
  type AlertsResponseV1,
  type AuditPageQueryV1,
  type AuditPageV1,
  type BackupsResponseV1,
  type BootstrapRequestV1,
  type BootstrapStatusV1,
  type ChangePasswordRequestV1,
  type ChangePasswordResponseV1,
  type ControlApiV1Path,
  type ControlErrorV1,
  type ControlFeatureStatusListV1,
  type ControlFeatureStatusV1,
  type ControlFeatureV1,
  type CreateExecutionTokenRequestV1,
  type CreatedExecutionTokenV1,
  type ExecutionReportV1,
  type ExecutionTokenListV1,
  type ExecutionTokenRevokeResponseV1,
  type HealthResponseV1,
  type LoginRequestV1,
  type LogoutResponseV1,
  type OneFetchCapabilitiesV1,
  type RefreshRequestV1,
  type RuntimeConfigurationV1,
  type SessionListV1,
  type SessionRevokeResponseV1,
  type SessionTokenPairV1,
  type SetGatewayPausedRequestV1,
  type TotpEnableRequestV1,
  type TotpEnableResponseV1,
  type TotpPrepareResponseV1,
  type UpdatePolicyRequestV1,
} from "@one-fetch/protocol";
import type { z } from "zod";

import { buildServiceUrl, serviceBaseUrl } from "./url.js";

export interface OneFetchControlClientOptions {
  controlUrl: string;
  accessToken?: string;
  fetch?: typeof globalThis.fetch;
}

type ControlErrorDetail = ControlErrorV1["error"];

export class OneFetchControlError extends Error {
  readonly status: number;
  readonly response: Response;
  readonly code: string;
  readonly retryable: boolean;
  readonly correlationId: string | undefined;

  constructor(response: Response, detail?: ControlErrorDetail) {
    super(
      detail?.message ?? `Control request failed with HTTP ${response.status}`,
    );
    this.name = "OneFetchControlError";
    this.status = response.status;
    this.response = response;
    this.code = detail?.code ?? "control_http_error";
    this.retryable = detail?.retryable ?? false;
    this.correlationId = detail?.correlationId;
  }
}

function jsonRequest(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function quoteEtag(version: string): string {
  if (version.length === 0 || version.length > 256 || /["\r\n]/u.test(version))
    throw new TypeError("Invalid configuration version");
  return `"${version}"`;
}

function withCursor(path: ControlApiV1Path, cursor?: string): ControlApiV1Path {
  if (cursor === undefined) return path;
  if (cursor.length === 0 || cursor.length > 1_024)
    throw new TypeError("Invalid pagination cursor");
  return `${path}?cursor=${encodeURIComponent(cursor)}` as ControlApiV1Path;
}

export class OneFetchControlClient {
  readonly controlOrigin: string;
  readonly controlBaseUrl: string;
  #accessToken: string | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: OneFetchControlClientOptions) {
    this.controlBaseUrl = serviceBaseUrl(options.controlUrl, "Control URL");
    this.controlOrigin = new URL(this.controlBaseUrl).origin;
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  setAccessToken(token: string | undefined): void {
    this.#accessToken = token;
  }

  async request(
    path: ControlApiV1Path,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = buildServiceUrl(this.controlBaseUrl, path, "Control URL");
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (this.#accessToken !== undefined && !headers.has("Authorization"))
      headers.set("Authorization", `Bearer ${this.#accessToken}`);
    const response = await this.#fetch(url, {
      ...init,
      headers,
      cache: "no-store",
    });
    if (!response.ok) throw await this.#errorFrom(response);
    return response;
  }

  async requestJson<T>(
    path: ControlApiV1Path,
    schema: z.ZodType<T>,
    init?: RequestInit,
  ): Promise<T> {
    const response = await this.request(path, init);
    return schema.parse(await response.json());
  }

  async getCapabilities(): Promise<OneFetchCapabilitiesV1> {
    return this.requestJson(
      CONTROL_ROUTES_V1.capabilities,
      OneFetchCapabilitiesV1Schema,
    );
  }

  async getHealth(): Promise<HealthResponseV1> {
    return this.requestJson(CONTROL_ROUTES_V1.health, HealthResponseV1Schema);
  }

  async getBootstrapStatus(): Promise<BootstrapStatusV1> {
    return this.requestJson(
      CONTROL_ROUTES_V1.bootstrap,
      BootstrapStatusV1Schema,
    );
  }

  async bootstrap(input: BootstrapRequestV1): Promise<SessionTokenPairV1> {
    const pair = await this.requestJson(
      CONTROL_ROUTES_V1.bootstrap,
      SessionTokenPairV1Schema,
      jsonRequest("POST", BootstrapRequestV1Schema.parse(input)),
    );
    this.setAccessToken(pair.accessToken);
    return pair;
  }

  async login(input: LoginRequestV1): Promise<SessionTokenPairV1> {
    const pair = await this.requestJson(
      CONTROL_ROUTES_V1.login,
      SessionTokenPairV1Schema,
      jsonRequest("POST", LoginRequestV1Schema.parse(input)),
    );
    this.setAccessToken(pair.accessToken);
    return pair;
  }

  async refresh(input: RefreshRequestV1): Promise<SessionTokenPairV1> {
    const pair = await this.requestJson(
      CONTROL_ROUTES_V1.refresh,
      SessionTokenPairV1Schema,
      jsonRequest("POST", RefreshRequestV1Schema.parse(input)),
    );
    this.setAccessToken(pair.accessToken);
    return pair;
  }

  async logout(): Promise<LogoutResponseV1> {
    const result = await this.requestJson(
      CONTROL_ROUTES_V1.logout,
      LogoutResponseV1Schema,
      { method: "POST" },
    );
    this.setAccessToken(undefined);
    return result;
  }

  async listSessions(): Promise<SessionListV1> {
    return this.requestJson(CONTROL_ROUTES_V1.sessions, SessionListV1Schema);
  }

  async revokeSession(sessionId: string): Promise<SessionRevokeResponseV1> {
    return this.requestJson(
      CONTROL_ROUTES_V1.session(sessionId),
      SessionRevokeResponseV1Schema,
      { method: "DELETE" },
    );
  }

  async prepareTotp(): Promise<TotpPrepareResponseV1> {
    return this.requestJson(
      CONTROL_ROUTES_V1.totpPrepare,
      TotpPrepareResponseV1Schema,
      { method: "POST" },
    );
  }

  async enableTotp(input: TotpEnableRequestV1): Promise<TotpEnableResponseV1> {
    return this.requestJson(
      CONTROL_ROUTES_V1.totpEnable,
      TotpEnableResponseV1Schema,
      jsonRequest("POST", TotpEnableRequestV1Schema.parse(input)),
    );
  }

  async changePassword(
    input: ChangePasswordRequestV1,
  ): Promise<ChangePasswordResponseV1> {
    return this.requestJson(
      CONTROL_ROUTES_V1.password,
      ChangePasswordResponseV1Schema,
      jsonRequest("POST", ChangePasswordRequestV1Schema.parse(input)),
    );
  }

  async getConfiguration(): Promise<RuntimeConfigurationV1> {
    return this.requestJson(
      CONTROL_ROUTES_V1.configuration,
      RuntimeConfigurationV1Schema,
    );
  }

  async updatePolicy(
    input: UpdatePolicyRequestV1,
    expectedVersion: string,
  ): Promise<RuntimeConfigurationV1> {
    return this.requestJson(
      CONTROL_ROUTES_V1.policy,
      RuntimeConfigurationV1Schema,
      {
        ...jsonRequest("PUT", UpdatePolicyRequestV1Schema.parse(input)),
        headers: {
          "Content-Type": "application/json",
          "If-Match": quoteEtag(expectedVersion),
        },
      },
    );
  }

  async setGatewayPaused(
    input: SetGatewayPausedRequestV1,
    expectedVersion: string,
  ): Promise<RuntimeConfigurationV1> {
    return this.requestJson(
      CONTROL_ROUTES_V1.gatewayPaused,
      RuntimeConfigurationV1Schema,
      {
        ...jsonRequest("PUT", SetGatewayPausedRequestV1Schema.parse(input)),
        headers: {
          "Content-Type": "application/json",
          "If-Match": quoteEtag(expectedVersion),
        },
      },
    );
  }

  async listExecutionTokens(): Promise<ExecutionTokenListV1> {
    return this.requestJson(
      CONTROL_ROUTES_V1.executionTokens,
      ExecutionTokenListV1Schema,
    );
  }

  async createExecutionToken(
    input: CreateExecutionTokenRequestV1,
  ): Promise<CreatedExecutionTokenV1> {
    return this.requestJson(
      CONTROL_ROUTES_V1.executionTokens,
      CreatedExecutionTokenV1Schema,
      jsonRequest("POST", CreateExecutionTokenRequestV1Schema.parse(input)),
    );
  }

  async revokeExecutionToken(
    tokenId: string,
  ): Promise<ExecutionTokenRevokeResponseV1> {
    return this.requestJson(
      CONTROL_ROUTES_V1.executionToken(tokenId),
      ExecutionTokenRevokeResponseV1Schema,
      { method: "DELETE" },
    );
  }

  async getAuditPage(
    query: Partial<AuditPageQueryV1> = {},
  ): Promise<AuditPageV1> {
    const parsed = AuditPageQueryV1Schema.parse(query);
    const parameters = new URLSearchParams({ limit: String(parsed.limit) });
    if (parsed.cursor !== undefined) parameters.set("cursor", parsed.cursor);
    const path = `${CONTROL_ROUTES_V1.auditEvents}?${parameters.toString()}`;
    return this.requestJson(path as ControlApiV1Path, AuditPageV1Schema);
  }

  async getFeatureStatuses(): Promise<ControlFeatureStatusListV1> {
    return this.requestJson(
      CONTROL_ROUTES_V1.features,
      ControlFeatureStatusListV1Schema,
    );
  }

  async getFeatureStatus(
    feature: ControlFeatureV1,
  ): Promise<ControlFeatureStatusV1> {
    const status = await this.requestJson(
      CONTROL_ROUTES_V1.feature(feature),
      ControlFeatureStatusV1Schema,
    );
    if (status.feature !== feature)
      throw new TypeError("Control returned a mismatched feature status");
    return status;
  }

  async getAlerts(cursor?: string): Promise<AlertsResponseV1> {
    return this.requestJson(
      withCursor(CONTROL_ROUTES_V1.alerts, cursor),
      AlertsResponseV1Schema,
    );
  }

  async getBackups(cursor?: string): Promise<BackupsResponseV1> {
    return this.requestJson(
      withCursor(CONTROL_ROUTES_V1.backups, cursor),
      BackupsResponseV1Schema,
    );
  }

  async getExecutionReport(
    reportId: string,
    executionToken: string,
  ): Promise<ExecutionReportV1> {
    return this.requestJson(
      CONTROL_ROUTES_V1.executionReport(reportId),
      ExecutionReportV1Schema,
      { headers: { Authorization: `Bearer ${executionToken}` } },
    );
  }

  async #errorFrom(response: Response): Promise<OneFetchControlError> {
    try {
      const parsed = ControlErrorV1Schema.safeParse(
        await response.clone().json(),
      );
      return new OneFetchControlError(
        response,
        parsed.success ? parsed.data.error : undefined,
      );
    } catch {
      return new OneFetchControlError(response);
    }
  }
}
