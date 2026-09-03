import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

const testEnv = env as unknown as CloudflareControlEnv & {
  TEST_MIGRATIONS: D1Migration[];
};

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});
