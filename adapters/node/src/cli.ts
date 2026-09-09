#!/usr/bin/env node
import { startOneFetchNode } from "./server.js";
import { emitBootstrapToken } from "./bootstrap-output.js";

const server = await startOneFetchNode();

console.log(`one-fetch Control listening at ${server.config.publicControlUrl}`);
console.log(`one-fetch Gateway listening at ${server.config.publicGatewayUrl}`);
if (server.bootstrapToken) {
  await emitBootstrapToken(server.bootstrapToken);
}

let fatalFailure = false;
void server.fatal.then(async (error) => {
  fatalFailure = true;
  console.error("Fatal database worker failure; shutting down:", error.message);
  process.exitCode = 1;
  try {
    await server.terminated;
  } catch (shutdownError) {
    console.error("Node adapter shutdown failed:", shutdownError);
  }
});

let stopping = false;
const stop = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log(`Received ${signal}; shutting down`);
  await server.close();
  if (!fatalFailure) process.exitCode = 0;
};

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
