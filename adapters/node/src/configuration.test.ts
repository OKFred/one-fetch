import { afterEach, describe, expect, it } from "vitest";

import { createTestServices } from "./test-helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Node runtime configuration", () => {
  it("starts with a versioned empty allowlist and persists pause state", async () => {
    const services = await createTestServices();
    cleanups.push(services.cleanup);

    const initial = await services.configuration.get();
    expect(initial).toMatchObject({
      gatewayPaused: false,
      instanceId: "test-node",
      policy: { mode: "allowlist", revision: 0, rules: [] },
      revision: 0,
      schemaVersion: 1,
    });

    const update = services.configuration.prepareGatewayPaused(initial, true);
    await services.database.transaction([update.operation]);

    expect(await services.configuration.get()).toEqual(update.configuration);
    expect(update.configuration).toMatchObject({
      gatewayPaused: true,
      revision: 1,
    });
    expect(update.configuration.version).not.toBe(initial.version);
  });
});
