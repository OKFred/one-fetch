import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

const testEnv = env as unknown as CloudflareControlEnv & {
  TEST_MIGRATIONS: D1Migration[];
};

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.batch(
    [
      "execution_reports",
      "execution_tokens",
      "access_tokens",
      "refresh_token_history",
      "auth_sessions",
      "recovery_codes",
      "auth_login_state",
      "auth_unknown_login_state",
      "webhook_outbox",
      "audit_events",
      "admins",
      "instance_state",
    ].map((table) => testEnv.DB.prepare(`DELETE FROM ${table}`)),
  );
});
