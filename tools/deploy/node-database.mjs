import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { digestFile, readJson } from "./node-files.mjs";

export async function controlRequest(controlUrl, token, path, init = {}) {
  const response = await globalThis.fetch(
    new globalThis.URL(path, controlUrl),
    {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
      cache: "no-store",
      redirect: "error",
      signal: globalThis.AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok)
    throw new Error(`Control ${path} failed with HTTP ${response.status}`);
  return response.json();
}

export async function inspectInstalledMigrations(directory, expectedVersion) {
  const manifest = await readJson(join(directory, "migration-manifest.json"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.hashAlgorithm !== "sha256" ||
    manifest.migrationsDirectory !== "migrations" ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1 ||
    !Array.isArray(manifest.migrations) ||
    manifest.migrations.length !== expectedVersion
  )
    throw new Error(
      "Installed migration manifest does not match the build schema",
    );
  for (const [index, entry] of manifest.migrations.entries()) {
    if (
      entry.version !== index + 1 ||
      !new RegExp(
        `^${String(index + 1).padStart(4, "0")}_[a-z0-9_]+\\.sql$`,
        "u",
      ).test(entry.file) ||
      !Number.isInteger(entry.bytes) ||
      entry.bytes < 1 ||
      !/^[a-f0-9]{64}$/u.test(entry.artifactSha256)
    )
      throw new Error("Installed migration manifest entry is invalid");
    const sql = await readFile(join(directory, "migrations", entry.file));
    if (
      sql.length !== entry.bytes ||
      createHash("sha256").update(sql).digest("hex") !== entry.artifactSha256
    )
      throw new Error("Installed migration SQL integrity check failed");
  }
  return manifest;
}

export async function inspectInstalledDatabase(
  path,
  directory,
  expectedVersion,
) {
  if (!(await stat(path).catch(() => undefined))?.isFile())
    throw new Error("An existing SQLite database is required for verification");
  const manifest = await inspectInstalledMigrations(directory, expectedVersion);
  const database = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
  try {
    database.exec("BEGIN");
    if (
      database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
    )
      throw new Error("SQLite integrity_check failed");
    const rows = database
      .prepare(
        "SELECT version, checksum FROM schema_migrations ORDER BY version",
      )
      .all();
    if (
      rows.length !== expectedVersion ||
      rows.some(
        (row, index) =>
          row.version !== index + 1 ||
          row.checksum !== manifest.migrations[index].artifactSha256,
      )
    )
      throw new Error(
        "Applied migration ledger does not match the installed build",
      );
    let identity;
    try {
      identity = JSON.parse(
        database
          .prepare("SELECT value_json FROM instance_config WHERE key = ?")
          .get("configuration")?.value_json,
      );
    } catch {
      throw new Error("Stored instance identity is invalid");
    }
    if (
      [
        identity?.instanceId,
        identity?.controlGatewayPairId,
        identity?.version,
      ].some(
        (value) =>
          typeof value !== "string" || value.length === 0 || value.length > 256,
      )
    )
      throw new Error("Stored instance identity is incomplete");
    return {
      schemaVersion: rows.length,
      instanceId: identity.instanceId,
      controlGatewayPairId: identity.controlGatewayPairId,
      configVersion: identity.version,
    };
  } finally {
    database.close();
  }
}

export async function setGatewayPaused(
  controlUrl,
  token,
  paused,
  identity,
  beforeWrite,
) {
  const current = await controlRequest(controlUrl, token, "/api/v1/config");
  if (
    current.instanceId !== identity.instanceId ||
    current.controlGatewayPairId !== identity.controlGatewayPairId ||
    current.version !== identity.configVersion
  )
    throw new Error(
      "Control configuration changed or does not match the verified database",
    );
  if (current.gatewayPaused === paused) return current;
  await beforeWrite();
  const updated = await controlRequest(
    controlUrl,
    token,
    "/api/v1/config/gateway-paused",
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${current.version}"`,
      },
      body: JSON.stringify({ schemaVersion: 1, paused }),
    },
  );
  if (updated.gatewayPaused !== paused)
    throw new Error("Control did not confirm the Gateway pause state");
  return updated;
}

export async function backupDatabase(
  sourcePath,
  destinationPath,
  directory,
  expectedVersion,
) {
  await inspectInstalledDatabase(sourcePath, directory, expectedVersion);
  await mkdir(dirname(destinationPath), { recursive: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, destinationPath);
  } finally {
    source.close();
  }
  const identity = await inspectInstalledDatabase(
    destinationPath,
    directory,
    expectedVersion,
  );
  return { sha256: await digestFile(destinationPath), identity };
}

export async function tokenFromFile(path) {
  const token = (await readFile(resolve(path), "utf8")).trim();
  if (token.length < 16) throw new Error("Administrator token file is invalid");
  return token;
}
