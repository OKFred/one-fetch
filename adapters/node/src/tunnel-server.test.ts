import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  createServer as createTcpServer,
  type Server as TcpServer,
} from "node:net";

import { verifySignedResponseMetadata } from "@one-fetch/core";
import {
  createTunnelClientHello,
  decodeTunnelServerHello,
  encodeTunnelClientHello,
  ONE_FETCH_WEBSOCKET_PROTOCOL,
  type OneFetchRequestMetaV1,
  type PolicySetV1,
} from "@one-fetch/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { createGatewayServer } from "./gateway.js";
import {
  createTestServices,
  testExecutionTokenRequest,
} from "./test-helpers.js";
import { tunnelDataToText } from "./tunnel-data.js";
import { attachTunnelServer } from "./tunnel-server.js";

type ClosableServer = Server | TcpServer;

const closeServer = (server: ClosableServer): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

const listen = async (server: ClosableServer): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected server address");
  return address.port;
};

const openClient = (port: number, path = "/tunnel"): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}${path}`,
      ONE_FETCH_WEBSOCKET_PROTOCOL,
    );
    socket.once("open", () => {
      cleanups.push(() => {
        socket.terminate();
        return Promise.resolve();
      });
      resolve(socket);
    });
    socket.once("error", reject);
  });

const nextMessage = (
  socket: WebSocket,
): Promise<{ binary: boolean; data: WebSocket.RawData }> =>
  new Promise((resolve, reject) => {
    socket.once("message", (data, binary) => resolve({ binary, data }));
    socket.once("error", reject);
    socket.once("close", (code, reason) =>
      reject(
        new Error(
          `Socket closed before message: ${code} ${reason.toString("utf8")}`,
        ),
      ),
    );
  });

const nextClose = (socket: WebSocket): Promise<number> =>
  new Promise((resolve) => socket.once("close", (code) => resolve(code)));

const setPolicy = async (
  services: Awaited<ReturnType<typeof createTestServices>>,
  rules: PolicySetV1["rules"],
) => {
  const current = await services.configuration.get();
  const policy: PolicySetV1 = {
    mode: "allowlist",
    revision: current.policy.revision,
    rules,
    schemaVersion: 1,
  };
  const update = services.configuration.prepareUpdate(current, policy);
  await services.database.transaction([update.operation]);
};

const issueToken = async (
  services: Awaited<ReturnType<typeof createTestServices>>,
  scopes: string[],
  allowedTargets: string[],
) => {
  const bootstrapToken = await services.auth.ensureBootstrap();
  const session = await services.auth.bootstrap(
    bootstrapToken!,
    "operator",
    "correct horse battery staple",
  );
  const administratorId = await services.auth.authenticateAdmin(
    session.accessToken,
  );
  return services.auth.createExecutionToken(
    administratorId!,
    testExecutionTokenRequest(
      scopes as Array<"http" | "websocket" | "tcp" | "tls">,
      allowedTargets,
    ),
  );
};

const baseMetadata = (
  requestId: string,
  transport: OneFetchRequestMetaV1["transport"],
): Pick<
  OneFetchRequestMetaV1,
  | "body"
  | "fetchOptions"
  | "hop"
  | "nonce"
  | "protocolVersion"
  | "requestId"
  | "targetHeaders"
  | "transport"
> => ({
  body: { sizeBytes: 0 },
  fetchOptions: { redirect: "error", timeoutMs: 60_000 },
  hop: 0,
  nonce: createHash("sha256").update(requestId).digest("hex").slice(0, 32),
  protocolVersion: 1,
  requestId,
  targetHeaders: [],
  transport,
});

const cleanups: Array<() => Promise<void>> = [];

const createFutureTunnelTestServer = (
  services: Awaited<ReturnType<typeof createTestServices>>,
): Server => {
  const server = createGatewayServer(services);
  server.removeAllListeners("upgrade");
  attachTunnelServer(server, services);
  return server;
};
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Node tunnel gateway", () => {
  it("keeps the shipped Preview server HTTP-only", async () => {
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const gateway = createGatewayServer(services);
    const gatewayPort = await listen(gateway);
    cleanups.push(() => closeServer(gateway));

    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/upgrade`);
      socket.once("open", () =>
        reject(new Error("Upgrade unexpectedly opened")),
      );
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      socket.once("error", reject);
    });

    expect(status).toBe(501);
  });

  it("does not connect upstream before a valid authenticated hello", async () => {
    let connections = 0;
    const target = createTcpServer(() => {
      connections += 1;
    });
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const gateway = createFutureTunnelTestServer(services);
    const gatewayPort = await listen(gateway);
    cleanups.push(() => closeServer(gateway));

    const client = await openClient(gatewayPort);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connections).toBe(0);
    const metadata: OneFetchRequestMetaV1 = {
      ...baseMetadata("unauthorized-tcp", "tcp"),
      targetAuthority: { host: "127.0.0.1", port: targetPort },
    };
    const hello = createTunnelClientHello(
      metadata,
      "invalid-execution-token-value-0123456789",
    );
    const responseMessage = nextMessage(client);
    const closed = nextClose(client);
    client.send(encodeTunnelClientHello(hello));
    const message = await responseMessage;
    const response = decodeTunnelServerHello(
      tunnelDataToText(message.data),
    ).response;
    expect(response.outcome).toBe("relay-error");
    expect(response.error?.code).toBe("unauthorized");
    expect(connections).toBe(0);
    await closed;
  });

  it("bridges a policy-approved TCP target with signed metadata", async () => {
    const target = createTcpServer((socket) => socket.pipe(socket));
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));
    const authority = `tcp://127.0.0.1:${targetPort}`;
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const issued = await issueToken(services, ["tcp"], [authority]);
    await setPolicy(services, [
      {
        action: "allow",
        enabled: true,
        id: "allow-tcp",
        match: {
          hosts: [{ operator: "exact", value: "127.0.0.1" }],
          ports: [targetPort],
          transports: ["tcp"],
        },
        name: "Allow TCP fixture",
      },
    ]);
    const gateway = createFutureTunnelTestServer(services);
    const gatewayPort = await listen(gateway);
    cleanups.push(() => closeServer(gateway));
    const client = await openClient(gatewayPort, "/raw?trace=1");
    const metadata: OneFetchRequestMetaV1 = {
      ...baseMetadata("tcp-echo", "tcp"),
      targetAuthority: { host: "127.0.0.1", port: targetPort },
    };
    client.send(
      encodeTunnelClientHello(createTunnelClientHello(metadata, issued.token)),
    );
    const first = await nextMessage(client);
    expect(first.binary).toBe(false);
    const response = decodeTunnelServerHello(
      tunnelDataToText(first.data),
    ).response;
    expect(response.outcome).toBe("target");
    expect(response.target).toMatchObject({
      kind: "tunnel",
      state: "established",
      transport: "tcp",
    });
    expect(
      await verifySignedResponseMetadata(response, {
        nonce: metadata.nonce,
        requestId: metadata.requestId,
        token: issued.token,
      }),
    ).toBe(true);

    client.send(Buffer.from("binary-echo"), { binary: true });
    const echoed = await nextMessage(client);
    expect(echoed.binary).toBe(true);
    expect(tunnelDataToText(echoed.data)).toBe("binary-echo");
    client.close(1000, "done");
    await nextClose(client);
  });

  it("preserves a WebSocket path, subprotocol, headers and Set-Cookie", async () => {
    let observedPath = "";
    let observedOrigin = "";
    const targetHttp = createServer();
    const targetWebSocket = new WebSocketServer({
      handleProtocols: (protocols) =>
        protocols.has("chat.v1") ? "chat.v1" : false,
      noServer: true,
    });
    targetWebSocket.on("headers", (headers) => {
      headers.push("Set-Cookie: ws-a=1; Path=/");
      headers.push("Set-Cookie: ws-b=2; Path=/");
    });
    targetWebSocket.on("connection", (socket, request) => {
      observedPath = request.url ?? "";
      observedOrigin = request.headers.origin ?? "";
      socket.on("message", (data, binary) => socket.send(data, { binary }));
    });
    targetHttp.on("upgrade", (request, socket, head) => {
      targetWebSocket.handleUpgrade(request, socket, head, (websocket) => {
        targetWebSocket.emit("connection", websocket, request);
      });
    });
    const targetPort = await listen(targetHttp);
    cleanups.push(async () => {
      targetWebSocket.close();
      await closeServer(targetHttp);
    });
    const targetOrigin = `http://127.0.0.1:${targetPort}`;
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const issued = await issueToken(services, ["websocket"], [targetOrigin]);
    await setPolicy(services, [
      {
        action: "allow",
        enabled: true,
        id: "allow-ws",
        match: {
          origins: [{ operator: "exact", value: targetOrigin }],
          path: {
            representation: "raw",
            value: { operator: "exact", value: "/events" },
          },
          transports: ["websocket"],
          websocketSubprotocols: [{ operator: "exact", value: "chat.v1" }],
        },
        name: "Allow WebSocket fixture",
      },
    ]);
    const gateway = createFutureTunnelTestServer(services);
    const gatewayPort = await listen(gateway);
    cleanups.push(() => closeServer(gateway));
    const client = await openClient(gatewayPort, "/events?room=one");
    const metadata: OneFetchRequestMetaV1 = {
      ...baseMetadata("websocket-echo", "websocket"),
      targetHeaders: [
        { name: "Origin", value: "https://caller.example" },
        { name: "Sec-WebSocket-Protocol", value: "chat.v1" },
      ],
      targetOrigin,
    };
    client.send(
      encodeTunnelClientHello(createTunnelClientHello(metadata, issued.token)),
    );
    const first = await nextMessage(client);
    const response = decodeTunnelServerHello(
      tunnelDataToText(first.data),
    ).response;
    expect(response.target).toMatchObject({
      kind: "tunnel",
      selectedSubprotocol: "chat.v1",
      state: "established",
      transport: "websocket",
    });
    if (response.target?.kind !== "tunnel")
      throw new Error("Expected tunnel target metadata");
    expect(response.target.handshake?.setCookie).toEqual([
      "ws-a=1; Path=/",
      "ws-b=2; Path=/",
    ]);
    expect(observedPath).toBe("/events?room=one");
    expect(observedOrigin).toBe("https://caller.example");

    client.send("text-echo");
    const echoed = await nextMessage(client);
    expect(echoed.binary).toBe(false);
    expect(tunnelDataToText(echoed.data)).toBe("text-echo");
    client.close(1000, "done");
    await nextClose(client);
  });
});
