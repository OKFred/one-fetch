import { OneFetchControlClient, OneFetchControlError } from "@one-fetch/client";
import {
  BootstrapRequestV1Schema,
  LoginRequestV1Schema,
  PolicySetV1Schema,
  type CreateExecutionTokenRequestV1,
  type CreatedExecutionTokenV1,
  type LoginRequestV1,
  type OneFetchCapabilitiesV1,
  type PolicySetV1,
  type RuntimeConfigurationV1,
} from "@one-fetch/protocol";

import type {
  AdminSessionPair,
  AuditPage,
  BootstrapState,
  RuntimeConfiguration,
} from "./types";

export class UnsupportedControlFeatureError extends Error {
  constructor(readonly feature: string) {
    super(`${feature} is not implemented by this control adapter`);
    this.name = "UnsupportedControlFeatureError";
  }
}

const normalizeError = (error: unknown): Error => {
  if (error instanceof OneFetchControlError) {
    if ([404, 405, 501].includes(error.status))
      return new UnsupportedControlFeatureError(error.code);
    return error;
  }
  return error instanceof Error ? error : new Error(String(error));
};

const asRuntimeConfiguration = (
  value: RuntimeConfigurationV1,
): RuntimeConfiguration => ({
  etag: `"${value.version}"`,
  gatewayPaused: value.gatewayPaused,
  policy: value.policy,
  raw: structuredClone(value),
  revision: value.revision,
  updatedAt: value.updatedAt,
  version: value.version,
});

export class AdminControlApi {
  private readonly client: OneFetchControlClient;

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
      return await this.client.getCapabilities();
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async bootstrapStatus(): Promise<BootstrapState> {
    try {
      const status = await this.client.getBootstrapStatus();
      return { initialized: status.initialized, supported: true };
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async bootstrap(input: {
    bootstrapSecret: string;
    username: string;
    password: string;
  }): Promise<AdminSessionPair> {
    try {
      return await this.client.bootstrap(
        BootstrapRequestV1Schema.parse({ schemaVersion: 1, ...input }),
      );
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async login(input: LoginRequestV1): Promise<AdminSessionPair> {
    try {
      return await this.client.login(LoginRequestV1Schema.parse(input));
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async refresh(refreshToken: string): Promise<AdminSessionPair> {
    try {
      return await this.client.refresh({ refreshToken, schemaVersion: 1 });
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async configuration(): Promise<RuntimeConfiguration> {
    try {
      return asRuntimeConfiguration(await this.client.getConfiguration());
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async savePolicy(
    configuration: RuntimeConfiguration,
    policy: PolicySetV1,
  ): Promise<RuntimeConfiguration> {
    try {
      const validated = PolicySetV1Schema.parse(policy);
      return asRuntimeConfiguration(
        await this.client.updatePolicy(
          { policy: validated, schemaVersion: 1 },
          configuration.version,
        ),
      );
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async setGatewayPaused(
    configuration: RuntimeConfiguration,
    paused: boolean,
  ): Promise<RuntimeConfiguration> {
    try {
      return asRuntimeConfiguration(
        await this.client.setGatewayPaused(
          { paused, schemaVersion: 1 },
          configuration.version,
        ),
      );
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async listTokens() {
    try {
      return (await this.client.listExecutionTokens()).tokens;
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async createToken(
    input: CreateExecutionTokenRequestV1,
  ): Promise<CreatedExecutionTokenV1> {
    try {
      return await this.client.createExecutionToken(input);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async revokeToken(id: string): Promise<void> {
    try {
      await this.client.revokeExecutionToken(id);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async auditPage(cursor?: string): Promise<AuditPage> {
    try {
      const page = await this.client.getAuditPage({
        ...(cursor ? { cursor } : {}),
        limit: 50,
      });
      return {
        events: page.events,
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
      };
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async exportAudit(): Promise<Blob> {
    try {
      return await (await this.client.request("/api/v1/audit/export")).blob();
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async requestFeature(
    path: `/api/v1/${string}`,
    init?: RequestInit,
  ): Promise<unknown> {
    try {
      const response = await this.client.request(path, init);
      return response.status === 204
        ? null
        : ((await response.json()) as unknown);
    } catch (error) {
      throw normalizeError(error);
    }
  }
}
