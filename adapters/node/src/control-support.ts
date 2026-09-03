import type { z } from "@hono/zod-openapi";

import type {
  ControlErrorV1,
  RuntimeConfigurationV1,
} from "@one-fetch/protocol";

import type { AuditLedger } from "./audit.js";
import type { AdminSessionIdentity, AuthenticationService } from "./auth.js";
import type { NodeAdapterConfig } from "./config.js";
import type { ConfigurationStore } from "./configuration.js";
import type { DatabaseClient } from "./database.js";
import type { ExecutionReportStore } from "./execution-reports.js";

export interface ControlDependencies {
  audit: AuditLedger;
  auth: AuthenticationService;
  config: NodeAdapterConfig;
  configuration: ConfigurationStore;
  database: DatabaseClient;
  reports: ExecutionReportStore;
}

export const jsonBody = <Schema extends z.ZodType>(schema: Schema) => ({
  content: { "application/json": { schema } },
  required: true,
});

export const jsonResponse = (schema: z.ZodType, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

export const controlError = (
  code: string,
  message: string,
  retryable?: boolean,
): ControlErrorV1 => ({
  error: { code, message, ...(retryable === undefined ? {} : { retryable }) },
});

export const bearer = (value: string | undefined): string | undefined => {
  const match = /^Bearer\s+(.+)$/iu.exec(value ?? "");
  return match?.[1];
};

export const authorizeAdmin = async (
  dependencies: ControlDependencies,
  authorization: string | undefined,
): Promise<AdminSessionIdentity | undefined> => {
  const token = bearer(authorization);
  return token ? dependencies.auth.authenticateAdminSession(token) : undefined;
};

export const expectedConfigurationVersion = (
  ifMatch: string | undefined,
): string | undefined => {
  if (!ifMatch) return undefined;
  const match = /^"([^"\r\n]{1,256})"$/u.exec(ifMatch);
  return match?.[1];
};

export const quoteConfigurationVersion = (
  configuration: RuntimeConfigurationV1,
): string => `"${configuration.version}"`;
