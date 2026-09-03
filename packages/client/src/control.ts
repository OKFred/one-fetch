import {
  ExecutionReportV1Schema,
  LoginRequestV1Schema,
  OneFetchCapabilitiesV1Schema,
  RefreshRequestV1Schema,
  SessionTokenPairV1Schema,
  type ExecutionReportV1,
  type LoginRequestV1,
  type OneFetchCapabilitiesV1,
  type RefreshRequestV1,
  type SessionTokenPairV1,
} from "@one-fetch/protocol";
import type { z } from "zod";

import { parseServiceOrigin } from "./url.js";

export interface OneFetchControlClientOptions {
  controlUrl: string;
  accessToken?: string;
  fetch?: typeof globalThis.fetch;
}

export class OneFetchControlError extends Error {
  readonly status: number;
  readonly response: Response;

  constructor(response: Response) {
    super(`Control request failed with HTTP ${response.status}`);
    this.name = "OneFetchControlError";
    this.status = response.status;
    this.response = response;
  }
}

export class OneFetchControlClient {
  readonly controlOrigin: string;
  #accessToken: string | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: OneFetchControlClientOptions) {
    this.controlOrigin = parseServiceOrigin(
      options.controlUrl,
      "Control URL",
    ).origin;
    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  setAccessToken(token: string | undefined): void {
    this.#accessToken = token;
  }

  async request(
    path: `/api/v1/${string}`,
    init: RequestInit = {},
  ): Promise<Response> {
    const url = new URL(path, this.controlOrigin);
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (this.#accessToken !== undefined && !headers.has("Authorization"))
      headers.set("Authorization", `Bearer ${this.#accessToken}`);
    const response = await this.#fetch(url, {
      ...init,
      headers,
      cache: "no-store",
    });
    if (!response.ok) throw new OneFetchControlError(response);
    return response;
  }

  async requestJson<T>(
    path: `/api/v1/${string}`,
    schema: z.ZodType<T>,
    init?: RequestInit,
  ): Promise<T> {
    const response = await this.request(path, init);
    return schema.parse(await response.json());
  }

  async getCapabilities(): Promise<OneFetchCapabilitiesV1> {
    return this.requestJson(
      "/api/v1/capabilities",
      OneFetchCapabilitiesV1Schema,
    );
  }

  async login(input: LoginRequestV1): Promise<SessionTokenPairV1> {
    const body = LoginRequestV1Schema.parse(input);
    const pair = await this.requestJson(
      "/api/v1/auth/login",
      SessionTokenPairV1Schema,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    this.setAccessToken(pair.accessToken);
    return pair;
  }

  async refresh(input: RefreshRequestV1): Promise<SessionTokenPairV1> {
    const body = RefreshRequestV1Schema.parse(input);
    const pair = await this.requestJson(
      "/api/v1/auth/refresh",
      SessionTokenPairV1Schema,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    this.setAccessToken(pair.accessToken);
    return pair;
  }

  async getExecutionReport(
    reportId: string,
    executionToken: string,
  ): Promise<ExecutionReportV1> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(reportId))
      throw new TypeError("Invalid report ID");
    const response = await this.request(
      `/api/v1/reports/${encodeURIComponent(reportId)}`,
      { headers: { Authorization: `Bearer ${executionToken}` } },
    );
    return ExecutionReportV1Schema.parse(await response.json());
  }
}
