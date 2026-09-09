import { describe, expect, it, vi } from "vitest";

import gateway from "../src/gateway";

describe("Cloudflare Preview Gateway transport boundary", () => {
  it("rejects WebSocket upgrades without calling Control or upstream", async () => {
    const controlFetch = vi.fn();
    const response = await gateway.fetch(
      new Request("https://gateway.example/socket", {
        headers: { Upgrade: "websocket" },
      }),
      { CONTROL: { fetch: controlFetch } } as unknown as CloudflareGatewayEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "protocol_unsupported", origin: "adapter" },
    });
    expect(controlFetch).not.toHaveBeenCalled();
  });
});
