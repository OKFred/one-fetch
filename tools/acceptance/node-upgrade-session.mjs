import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes, webcrypto } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function createUpgradeSession(
  runtime,
  directory,
  config,
  publicKey,
) {
  const protocol = await import(
    pathToFileURL(
      join(directory, "node_modules/@one-fetch/protocol/dist/index.js"),
    )
  );
  const core = await import(
    pathToFileURL(join(directory, "node_modules/@one-fetch/core/dist/index.js"))
  );
  const secrets = [
    runtime.bootstrapToken,
    config.instancePepper,
    config.protocolSigningKey,
    config.auditSigningPrivateKey,
  ];
  let hits = 0;
  const target = createServer((request, response) => {
    hits += 1;
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(201, {
        "Content-Type": "application/json",
        "Set-Cookie": ["first=synthetic; HttpOnly", "second=synthetic; Secure"],
        "Server-Timing": "synthetic;dur=1",
      });
      response.end(
        JSON.stringify({
          url: request.url,
          method: request.method,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
  });
  await new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolve);
  });
  const targetUrl = `http://127.0.0.1:${target.address().port}`;
  let adminToken;
  const close = () =>
    new Promise((resolve, reject) =>
      target.close((error) => (error ? reject(error) : resolve())),
    );
  async function request(
    path,
    { method = "GET", body, etag, token = adminToken } = {},
  ) {
    const response = await globalThis.fetch(config.publicControlUrl + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(etag ? { "If-Match": JSON.stringify(etag) } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: globalThis.AbortSignal.timeout(10_000),
      redirect: "error",
    });
    assert.ok(response.ok);
    return response.json();
  }
  try {
    const password = randomBytes(36).toString("base64url");
    secrets.push(password);
    const pair = await request("/api/v1/bootstrap", {
      method: "POST",
      body: {
        schemaVersion: 1,
        username: "upgrade-synthetic",
        password,
        bootstrapSecret: runtime.bootstrapToken,
      },
    });
    adminToken = pair.accessToken;
    secrets.push(pair.accessToken, pair.refreshToken);
    const before = await request("/api/v1/config");
    const policy = {
      schemaVersion: 1,
      mode: "allowlist",
      revision: before.policy.revision,
      rules: [
        {
          id: "upgrade-target",
          name: "Synthetic target",
          enabled: true,
          action: "allow",
          match: {
            transports: ["http"],
            origins: [
              { operator: "exact", value: targetUrl, caseSensitive: false },
            ],
          },
        },
      ],
    };
    const updated = await request("/api/v1/config/policy", {
      method: "PUT",
      etag: before.version,
      body: { schemaVersion: 1, policy },
    });
    if (updated.gatewayPaused)
      await request("/api/v1/config/gateway-paused", {
        method: "PUT",
        etag: updated.version,
        body: { schemaVersion: 1, paused: false },
      });
    const createToken = () =>
      request("/api/v1/tokens/execution", {
        method: "POST",
        body: {
          schemaVersion: 1,
          name: "upgrade-synthetic",
          scope: {
            transports: ["http"],
            origins: [targetUrl],
            ports: [Number(new globalThis.URL(targetUrl).port)],
          },
          quota: {
            requestsPerMinute: 60,
            burst: 10,
            concurrentHttp: 4,
            concurrentTunnels: 0,
            bytesPerDay: 1073741824,
          },
        },
      });
    const credential = await createToken();
    const revoked = await createToken();
    secrets.push(credential.token, revoked.token);
    await request(`/api/v1/tokens/execution/${revoked.credential.id}`, {
      method: "DELETE",
    });
    const initialPolicy = (await request("/api/v1/config")).policy;

    async function gateway(token = credential.token) {
      const body = '{"synthetic":true}';
      const metadata = {
        protocolVersion: 1,
        transport: "http",
        requestId: randomBytes(16).toString("hex"),
        nonce: randomBytes(16).toString("hex"),
        targetOrigin: targetUrl,
        targetHeaders: [{ name: "content-type", value: "application/json" }],
        fetchOptions: { redirect: "follow", timeoutMs: 60_000 },
        body: { sizeBytes: Buffer.byteLength(body) },
        hop: 0,
      };
      const response = await globalThis.fetch(
        config.publicGatewayUrl + "/arbitrary/v1?key=one&key=two",
        {
          method: "POST",
          body,
          headers: {
            [protocol.ONE_FETCH_TOKEN_HEADER]: token,
            [protocol.ONE_FETCH_REQUEST_HEADER]:
              protocol.encodeRequestMetadata(metadata),
          },
          signal: globalThis.AbortSignal.timeout(10_000),
          redirect: "error",
        },
      );
      const classification = await core.classifyOneFetchResponse(
        response.headers.get(protocol.ONE_FETCH_RESPONSE_HEADER),
        {
          nonce: metadata.nonce,
          requestId: metadata.requestId,
          token,
        },
      );
      const text = await response.text();
      return { status: response.status, classification, text };
    }
    async function assertPreserved(
      version,
      paused,
      requireSignedDenial = true,
    ) {
      const health = await request("/api/v1/health");
      const capabilities = await request("/api/v1/capabilities");
      const openapi = await request("/api/v1/openapi.json");
      assert.equal(health.version, version);
      assert.equal(capabilities.buildVersion, version);
      assert.equal(openapi.info.version, version);
      const current = await request("/api/v1/config");
      assert.deepEqual(current.policy, initialPolicy);
      assert.equal(current.gatewayPaused, paused);
      assert.ok(
        (await request("/api/v1/auth/sessions")).sessions.some(
          (session) => session.id === pair.sessionId,
        ),
      );
      const beforeHits = hits;
      const result = await gateway();
      if (paused) {
        assert.notEqual(result.status, 201);
        assert.equal(hits, beforeHits);
      } else {
        assert.equal(result.status, 201);
        assert.equal(hits, beforeHits + 1);
        assert.equal(result.classification.source, "target");
        assert.deepEqual(JSON.parse(result.text), {
          url: "/arbitrary/v1?key=one&key=two",
          method: "POST",
          body: '{"synthetic":true}',
        });
        const headers = result.classification.metadata.targetHeaders;
        assert.equal(
          headers.filter((header) => header.name.toLowerCase() === "set-cookie")
            .length,
          2,
        );
        assert.ok(
          headers.some(
            (header) => header.name.toLowerCase() === "server-timing",
          ),
        );
      }
      const beforeDenied = hits;
      const denied = await gateway(revoked.token);
      assert.equal(denied.status, 401);
      assert.equal(hits, beforeDenied);
      if (requireSignedDenial) {
        assert.equal(denied.classification.source, "relay");
        assert.equal(denied.classification.error.code, "unauthorized");
      }
    }
    async function audit() {
      const key = await webcrypto.subtle.importKey(
        "spki",
        publicKey,
        "Ed25519",
        false,
        ["verify"],
      );
      const events = [];
      let cursor;
      do {
        const page = await request(
          "/api/v1/audit?limit=100" +
            (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        );
        events.push(...page.events);
        cursor = page.nextCursor;
        assert.ok(events.length < 1000);
      } while (cursor);
      assert.ok(events.length > 0);
      for (const event of events)
        assert.equal(await core.verifyAuditEvent(event, key), true);
      assertNoSecrets(events);
      return events;
    }
    function assertNoSecrets(value) {
      for (const secret of secrets.filter(Boolean))
        assert.equal(JSON.stringify(value).includes(secret), false);
    }
    return {
      adminToken,
      assertPreserved,
      audit,
      request,
      close,
      assertNoSecrets,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
