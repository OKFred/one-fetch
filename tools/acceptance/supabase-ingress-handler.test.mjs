import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createIngressProbeHandler,
  INGRESS_PROBE_CASES,
} from "./supabase-ingress-handler.mjs";

const token = "s".repeat(43);
const functionName = "one-fetch-ingress-0123456789abcdef";
const options = {
  functionName,
  tokenSha256: createHash("sha256").update(token).digest("hex"),
  expiresAt: Date.now() + 60000,
};
const base = `https://project.test/functions/v1/${functionName}`;
const headers = {
  "one-fetch-probe-token": token,
  "one-fetch-probe-case": "space",
};

test("ingress probe observes every fixed synthetic case without forwarding", async () => {
  const handler = createIngressProbeHandler(options);
  for (const [caseId, path] of INGRESS_PROBE_CASES) {
    const response = await handler(
      new Request(base + path, {
        headers: {
          ...headers,
          "one-fetch-probe-case": caseId,
          Authorization: "private-canary",
        },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.rawPathAndQuery, path);
    assert.equal(body.pathname + body.search, path);
    assert.equal(JSON.stringify(body).includes(token), false);
    assert.equal(JSON.stringify(body).includes("private-canary"), false);
    assert.deepEqual(
      Object.keys(body).sort(),
      [
        "schemaVersion",
        "functionName",
        "caseId",
        "rawPathAndQuery",
        "pathname",
        "search",
      ].sort(),
    );
  }
});

test("ingress probe rejects unauthenticated, expired, unknown and body requests", async () => {
  const handler = createIngressProbeHandler(options);
  for (const supplied of ["", "t".repeat(43), "s".repeat(2000)]) {
    const response = await handler(
      new Request(base + "/echo", {
        headers: { ...headers, "one-fetch-probe-token": supplied },
      }),
    );
    assert.equal(response.status, 401);
  }
  assert.equal(
    (
      await createIngressProbeHandler({ ...options, expiresAt: 0 })(
        new Request(base + "/echo", { headers }),
      )
    ).status,
    410,
  );
  assert.equal(
    (
      await handler(
        new Request(base + "/echo", {
          headers: { ...headers, "one-fetch-probe-case": "unknown" },
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handler(
        new Request(base + "/echo", {
          method: "POST",
          headers,
          body: "private-body",
        }),
      )
    ).status,
    405,
  );
  assert.equal(
    (await handler(new Request("https://project.test/wrong/echo", { headers })))
      .status,
    400,
  );
  assert.throws(() =>
    createIngressProbeHandler({ ...options, functionName: "production" }),
  );
});
