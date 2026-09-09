import { SELF } from "cloudflare:test";
import {
  ControlErrorV1Schema,
  CreatedExecutionTokenV1Schema,
  SessionTokenPairV1Schema,
} from "@one-fetch/protocol";
import { expect } from "vitest";

export const bootstrapBody = {
  schemaVersion: 1 as const,
  bootstrapSecret: "test-bootstrap-token-with-enough-entropy",
  username: "admin",
  password: "correct horse battery staple",
};

export async function bootstrapAdmin() {
  const response = await jsonRequest("/api/v1/bootstrap", bootstrapBody);
  expect(response.status).toBe(200);
  return SessionTokenPairV1Schema.parse(await response.json());
}

export async function loginAdmin(
  options: { totpCode?: string; recoveryCode?: string } = {},
) {
  const response = await jsonRequest("/api/v1/auth/login", {
    schemaVersion: 1,
    username: bootstrapBody.username,
    password: bootstrapBody.password,
    rememberDevice: false,
    ...options,
  });
  expect(response.status).toBe(200);
  return SessionTokenPairV1Schema.parse(await response.json());
}

export async function createCredential(name: string) {
  const pair = await bootstrapAdmin();
  const response = await authorizedRequest(
    pair.accessToken,
    "/api/v1/tokens/execution",
    {
      method: "POST",
      body: {
        schemaVersion: 1,
        name,
        scope: { transports: ["http"], origins: [], ports: [] },
        quota: {
          requestsPerMinute: 60,
          burst: 10,
          concurrentHttp: 4,
          concurrentTunnels: 0,
          bytesPerDay: 1_048_576,
        },
      },
    },
  );
  expect(response.status).toBe(201);
  return {
    pair,
    credential: CreatedExecutionTokenV1Schema.parse(await response.json()),
  };
}

export function jsonRequest(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://control.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function authorizedRequest(
  accessToken: string,
  path: string,
  init: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  return SELF.fetch(`https://control.example${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

export async function expectControlError(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(ControlErrorV1Schema.parse(await response.json()).error.code).toBe(
    code,
  );
}
