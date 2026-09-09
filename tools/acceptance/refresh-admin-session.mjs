import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { OneFetchControlClient } from "../../packages/client/dist/index.js";

function option(values, name) {
  const index = values.indexOf(name);
  const value = index < 0 ? undefined : values[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return value;
}

async function readAdministrator(path) {
  const value = JSON.parse(await readFile(resolve(path), "utf8"));
  if (
    Object.keys(value).sort().join(",") !== "password,username" ||
    typeof value.username !== "string" ||
    value.username.length === 0 ||
    typeof value.password !== "string" ||
    value.password.length === 0
  ) {
    throw new Error("Administrator credential file is invalid");
  }
  return value;
}

async function replacePrivateFile(path, value) {
  const destination = resolve(path);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, destination);
}

export async function refreshAdminSession(options, dependencies = {}) {
  const administrator = await readAdministrator(options.administratorFile);
  const client =
    dependencies.client ??
    new OneFetchControlClient({ controlUrl: options.controlUrl });
  const session = await client.login({
    schemaVersion: 1,
    username: administrator.username,
    password: administrator.password,
    rememberDevice: false,
  });
  await replacePrivateFile(options.tokenFile, `${session.accessToken}\n`);
  return { refreshed: true, tokenFile: resolve(options.tokenFile) };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const values = process.argv.slice(2);
  const result = await refreshAdminSession({
    controlUrl: option(values, "--control-url"),
    administratorFile: option(values, "--administrator-file"),
    tokenFile: option(values, "--token-file"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
