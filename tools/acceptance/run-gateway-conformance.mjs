import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  OneFetchControlClient,
  OneFetchGatewayClient,
} from "../../packages/client/dist/index.js";
import {
  ALL_HTTP_CONFORMANCE_FIXTURES,
  HTTP_CONFORMANCE_FIXTURES,
  assertReportDoesNotContain,
  createAcceptanceReport,
  runGatewayConformance,
} from "../../packages/conformance/dist/index.js";

function parseArguments(values) {
  const options = { suite: "smoke", resources: [], targetProfile: "standard" };
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    const value = values[index + 1];
    if (name === "--full") {
      options.suite = "full";
      continue;
    }
    if (name === "--resource") {
      if (!value?.includes(":")) throw new Error("--resource expects kind:id");
      const separator = value.indexOf(":");
      options.resources.push({
        kind: value.slice(0, separator),
        id: value.slice(separator + 1),
      });
      index += 1;
      continue;
    }
    const key = {
      "--control-url": "controlUrl",
      "--gateway-url": "gatewayUrl",
      "--output": "output",
      "--target-url": "targetUrl",
      "--token-file": "tokenFile",
      "--target-profile": "targetProfile",
    }[name];
    if (key === undefined || value === undefined)
      throw new Error(`Unknown or incomplete argument: ${name ?? "<empty>"}`);
    options[key] = value;
    index += 1;
  }
  if (!["standard", "cloudflare-worker"].includes(options.targetProfile))
    throw new Error("--target-profile must be standard or cloudflare-worker");
  for (const key of [
    "controlUrl",
    "gatewayUrl",
    "output",
    "targetUrl",
    "tokenFile",
  ]) {
    if (!options[key])
      throw new Error(
        `Missing required --${key.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}`,
      );
  }
  return options;
}

function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

const options = parseArguments(process.argv.slice(2));
const token = (await readFile(resolve(options.tokenFile), "utf8")).trim();
if (token.length < 16) throw new Error("Execution token file is invalid");

const control = new OneFetchControlClient({ controlUrl: options.controlUrl });
const capabilities = await control.getCapabilities();
if (capabilities.transports.http.state !== "stable")
  throw new Error("Adapter does not advertise stable HTTP");
for (const transport of ["websocket", "tcp", "tls"]) {
  if (capabilities.transports[transport].state !== "unsupported")
    throw new Error(`Preview adapter unexpectedly enables ${transport}`);
}
const gateway = new OneFetchGatewayClient({
  gatewayUrl: options.gatewayUrl,
  token,
  capabilities: capabilities.fetchOptions,
  client: { name: "one-fetch-conformance", version: "0.1.0" },
});
const fixtures =
  options.suite === "full"
    ? ALL_HTTP_CONFORMANCE_FIXTURES
    : HTTP_CONFORMANCE_FIXTURES;
const suite = await runGatewayConformance(
  gateway,
  options.targetUrl,
  fixtures,
  {
    getExecutionReport: (reportId) =>
      control.getExecutionReport(reportId, token),
    skipFixtures:
      options.targetProfile === "cloudflare-worker"
        ? {
            "truncated-response":
              "Cloudflare Workers normalizes a synthetic errored response stream to a completed response before the Gateway receives it.",
          }
        : {},
  },
);
const report = await createAcceptanceReport({
  commit: currentCommit(),
  capabilities,
  controlUrl: options.controlUrl,
  gatewayUrl: options.gatewayUrl,
  targetUrl: options.targetUrl,
  suite,
  cleanup: { state: "pending", resources: options.resources },
});
assertReportDoesNotContain(report, [token]);
await writeFile(
  resolve(options.output),
  `${JSON.stringify(report, null, 2)}\n`,
  {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  },
);
process.stdout.write(
  `${JSON.stringify({ adapter: report.adapter, passed: report.suite.passed, report: resolve(options.output) })}\n`,
);
if (!report.suite.passed) process.exitCode = 1;
