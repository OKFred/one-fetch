import assert from "node:assert/strict";
import test from "node:test";
import { createCloudflareD1Query } from "./cloudflare-d1-query.mjs";

const state = {
  deploymentId: "preview-api",
  accountId: "a".repeat(32),
  resources: {
    control: "preview-api-control",
    gateway: "preview-api-gateway",
    database: "preview-api-db",
    databaseId: "01234567-89ab-cdef-0123-456789abcdef",
  },
};
const token = globalThis.crypto.randomUUID();
const runWrangler = async (args) => {
  assert.deepEqual(args, ["auth", "token", "--json"]);
  return { type: "oauth", token };
};

test("D1 coordination uses bound parameters, pinned URL and memory-only authorization", async () => {
  const query = await createCloudflareD1Query(state, {
    runWrangler,
    fetch: async (url, init) => {
      assert.equal(
        url,
        `https://api.cloudflare.com/client/v4/accounts/${state.accountId}/d1/database/${state.resources.databaseId}/query`,
      );
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof globalThis.AbortSignal);
      assert.deepEqual(JSON.parse(init.body), {
        sql: "SELECT ? AS value",
        params: ["quote';--"],
      });
      return globalThis.Response.json({
        success: true,
        result: [{ success: true, results: [{ value: "quote';--" }] }],
      });
    },
  });
  assert.deepEqual(await query("SELECT ? AS value", ["quote';--"]), [
    { value: "quote';--" },
  ]);
});

test("D1 errors, oversized bodies and malformed acknowledgements are redacted and never retried", async () => {
  for (const response of [
    () => new globalThis.Response(token, { status: 500 }),
    () => new globalThis.Response("x".repeat(65_537)),
    () => globalThis.Response.json({ success: true, result: [] }),
    () =>
      globalThis.Response.json({
        success: false,
        errors: [{ message: token }],
      }),
    () => {
      throw new Error(token);
    },
  ]) {
    let calls = 0;
    const query = await createCloudflareD1Query(state, {
      runWrangler,
      fetch: async () => {
        calls++;
        return response();
      },
    });
    await assert.rejects(query("SELECT 1", []), (error) => {
      assert.equal(error.message.includes(token), false);
      assert.match(error.message, /outcome may be unknown/u);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("Wrangler authentication failures never expose captured credentials", async () => {
  await assert.rejects(
    createCloudflareD1Query(state, {
      runWrangler: async () => {
        throw new Error(token);
      },
    }),
    (error) => {
      assert.equal(
        error.message,
        "Cloudflare coordination authentication failed",
      );
      assert.equal(error.stack.includes(token), false);
      return true;
    },
  );
});
