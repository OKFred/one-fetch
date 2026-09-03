import { controlApp } from "./control-routes";
import { controlError } from "./control-support";
import { ControlService } from "./control-service";
import { AuthDurableObject } from "./durable-objects/auth";
import { QuotaDurableObject } from "./durable-objects/quota";
import {
  assertMigrationCompatibility,
  logMigrationCompatibilityFailure,
} from "./migration-integrity";
import { ensureInstance, purgeExpiredRecords } from "./storage";

export { AuthDurableObject, ControlService, QuotaDurableObject };

export default {
  async fetch(
    request: Request,
    env: CloudflareControlEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      await assertMigrationCompatibility(env.DB);
    } catch (error) {
      logMigrationCompatibilityFailure("control", error);
      return controlError(
        503,
        "storage_unavailable",
        "The database migration state is incompatible",
        { retryable: false },
      );
    }
    return controlApp.fetch(request, env, ctx);
  },
  scheduled(
    _controller: ScheduledController,
    env: CloudflareControlEnv,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(
      (async () => {
        try {
          await assertMigrationCompatibility(env.DB);
        } catch (error) {
          logMigrationCompatibilityFailure("scheduled", error);
          throw error;
        }
        await ensureInstance(env.DB);
        await purgeExpiredRecords(env.DB);
      })(),
    );
  },
} satisfies ExportedHandler<CloudflareControlEnv>;
