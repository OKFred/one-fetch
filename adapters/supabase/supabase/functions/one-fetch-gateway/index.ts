import { createGatewayHandler } from "./handler.ts";

const handler = createGatewayHandler();

export default { fetch: handler };
