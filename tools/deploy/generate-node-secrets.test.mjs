import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateNodeSecrets } from "./generate-node-secrets.mjs";

test("Node secret generation writes a complete non-overwriting recovery file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-fetch-node-secrets-"));
  const output = join(directory, "secrets.json");
  const result = await generateNodeSecrets(output);
  const stored = JSON.parse(await readFile(output, "utf8"));

  assert.deepEqual(stored, result.secrets);
  assert.equal(
    Buffer.from(stored.ONE_FETCH_INSTANCE_PEPPER, "base64url").length,
    32,
  );
  assert.equal(
    Buffer.from(stored.ONE_FETCH_PROTOCOL_SIGNING_KEY, "base64url").length,
    32,
  );
  assert.ok(
    Buffer.from(stored.ONE_FETCH_AUDIT_SIGNING_PRIVATE_KEY, "base64").length >
      32,
  );
  await assert.rejects(generateNodeSecrets(output), /exist/u);
});
