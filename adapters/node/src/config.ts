import { resolve } from "node:path";

export interface NodeAdapterConfig {
  auditSigningPrivateKey: string;
  controlHost: string;
  controlAllowedOrigins: string[];
  controlPort: number;
  databasePath: string;
  gatewayHost: string;
  gatewayPort: number;
  instanceId: string;
  instancePepper: string;
  protocolSigningKey: string;
  publicControlUrl: string;
  publicGatewayUrl: string;
  requestBodyLimitBytes: number;
  responseBodyLimitBytes: number;
}

const requireSecret = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value || value.length < 32) {
    throw new Error(`${name} must contain at least 32 characters`);
  }
  return value;
};

const readPort = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
};

export const loadConfig = (): NodeAdapterConfig => {
  const controlHost = process.env.ONE_FETCH_CONTROL_HOST?.trim() || "127.0.0.1";
  const controlPort = readPort("ONE_FETCH_CONTROL_PORT", 8787);
  const gatewayHost = process.env.ONE_FETCH_GATEWAY_HOST?.trim() || "127.0.0.1";
  const gatewayPort = readPort("ONE_FETCH_GATEWAY_PORT", 8788);

  return {
    auditSigningPrivateKey: requireSecret(
      "ONE_FETCH_AUDIT_SIGNING_PRIVATE_KEY",
    ),
    controlHost,
    controlAllowedOrigins: (process.env.ONE_FETCH_CONTROL_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    controlPort,
    databasePath: resolve(
      process.env.ONE_FETCH_DATABASE_PATH || "./data/one-fetch.sqlite",
    ),
    gatewayHost,
    gatewayPort,
    instanceId: process.env.ONE_FETCH_INSTANCE_ID?.trim() || "one-fetch-node",
    instancePepper: requireSecret("ONE_FETCH_INSTANCE_PEPPER"),
    protocolSigningKey: requireSecret("ONE_FETCH_PROTOCOL_SIGNING_KEY"),
    publicControlUrl:
      process.env.ONE_FETCH_PUBLIC_CONTROL_URL?.trim() ||
      `http://${controlHost}:${controlPort}`,
    publicGatewayUrl:
      process.env.ONE_FETCH_PUBLIC_GATEWAY_URL?.trim() ||
      `http://${gatewayHost}:${gatewayPort}`,
    requestBodyLimitBytes: 20 * 1024 * 1024,
    responseBodyLimitBytes: 20 * 1024 * 1024,
  };
};
