import assert from "node:assert/strict";
import test from "node:test";

import { setPaused } from "./cloudflare-runtime.mjs";

test("Cloudflare pause updates use the current strong configuration ETag", async () => {
  const requests = [];
  const fetch = (url, init) => {
    requests.push({ url: String(url), init });
    if (init.method === "PUT") {
      assert.equal(init.headers["If-Match"], '"config-1"');
      return Promise.resolve(
        globalThis.Response.json({ version: "config-2", gatewayPaused: true }),
      );
    }
    return Promise.resolve(
      globalThis.Response.json({ version: "config-1", gatewayPaused: false }),
    );
  };
  const result = await setPaused(
    { controlUrl: "https://control.example" },
    "a".repeat(32),
    true,
    fetch,
  );
  assert.equal(result.gatewayPaused, true);
  assert.equal(requests.length, 2);
});

test("Cloudflare pause skips a no-op without issuing a write", async () => {
  let calls = 0;
  const result = await setPaused(
    { controlUrl: "https://control.example" },
    "a".repeat(32),
    false,
    () => {
      calls += 1;
      return Promise.resolve(
        globalThis.Response.json({ version: "config-1", gatewayPaused: false }),
      );
    },
  );
  assert.equal(result.gatewayPaused, false);
  assert.equal(calls, 1);
});
