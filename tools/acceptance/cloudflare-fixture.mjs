import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  repositoryRoot,
  runWrangler,
  workerExists,
} from "../deploy/cloudflare-runtime.mjs";
import { parseWorkersUrl } from "../deploy/cloudflare-support.mjs";

const NAME_PATTERN = /^one-fetch-fixture-[a-z0-9]{8,20}$/u;

export function validateFixtureName(name) {
  if (!NAME_PATTERN.test(name))
    throw new Error(
      "Fixture name must be one-fetch-fixture- plus 8-20 characters",
    );
  return name;
}

function valueAfter(values, name) {
  const index = values.indexOf(name);
  const value = index < 0 ? undefined : values[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return value;
}

export async function deployCloudflareFixture(name, dependencies = {}) {
  const run = dependencies.runWrangler ?? runWrangler;
  const exists = dependencies.workerExists ?? workerExists;
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const checked = validateFixtureName(name);
  if (await exists(checked)) throw new Error("Fixture Worker already exists");
  const source = resolve(
    repositoryRoot,
    "tools",
    "acceptance",
    "cloudflare-target.mjs",
  );
  const output = await run([
    "deploy",
    source,
    "--name",
    checked,
    "--compatibility-date",
    "2026-09-04",
    "--compatibility-flags",
    "enable_request_signal",
  ]);
  const origin = parseWorkersUrl(output);
  const response = await fetch(new globalThis.URL("/status/204", origin), {
    cache: "no-store",
    signal: globalThis.AbortSignal.timeout(15_000),
  });
  if (response.status !== 204)
    throw new Error(`Fixture verification returned ${response.status}`);
  return { name: checked, origin };
}

export async function cleanupCloudflareFixture(
  name,
  confirmation,
  dependencies = {},
) {
  const run = dependencies.runWrangler ?? runWrangler;
  const exists = dependencies.workerExists ?? workerExists;
  const checked = validateFixtureName(name);
  if (confirmation !== checked)
    throw new Error("Fixture cleanup confirmation mismatch");
  if (!(await exists(checked)))
    throw new Error("Fixture Worker does not exist");
  await run(["delete", checked, "--force"]);
  if (await exists(checked))
    throw new Error("Fixture Worker still exists after cleanup");
  return { name: checked, absent: true };
}

async function main(values) {
  const command = values[0];
  const name = valueAfter(values, "--name");
  if (command === "deploy") return deployCloudflareFixture(name);
  if (command === "cleanup")
    return cleanupCloudflareFixture(name, valueAfter(values, "--confirm-name"));
  throw new Error("Use deploy or cleanup");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
