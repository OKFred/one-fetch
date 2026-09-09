import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { OneFetchControlClient } from "../../packages/client/dist/index.js";

function option(values, name) {
  const index = values.indexOf(name);
  const value = index < 0 ? undefined : values[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
  return value;
}

function targetOrigin(value) {
  const url = new globalThis.URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Target URL must be an HTTP(S) origin");
  }
  return url;
}

async function bootstrapSecret(path) {
  const source = (await readFile(resolve(path), "utf8")).trim();
  try {
    const value = JSON.parse(source);
    const secret = value.BOOTSTRAP_SECRET ?? value.ONE_FETCH_BOOTSTRAP_SECRET;
    if (typeof secret === "string" && secret.length >= 32) return secret;
  } catch {
    const envSecret = /^ONE_FETCH_BOOTSTRAP_SECRET=(.{32,})$/mu.exec(
      source,
    )?.[1];
    if (envSecret && !/[\r\n]/u.test(envSecret)) return envSecret;
    if (source.length >= 32 && !source.includes("\n")) return source;
  }
  throw new Error("Bootstrap secret file is invalid");
}

async function privateFile(path, value) {
  await writeFile(path, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function assertNoSecretAudit(audit, values) {
  const serialized = JSON.stringify(audit);
  if (values.some((value) => serialized.includes(value)))
    throw new Error("Acceptance secret canary reached the audit response");
}

export async function prepareAcceptanceInstance(options, dependencies = {}) {
  const origin = targetOrigin(options.targetUrl);
  const secret = await bootstrapSecret(options.bootstrapSecretFile);
  const username = `acceptance-${randomUUID().slice(0, 8)}`;
  const password = Buffer.from(randomBytes(36)).toString("base64url");
  const client =
    dependencies.client ??
    new OneFetchControlClient({ controlUrl: options.controlUrl });
  const status = await client.getBootstrapStatus();
  if (status.initialized)
    throw new Error("Acceptance instance is already bootstrapped");
  const first = await client.bootstrap({
    schemaVersion: 1,
    bootstrapSecret: secret,
    username,
    password,
  });
  const sessions = await client.listSessions();
  if (!sessions.sessions.some(({ id }) => id === first.sessionId))
    throw new Error("Bootstrap session was not listed");
  await client.refresh({ schemaVersion: 1, refreshToken: first.refreshToken });
  await client.logout();
  const active = await client.login({
    schemaVersion: 1,
    username,
    password,
    rememberDevice: false,
  });
  let configuration = await client.getConfiguration();
  configuration = await client.updatePolicy(
    {
      schemaVersion: 1,
      policy: {
        schemaVersion: 1,
        mode: "allowlist",
        revision: configuration.policy.revision,
        rules: [
          {
            id: "acceptance-target",
            name: "Temporary conformance target",
            enabled: true,
            action: "allow",
            match: {
              transports: ["http"],
              schemes: [origin.protocol.slice(0, -1)],
              origins: [
                {
                  operator: "exact",
                  value: origin.origin,
                  caseSensitive: false,
                },
              ],
            },
          },
        ],
      },
    },
    configuration.version,
  );
  if (configuration.gatewayPaused) {
    configuration = await client.setGatewayPaused(
      { schemaVersion: 1, paused: false },
      configuration.version,
    );
  }
  const credential = await client.createExecutionToken({
    schemaVersion: 1,
    name: "temporary-conformance",
    scope: {
      transports: ["http"],
      origins: [origin.origin],
      ports: [Number(origin.port || (origin.protocol === "https:" ? 443 : 80))],
    },
    quota: {
      requestsPerMinute: 300,
      burst: 50,
      concurrentHttp: 4,
      concurrentTunnels: 0,
      bytesPerDay: 1_073_741_824,
    },
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString(),
  });
  const audit = await client.getAuditPage({ limit: 50 });
  assertNoSecretAudit(audit, [secret, password, credential.token]);

  const outputDirectory = resolve(options.outputDirectory);
  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 });
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  await Promise.all([
    privateFile(
      join(outputDirectory, "administrator.json"),
      `${JSON.stringify({ username, password }, null, 2)}\n`,
    ),
    privateFile(
      join(outputDirectory, "admin-token"),
      `${active.accessToken}\n`,
    ),
    privateFile(
      join(outputDirectory, "execution-token"),
      `${credential.token}\n`,
    ),
  ]);
  return {
    instanceId: status.instanceId,
    configVersion: configuration.version,
    executionTokenId: credential.credential.id,
    outputDirectory,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const values = process.argv.slice(2);
  const result = await prepareAcceptanceInstance({
    controlUrl: option(values, "--control-url"),
    targetUrl: option(values, "--target-url"),
    bootstrapSecretFile: option(values, "--bootstrap-secret-file"),
    outputDirectory: option(values, "--output-directory"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
