import { handleGatewayRequest } from "./gateway-handler";

const rejectUpgrade = (): Response =>
  Response.json(
    {
      error: {
        code: "protocol_unsupported",
        message: "The 0.1 Preview runtime exposes only HTTP requests",
        origin: "adapter",
        retryable: false,
        stage: "protocol",
      },
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/problem+json; charset=utf-8",
      },
      status: 501,
    },
  );

export default {
  async fetch(
    request: Request,
    env: CloudflareGatewayEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return rejectUpgrade();
    }
    return handleGatewayRequest(request, env, ctx);
  },
} satisfies ExportedHandler<CloudflareGatewayEnv>;
