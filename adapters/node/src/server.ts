import { serve } from "@hono/node-server";

import { AuditLedger } from "./audit.js";
import { AuthenticationService } from "./auth.js";
import { loadConfig, type NodeAdapterConfig } from "./config.js";
import { ConfigurationStore } from "./configuration.js";
import { createControlApp } from "./control.js";
import { DatabaseClient } from "./database.js";
import { ExecutionReportStore } from "./execution-reports.js";
import { createGatewayServer } from "./gateway.js";
import { assertSupportedRuntime } from "./runtime-probe.js";

export interface OneFetchNodeServer {
  bootstrapToken?: string;
  close: () => Promise<void>;
  config: NodeAdapterConfig;
}

export const startOneFetchNode = async (
  suppliedConfig: NodeAdapterConfig = loadConfig(),
): Promise<OneFetchNodeServer> => {
  assertSupportedRuntime();
  const database = new DatabaseClient(suppliedConfig.databasePath);
  await database.ready();
  const configuration = new ConfigurationStore(database);
  await configuration.initialize();
  const audit = new AuditLedger(
    database,
    suppliedConfig.auditSigningPrivateKey,
  );
  const auth = new AuthenticationService(
    database,
    audit,
    suppliedConfig.instancePepper,
  );
  const reports = new ExecutionReportStore(database);
  const bootstrapToken = await auth.ensureBootstrap();

  const control = serve({
    fetch: createControlApp({
      audit,
      auth,
      config: suppliedConfig,
      configuration,
      database,
      reports,
    }).fetch,
    hostname: suppliedConfig.controlHost,
    port: suppliedConfig.controlPort,
  });
  const gateway = createGatewayServer({
    audit,
    auth,
    config: suppliedConfig,
    configuration,
    reports,
  });
  await new Promise<void>((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(
      suppliedConfig.gatewayPort,
      suppliedConfig.gatewayHost,
      resolve,
    );
  });

  let closing: Promise<void> | undefined;
  return {
    ...(bootstrapToken ? { bootstrapToken } : {}),
    config: suppliedConfig,
    close: async () => {
      closing ??= Promise.all([
        new Promise<void>((resolve, reject) =>
          control.close((error) => (error ? reject(error) : resolve())),
        ),
        new Promise<void>((resolve, reject) =>
          gateway.close((error) => (error ? reject(error) : resolve())),
        ),
      ]).then(async () => database.close());
      return closing;
    },
  };
};
