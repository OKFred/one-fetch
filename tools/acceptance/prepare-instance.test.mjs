import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareAcceptanceInstance } from "./prepare-instance.mjs";

test("instance preparation verifies auth, publishes one target, and writes tokens privately", async () => {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-prepare-"));
  try {
    const secretFile = join(root, "bootstrap.json");
    const outputDirectory = join(root, "credentials");
    await writeFile(
      secretFile,
      JSON.stringify({ BOOTSTRAP_SECRET: "b".repeat(43) }),
    );
    const calls = [];
    let accessToken = "first-access-token-value-that-is-long";
    const client = {
      getBootstrapStatus: () =>
        Promise.resolve({ initialized: false, instanceId: "fixture" }),
      bootstrap: (input) => {
        calls.push(["bootstrap", input]);
        return Promise.resolve({
          sessionId: "session-1",
          refreshToken: "r".repeat(40),
        });
      },
      listSessions: () => Promise.resolve({ sessions: [{ id: "session-1" }] }),
      refresh: () => Promise.resolve({}),
      logout: () => Promise.resolve({}),
      login: () => Promise.resolve({ accessToken }),
      getConfiguration: () =>
        Promise.resolve({
          version: "config-1",
          gatewayPaused: true,
          policy: { revision: 0 },
        }),
      updatePolicy: (input, version) => {
        calls.push(["policy", input, version]);
        return Promise.resolve({
          version: "config-2",
          gatewayPaused: true,
          policy: input.policy,
        });
      },
      setGatewayPaused: (_input, version) => {
        calls.push(["resume", version]);
        return Promise.resolve({
          version: "config-3",
          gatewayPaused: false,
          policy: { revision: 1 },
        });
      },
      createExecutionToken: (input) => {
        calls.push(["token", input]);
        return Promise.resolve({
          token: "e".repeat(40),
          credential: { id: "token-1" },
        });
      },
      getAuditPage: () => Promise.resolve({ events: [] }),
    };
    const result = await prepareAcceptanceInstance(
      {
        controlUrl: "https://control.example",
        targetUrl: "https://target.example",
        bootstrapSecretFile: secretFile,
        outputDirectory,
      },
      { client },
    );
    assert.equal(result.configVersion, "config-3");
    assert.equal(
      (await readFile(join(outputDirectory, "admin-token"), "utf8")).trim(),
      accessToken,
    );
    assert.equal(
      (await readFile(join(outputDirectory, "execution-token"), "utf8")).trim(),
      "e".repeat(40),
    );
    assert.equal(
      calls.find(([name]) => name === "policy")[1].policy.rules[0].match
        .origins[0].value,
      "https://target.example",
    );
    assert.deepEqual(
      calls.find(([name]) => name === "resume"),
      ["resume", "config-2"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
