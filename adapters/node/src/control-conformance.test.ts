import { OneFetchControlClient } from "@one-fetch/client";
import { runControlConformance } from "@one-fetch/conformance";
import { afterEach, describe, expect, it } from "vitest";

import { createControlApp } from "./control.js";
import { createTestServices } from "./test-helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Node Control conformance", () => {
  it("passes the shared public and administrator contract", async () => {
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const bootstrapToken = await services.auth.ensureBootstrap();
    const session = await services.auth.bootstrap(
      bootstrapToken!,
      "operator",
      "correct horse battery staple",
    );
    const app = createControlApp(services);
    const fetch: typeof globalThis.fetch = async (input, init) =>
      app.request(new Request(input, init));
    const client = new OneFetchControlClient({
      accessToken: session.accessToken,
      controlUrl: "http://127.0.0.1",
      fetch,
    });

    const report = await runControlConformance(client, {
      expectedInstanceId: services.config.instanceId,
      includeManagement: true,
    });

    expect(report, JSON.stringify(report.results, null, 2)).toMatchObject({
      passed: true,
    });
  });
});
