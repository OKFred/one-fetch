import { createServer } from "node:http";
import process from "node:process";
import { Readable } from "node:stream";

import { handleConformanceTarget } from "../../packages/conformance/dist/index.js";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const hostname = argument("--host", "127.0.0.1");
const port = Number(argument("--port", "0"));
if (!hostname || !Number.isInteger(port) || port < 0 || port > 65_535)
  throw new Error("Invalid target server address");

const server = createServer(async (incoming, outgoing) => {
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const body = ["GET", "HEAD"].includes(incoming.method ?? "GET")
      ? undefined
      : Readable.toWeb(incoming);
    const request = new globalThis.Request(
      `http://${hostname}:${address.port}${incoming.url ?? "/"}`,
      {
        method: incoming.method,
        headers: incoming.headersDistinct,
        ...(body === undefined ? {} : { body, duplex: "half" }),
      },
    );
    const response = await handleConformanceTarget(request);
    outgoing.statusCode = response.status;
    outgoing.statusMessage = response.statusText;
    for (const [name, value] of response.headers) {
      if (name.toLowerCase() !== "set-cookie") outgoing.setHeader(name, value);
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) outgoing.setHeader("Set-Cookie", cookies);
    if (response.body === null) outgoing.end();
    else {
      const bodyStream = Readable.fromWeb(response.body);
      bodyStream.once("error", (error) => outgoing.destroy(error));
      bodyStream.pipe(outgoing);
    }
  } catch (error) {
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.destroy(
      error instanceof Error ? error : new Error("Fixture failed"),
    );
  }
});

server.listen(port, hostname, () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  process.stdout.write(
    `${JSON.stringify({ origin: `http://${hostname}:${address.port}`, pid: process.pid })}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
