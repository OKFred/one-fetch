import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CreateExecutionTokenRequestV1,
  TransportV1,
} from "@one-fetch/protocol";

import { AuditLedger } from "./audit.js";
import { AuthenticationService } from "./auth.js";
import type { NodeAdapterConfig } from "./config.js";
import { ConfigurationStore } from "./configuration.js";
import { DatabaseClient } from "./database.js";
import { ExecutionReportStore } from "./execution-reports.js";
import { DEFAULT_EXECUTION_QUOTA } from "./execution-tokens.js";

export const testExecutionTokenRequest = (
  transports: TransportV1[],
  origins: string[],
  ports: number[] = [],
): CreateExecutionTokenRequestV1 => ({
  name: "Test execution token",
  quota: DEFAULT_EXECUTION_QUOTA,
  schemaVersion: 1,
  scope: { origins, ports, transports },
});

export const testConfig = (databasePath: string): NodeAdapterConfig => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    auditSigningPrivateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    controlAllowedOrigins: [],
    controlHost: "127.0.0.1",
    controlPort: 8787,
    databasePath,
    gatewayHost: "127.0.0.1",
    gatewayPort: 8788,
    instanceId: "test-node",
    instancePepper: "test-pepper-with-more-than-thirty-two-characters",
    protocolSigningKey:
      "test-protocol-key-with-more-than-thirty-two-characters",
    publicControlUrl: "http://127.0.0.1:8787",
    publicGatewayUrl: "http://127.0.0.1:65500",
    requestBodyLimitBytes: 20 * 1024 * 1024,
    responseBodyLimitBytes: 20 * 1024 * 1024,
  };
};

export const createTestServices = async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-fetch-node-test-"));
  const config = testConfig(join(directory, "test.sqlite"));
  const database = new DatabaseClient(config.databasePath);
  await database.ready();
  const configuration = new ConfigurationStore(database);
  await configuration.initialize();
  const audit = new AuditLedger(database, config.auditSigningPrivateKey);
  const auth = new AuthenticationService(
    database,
    audit,
    config.instancePepper,
  );
  const reports = new ExecutionReportStore(database);
  return {
    audit,
    auth,
    config,
    configuration,
    database,
    directory,
    reports,
    cleanup: async () => {
      await database.close();
      await rm(directory, { force: true, recursive: true });
    },
  };
};
