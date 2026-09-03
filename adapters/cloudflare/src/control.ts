import { controlApp } from "./control-routes";
import { ControlService } from "./control-service";
import { AuthDurableObject } from "./durable-objects/auth";
import { QuotaDurableObject } from "./durable-objects/quota";
import { ensureInstance, purgeExpiredRecords } from "./storage";

export { AuthDurableObject, ControlService, QuotaDurableObject };

export default {
  fetch: controlApp.fetch,
  scheduled(
    _controller: ScheduledController,
    env: CloudflareControlEnv,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(
      (async () => {
        await ensureInstance(env.DB);
        await purgeExpiredRecords(env.DB);
      })(),
    );
  },
} satisfies ExportedHandler<CloudflareControlEnv>;
