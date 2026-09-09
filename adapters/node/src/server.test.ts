import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./runtime-probe.js", () => ({
  assertSupportedRuntime: (): void => undefined,
}));

import type { NodeAdapterConfig } from "./config.js";
import { startOneFetchNode, type OneFetchNodeServer } from "./server.js";
import { testConfig } from "./test-helpers.js";

const blockers: Server[] = [];
const directories: string[] = [];
const running: OneFetchNodeServer[] = [];

const listenRandom = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
};

const closeHttpServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
};

const occupiedPort = async (): Promise<{ port: number; server: Server }> => {
  const server = createServer();
  blockers.push(server);
  return { port: await listenRandom(server), server };
};

const availablePort = async (): Promise<number> => {
  const server = createServer();
  const port = await listenRandom(server);
  await closeHttpServer(server);
  return port;
};

const serverConfig = async (
  controlPort: number,
  gatewayPort: number,
): Promise<NodeAdapterConfig> => {
  const directory = await mkdtemp(join(tmpdir(), "one-fetch-server-test-"));
  directories.push(directory);
  return {
    ...testConfig(join(directory, "one-fetch.sqlite")),
    controlPort,
    gatewayPort,
    publicControlUrl: `http://127.0.0.1:${controlPort}`,
    publicGatewayUrl: `http://127.0.0.1:${gatewayPort}`,
  };
};

const expectUsableBootstrap = async (
  server: OneFetchNodeServer,
  username: string,
): Promise<void> => {
  expect(server.bootstrapToken).toMatch(/^[A-Za-z0-9_-]+$/u);
  const response = await fetch(
    `${server.config.publicControlUrl}/api/v1/bootstrap`,
    {
      body: JSON.stringify({
        bootstrapSecret: server.bootstrapToken,
        password: "correct horse battery staple",
        schemaVersion: 1,
        username,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );
  expect(response.status).toBe(200);
};

afterEach(async () => {
  await Promise.allSettled(running.splice(0).map(({ close }) => close()));
  await Promise.allSettled(blockers.splice(0).map(closeHttpServer));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Node staged server startup", () => {
  it("recovers immediately from a Control port conflict", async () => {
    const occupied = await occupiedPort();
    const gatewayPort = await availablePort();
    const config = await serverConfig(occupied.port, gatewayPort);

    await expect(startOneFetchNode(config)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    await closeHttpServer(occupied.server);

    const server = await startOneFetchNode(config);
    running.push(server);
    await expectUsableBootstrap(server, "control-retry");
    await Promise.all([server.close(), server.terminated]);
  });

  it("releases Control after a Gateway port conflict and retries immediately", async () => {
    const occupied = await occupiedPort();
    const controlPort = await availablePort();
    const config = await serverConfig(controlPort, occupied.port);

    await expect(startOneFetchNode(config)).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    await closeHttpServer(occupied.server);

    const server = await startOneFetchNode(config);
    running.push(server);
    await expectUsableBootstrap(server, "gateway-retry");
    await Promise.all([server.close(), server.terminated]);
  });
});
