#!/usr/bin/env node
import { startOneFetchNode } from "./server.js";

const server = await startOneFetchNode();

console.log(`one-fetch Control listening at ${server.config.publicControlUrl}`);
console.log(`one-fetch Gateway listening at ${server.config.publicGatewayUrl}`);
if (server.bootstrapToken) {
  console.log("One-time bootstrap token (not recoverable after this output):");
  console.log(server.bootstrapToken);
}

let stopping = false;
const stop = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log(`Received ${signal}; shutting down`);
  await server.close();
  process.exitCode = 0;
};

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
