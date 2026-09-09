import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { refreshAdminSession } from "./refresh-admin-session.mjs";

test("refreshes an admin token without returning the credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-session-"));
  try {
    const administratorFile = join(root, "administrator.json");
    const tokenFile = join(root, "admin-token");
    await writeFile(
      administratorFile,
      JSON.stringify({ username: "admin", password: "secret-password" }),
    );
    await writeFile(tokenFile, "expired-token\n");
    let received;
    const result = await refreshAdminSession(
      {
        controlUrl: "https://control.example",
        administratorFile,
        tokenFile,
      },
      {
        client: {
          login(input) {
            received = input;
            return Promise.resolve({ accessToken: "replacement-token" });
          },
        },
      },
    );
    assert.deepEqual(received, {
      schemaVersion: 1,
      username: "admin",
      password: "secret-password",
      rememberDevice: false,
    });
    assert.equal(await readFile(tokenFile, "utf8"), "replacement-token\n");
    assert.deepEqual(Object.keys(result).sort(), ["refreshed", "tokenFile"]);
    assert.doesNotMatch(JSON.stringify(result), /replacement-token/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
