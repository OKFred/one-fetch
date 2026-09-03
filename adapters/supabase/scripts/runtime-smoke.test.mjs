import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { runRuntimeSmoke } from "./runtime-smoke.mjs";

const capabilities = {
  protocolVersion: 1,
  instanceId: "instance-smoke",
  provider: "supabase",
  buildVersion: "0.1.0+supabase.test",
  controlGatewayPairId: "instance-smoke",
  configVersion: "uninitialized",
  configUpdatedAt: "1970-01-01T00:00:00.000Z",
  policyMode: "allowlist",
  policyInspection: {
    resolvedIpMatching: false,
    dnsPinning: false,
    userinfoSignal: true,
  },
  transports: {
    http: { state: "stable" },
    websocket: { state: "unsupported", detail: "Preview" },
    tcp: { state: "unsupported", detail: "Preview" },
    tls: { state: "unsupported", detail: "Preview" },
  },
  limits: {
    metadataBytes: 49_152,
    requestBodyBytes: 20_971_520,
    responseBodyBytes: 20_971_520,
    inspectableBodyBytes: 1_048_576,
    timeoutMs: 60_000,
    redirects: 20,
  },
  fetchOptions: [],
  headerMutations: [],
  audit: { state: "unknown" },
};

function json(response, status, body) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

async function withFixture(run) {
  const server = createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    if (request.url === "/functions/v1/one-fetch-control/api/v1/health") {
      return json(response, 200, {
        instanceId: "instance-smoke",
        service: "one-fetch-control",
        status: "ok",
        version: "0.1.0+supabase.test",
      });
    }
    if (request.url === "/functions/v1/one-fetch-control/api/v1/capabilities") {
      return json(response, 200, capabilities);
    }
    if (request.url === "/functions/v1/one-fetch-control/api/v1/openapi.json") {
      return json(response, 200, {
        openapi: "3.1.0",
        servers: [{ url: `${origin}/functions/v1/one-fetch-control` }],
      });
    }
    if (request.url === "/functions/v1/one-fetch-gateway/smoke?probe=1") {
      return json(response, 400, { error: "invalid_metadata" });
    }
    return json(response, 404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    await run(`http://127.0.0.1:${address.port}/functions/v1`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("runtime smoke verifies the actual Supabase Function path topology", () =>
  withFixture(async (baseUrl) => {
    const result = await runRuntimeSmoke({
      baseUrl,
      expectedBuild: "0.1.0+supabase.test",
    });
    assert.equal(result.instanceId, "instance-smoke");
    assert.equal(result.controlUrl, `${baseUrl}/one-fetch-control`);
  }));

test("runtime smoke rejects a mismatched deployed build", () =>
  withFixture(async (baseUrl) => {
    await assert.rejects(
      runRuntimeSmoke({ baseUrl, expectedBuild: "wrong-build" }),
      /build identifier/u,
    );
  }));
