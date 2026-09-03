import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const { privateKey } = generateKeyPairSync("ed25519");
const testSecrets = {
  BOOTSTRAP_SECRET: "test-bootstrap-token-with-enough-entropy",
  INSTANCE_PEPPER: "test-only-pepper-with-enough-entropy",
  ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  AUDIT_SIGNING_KEY: privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("base64url"),
};
Object.assign(process.env, testSecrets);

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(
        fileURLToPath(new URL("./migrations", import.meta.url)),
      );
      return {
        wrangler: { configPath: "./wrangler.control.jsonc" },
        miniflare: {
          // Pool 0.22.0's test runner supports 2026-08-22. Production remains pinned
          // to 2026-09-04 in Wrangler and is checked by the dry-run build.
          compatibilityDate: "2026-08-22",
          bindings: {
            TEST_MIGRATIONS: migrations,
            ...testSecrets,
          },
        },
      };
    }),
  ],
  test: {
    fileParallelism: false,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
  },
});
