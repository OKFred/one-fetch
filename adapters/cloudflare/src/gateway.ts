import { handleGatewayRequest } from "./gateway-handler";
import { handleGatewayTunnel } from "./gateway/tunnel";

export default {
  async fetch(
    request: Request,
    env: CloudflareGatewayEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return handleGatewayTunnel(request, env, ctx);
    }
    return handleGatewayRequest(request, env, ctx);
  },
} satisfies ExportedHandler<CloudflareGatewayEnv>;
