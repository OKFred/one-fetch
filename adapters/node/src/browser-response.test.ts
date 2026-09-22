import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { classifyOneFetchResponse } from "@one-fetch/core";
import {
  encodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  ONE_FETCH_TOKEN_HEADER,
  type OneFetchRequestMetaV1,
} from "@one-fetch/protocol";
import { createGatewayServer } from "./gateway.js";
import {
  createTestServices,
  testExecutionTokenRequest,
} from "./test-helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}

describe("Node browser envelope over real HTTP", () => {
  it("preserves target status, cookies, redirects and empty-body reports", async () => {
    const target = createServer((request, response) => {
      const status = Number(request.url?.slice(1));
      response.writeHead(status, {
        Location: "/next",
        "Set-Cookie": ["a=1", "b=2"],
        "Content-Type": "text/html",
      });
      response.end([204, 205, 304].includes(status) ? undefined : "abc");
    });
    const targetOrigin = await listen(target);
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const bootstrap = await services.auth.ensureBootstrap();
    const session = await services.auth.bootstrap(
      bootstrap!,
      "operator",
      "correct horse battery staple",
    );
    const administratorId = await services.auth.authenticateAdmin(
      session.accessToken,
    );
    const issued = await services.auth.createExecutionToken(
      administratorId!,
      testExecutionTokenRequest(["http"], [targetOrigin]),
    );
    const current = await services.configuration.get();
    const update = services.configuration.prepareUpdate(current, {
      schemaVersion: 1,
      mode: "allowlist",
      revision: current.policy.revision,
      rules: [
        {
          id: "fixture",
          name: "Fixture",
          enabled: true,
          action: "allow",
          match: { origins: [{ operator: "exact", value: targetOrigin }] },
        },
      ],
    });
    await services.database.transaction([update.operation]);
    const gateway = await listen(createGatewayServer(services));
    for (const status of [201, 204, 205, 302, 304, 503]) {
      const metadata: OneFetchRequestMetaV1 = {
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        nonce: "0123456789abcdef0123456789abcdef",
        transport: "http",
        targetOrigin,
        targetHeaders: [],
        fetchOptions: {
          redirect: "manual",
          timeoutMs: 60_000,
          adapter: { browserResponse: "envelope-v1" },
        },
        body: {},
        hop: 0,
      };
      const response = await fetch(`${gateway}/${status}`, {
        redirect: "manual",
        headers: {
          [ONE_FETCH_REQUEST_HEADER]: encodeRequestMetadata(metadata),
          [ONE_FETCH_TOKEN_HEADER]: issued.token,
        },
      });
      expect(response.status).toBe(200);
      expect(response.headers.has("location")).toBe(false);
      expect(response.headers.has("set-cookie")).toBe(false);
      const classified = await classifyOneFetchResponse(
        response.headers.get(ONE_FETCH_RESPONSE_HEADER),
        {
          token: issued.token,
          requestId: metadata.requestId,
          nonce: metadata.nonce,
        },
      );
      expect(classified).toMatchObject({
        source: "target",
        metadata: { responseMode: "browser-envelope-v1" },
        target: { status, setCookie: ["a=1", "b=2"] },
      });
      const empty = [204, 205, 304].includes(status);
      expect(await response.text()).toBe(empty ? "" : "abc");
      if (classified.source !== "target" || !classified.metadata.reportId)
        throw new Error("Missing report binding");
      const reportId = classified.metadata.reportId;
      await expect
        .poll(
          async () =>
            (await services.reports.get(reportId, issued.credential.id))
              ?.bodySha256,
        )
        .toBe(
          empty
            ? "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            : "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    }
  });
});
