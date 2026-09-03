import { createAdaptorServer, type ServerType } from "@hono/node-server";

import { AuditLedger } from "./audit.js";
import { AuthenticationService } from "./auth.js";
import { loadConfig, type NodeAdapterConfig } from "./config.js";
import { ConfigurationStore } from "./configuration.js";
import { createControlApp } from "./control.js";
import { DatabaseClient } from "./database.js";
import { ExecutionReportStore } from "./execution-reports.js";
import { createGatewayServer } from "./gateway.js";
import { QuotaCoordinator } from "./quota.js";
import { assertSupportedRuntime } from "./runtime-probe.js";

export interface OneFetchNodeServer {
  bootstrapToken?: string;
  close: () => Promise<void>;
  config: NodeAdapterConfig;
  fatal: Promise<Error>;
  terminated: Promise<void>;
}

const listen = (
  server: ServerType,
  port: number,
  hostname: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, hostname);
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error("Listener failed"));
    }
  });

const closeListener = async (server: ServerType | undefined): Promise<void> => {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
};

export const startOneFetchNode = async (
  suppliedConfig: NodeAdapterConfig = loadConfig(),
): Promise<OneFetchNodeServer> => {
  assertSupportedRuntime();
  const database = new DatabaseClient(suppliedConfig.databasePath);
  let control: ServerType | undefined;
  let gateway: ServerType | undefined;
  let requestShutdown!: () => void;
  let settleStartup!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => {
    requestShutdown = resolve;
  });
  const startupSettled = new Promise<void>((resolve) => {
    settleStartup = resolve;
  });
  const terminated = shutdownRequested.then(async () => {
    await startupSettled;
    const listenerResults = await Promise.allSettled([
      closeListener(control),
      closeListener(gateway),
    ]);
    const databaseResult = await Promise.allSettled([database.close()]);
    const failures = [...listenerResults, ...databaseResult]
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result): Error => {
        const reason: unknown = result.reason;
        return reason instanceof Error
          ? reason
          : new Error("Unknown shutdown failure");
      });
    if (failures.length > 0) {
      throw new AggregateError(failures, "Node adapter shutdown failed");
    }
  });
  void terminated.catch(() => undefined);
  const fatal = database.fatal;
  void fatal.then(() => requestShutdown());

  try {
    await database.ready();
    const configuration = new ConfigurationStore(
      database,
      suppliedConfig.instanceId,
    );
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
    const quota = new QuotaCoordinator(database);

    control = createAdaptorServer({
      fetch: createControlApp({
        audit,
        auth,
        config: suppliedConfig,
        configuration,
        database,
        reports,
      }).fetch,
    });
    gateway = createGatewayServer({
      audit,
      auth,
      config: suppliedConfig,
      configuration,
      quota,
      reports,
    });
    await listen(
      control,
      suppliedConfig.controlPort,
      suppliedConfig.controlHost,
    );
    await listen(
      gateway,
      suppliedConfig.gatewayPort,
      suppliedConfig.gatewayHost,
    );
    const bootstrapToken = await auth.ensureBootstrap();
    settleStartup();

    return {
      ...(bootstrapToken ? { bootstrapToken } : {}),
      config: suppliedConfig,
      fatal,
      terminated,
      close: async () => {
        requestShutdown();
        await terminated;
      },
    };
  } catch (error) {
    settleStartup();
    requestShutdown();
    try {
      await terminated;
    } catch (shutdownError) {
      throw new AggregateError(
        [error, shutdownError],
        "Node adapter startup and cleanup failed",
      );
    }
    throw error;
  }
};
