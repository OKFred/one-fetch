import { verifySignedResponseMetadata } from "@one-fetch/core";
import {
  createTunnelClientHello,
  decodeTunnelServerHello,
  encodeTunnelClientHello,
  ONE_FETCH_WEBSOCKET_PROTOCOL,
  type OneFetchRequestMetaV1,
} from "@one-fetch/protocol";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import {
  handleGatewayTunnel,
  type TunnelDependencies,
} from "../src/gateway/tunnel";
import {
  DEFAULT_CONFIG,
  type AuthorizationResult,
  type RuntimeConfig,
} from "../src/types";

const token = "websocket-test-execution-token-0123456789";
const requestMeta: OneFetchRequestMetaV1 = {
  protocolVersion: 1,
  requestId: "websocket-test-1",
  nonce: "0123456789abcdef0123456789abcdef",
  transport: "websocket",
  targetOrigin: "https://target.example",
  targetHeaders: [{ name: "Sec-WebSocket-Protocol", value: "chat.v1" }],
  fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
  body: { sizeBytes: 0 },
  hop: 0,
};

describe("Cloudflare WebSocket gateway", () => {
  it("authenticates the first frame before establishing and then relays frames", async () => {
    const completed = vi.fn(() => Promise.resolve());
    const opened = vi.fn(() => Promise.resolve(createEchoUpgrade()));
    const config: RuntimeConfig = structuredClone(DEFAULT_CONFIG);
    config.systemPolicy = {
      schemaVersion: 1,
      mode: "blocklist",
      revision: 1,
      rules: [],
    };
    const dependencies: TunnelDependencies = {
      authorize: vi.fn(() =>
        Promise.resolve<AuthorizationResult>({
          allowed: true,
          tokenId: "token-id",
          config,
          configVersion: "test-config-v1",
          auditState: "recorded",
          auditEventId: "audit-event-1",
        }),
      ),
      complete: completed,
      releaseDenied: vi.fn(() => Promise.resolve()),
      renew: vi.fn(() => Promise.resolve(true)),
      openWebSocket: opened,
    };
    const context = createExecutionContext();
    const response = handleGatewayTunnel(
      upgradeRequest(),
      {} as CloudflareGatewayEnv,
      context,
      dependencies,
    );
    expect(response.status).toBe(101);
    expect(response.headers.get("sec-websocket-protocol")).toBe(
      ONE_FETCH_WEBSOCKET_PROTOCOL,
    );
    const client = response.webSocket!;
    client.accept();

    const helloFrame = nextMessage(client);
    client.send(
      encodeTunnelClientHello(createTunnelClientHello(requestMeta, token)),
    );
    const hello = decodeTunnelServerHello(await helloFrame);
    expect(hello.response.outcome).toBe("target");
    expect(hello.response.target).toMatchObject({
      kind: "tunnel",
      transport: "websocket",
      state: "established",
    });
    await expect(
      verifySignedResponseMetadata(hello.response, {
        token,
        requestId: requestMeta.requestId,
        nonce: requestMeta.nonce,
      }),
    ).resolves.toBe(true);
    expect(opened).toHaveBeenCalledOnce();

    const echoed = nextMessage(client);
    client.send("ping");
    await expect(echoed).resolves.toBe("ping");
    client.close(1000, "done");
    await waitUntil(() => completed.mock.calls.length === 1);
    await waitOnExecutionContext(context);
    expect(completed).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ outcome: "target", responseBytes: 4 }),
    );
  });

  it("rejects a non-protocol upgrade before allocating an upstream socket", () => {
    const response = handleGatewayTunnel(
      new Request("https://gateway.example/socket", {
        headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "chat" },
      }),
      {} as CloudflareGatewayEnv,
      createExecutionContext(),
    );
    expect(response.status).toBe(400);
    expect(response.webSocket).toBeNull();
  });
});

function upgradeRequest(): Request {
  return new Request("https://gateway.example/socket?room=1", {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": ONE_FETCH_WEBSOCKET_PROTOCOL,
    },
  });
}

function createEchoUpgrade(): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  server.addEventListener(
    "message",
    (event: MessageEvent<string | ArrayBuffer>) => server.send(event.data),
  );
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: {
      "Sec-WebSocket-Protocol": "chat.v1",
      "Server-Timing": "app;dur=2.5",
    },
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("WebSocket message timed out")),
      2_000,
    );
    socket.addEventListener(
      "message",
      (event: MessageEvent<string | ArrayBuffer>) => {
        clearTimeout(timeout);
        if (typeof event.data !== "string")
          reject(new Error("Expected a text frame"));
        else resolve(event.data);
      },
      { once: true },
    );
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition timed out");
}
