import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateSecretsFile } from "./cloudflare-support.mjs";
import { generateCloudflareSecrets } from "./generate-cloudflare-secrets.mjs";

test("Cloudflare secret generation creates a valid non-overwriting file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-fetch-cf-secrets-"));
  try {
    const output = join(directory, "secrets.json");
    const result = await generateCloudflareSecrets(output);
    await validateSecretsFile(output);
    assert.equal(
      Buffer.from(result.secrets.ENCRYPTION_KEY, "base64url").length,
      32,
    );
    await assert.rejects(generateCloudflareSecrets(output), /exist/iu);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
