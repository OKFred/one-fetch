import { basename, join, relative, resolve } from "node:path";
import {
  assertPointerUnchanged,
  pointerSnapshot,
  readCurrent,
  readJson,
  resolveCurrentDirectory,
  safeDeploymentRoot,
  withNodeDeploymentLock,
  writeJsonAtomic,
} from "./node-files.mjs";
import { createNodeDeploymentPlan, extractVersion } from "./node-archive.mjs";
import {
  backupDatabase,
  inspectInstalledDatabase,
  inspectInstalledMigrations,
  setGatewayPaused,
  tokenFromFile,
} from "./node-database.mjs";

export async function applyNodeDeployment(options) {
  return withNodeDeploymentLock(options.root, "apply", (lock) =>
    applyNodeDeploymentLocked({ ...options, root: lock.root }, lock),
  );
}

async function applyNodeDeploymentLocked(options, lock) {
  const snapshot = await pointerSnapshot(options.root);
  const beforeWrite = async () => {
    await lock.assertOwned();
    await assertPointerUnchanged(options.root, snapshot);
  };
  const plan = await createNodeDeploymentPlan(options);
  let pause;
  let token;
  let verified;
  if (plan.requiresGatewayPause) {
    if (!options.controlUrl || !options.adminTokenFile)
      throw new Error(
        "Updates require Control URL and administrator token file",
      );
    verified = await verifyNodeDeploymentUnlocked({
      ...options,
      resume: false,
    });
    token = await tokenFromFile(options.adminTokenFile);
    pause = await setGatewayPaused(
      options.controlUrl,
      token,
      true,
      verified.identity,
      beforeWrite,
    );
  }
  const activatedAt = new Date().toISOString();
  let backupRecord;
  if (plan.requiresGatewayPause) {
    const database = resolve(
      options.database ?? join(plan.root, "data", "one-fetch.sqlite"),
    );
    const backupPath = join(
      plan.root,
      "backups",
      activatedAt.replaceAll(":", "-"),
      basename(database),
    );
    const backedUp = await backupDatabase(
      database,
      backupPath,
      join(plan.root, "versions", plan.previousVersion),
      verified.databaseSchemaVersion,
    );
    if (
      backedUp.identity.instanceId !== verified.identity.instanceId ||
      backedUp.identity.controlGatewayPairId !==
        verified.identity.controlGatewayPairId ||
      backedUp.identity.configVersion !== pause.version
    )
      throw new Error(
        "Backup identity does not match the confirmed paused instance",
      );
    backupRecord = {
      path: relative(plan.root, backupPath).replaceAll("\\", "/"),
      sha256: backedUp.sha256,
      schemaVersion: backedUp.identity.schemaVersion,
    };
  }
  await beforeWrite();
  await extractVersion(plan);
  const migrations = await inspectInstalledMigrations(
    plan.destination,
    plan.databaseSchemaVersion,
  );
  if (verified) {
    const previous = await inspectInstalledMigrations(
      join(plan.root, "versions", plan.previousVersion),
      verified.databaseSchemaVersion,
    );
    if (
      migrations.migrations.length < previous.migrations.length ||
      previous.migrations.some(
        (entry, index) =>
          entry.artifactSha256 !== migrations.migrations[index]?.artifactSha256,
      )
    )
      throw new Error("Update would remove or rewrite an applied migration");
  }
  const pointer = {
    schemaVersion: 1,
    version: plan.version,
    directory: relative(plan.root, plan.destination).replaceAll("\\", "/"),
    archiveSha256: plan.archiveSha256,
    activatedAt,
    ...(plan.previousVersion ? { previousVersion: plan.previousVersion } : {}),
    ...(plan.previousArchiveSha256
      ? { previousArchiveSha256: plan.previousArchiveSha256 }
      : {}),
  };
  await beforeWrite();
  await writeJsonAtomic(join(plan.root, "current.json"), pointer);
  const journal = {
    schemaVersion: 1,
    state: "restart-required",
    action: plan.action,
    version: plan.version,
    previousVersion: plan.previousVersion,
    activatedAt,
    gatewayPaused: Boolean(pause?.gatewayPaused),
    configVersion: pause?.version,
    backup: backupRecord,
    recovery: {
      automaticDatabaseRestore: false,
      previousArtifactRetained: plan.previousVersion !== undefined,
    },
  };
  await writeJsonAtomic(
    join(plan.root, "journal", `${activatedAt.replaceAll(":", "-")}.json`),
    journal,
  );
  return { ...journal, root: plan.root, current: pointer };
}

export async function verifyNodeDeployment(options) {
  if (options.resume === true)
    return withNodeDeploymentLock(options.root, "resume", (lock) =>
      verifyNodeDeploymentUnlocked({ ...options, root: lock.root }, lock),
    );
  return verifyNodeDeploymentUnlocked(options);
}

async function verifyNodeDeploymentUnlocked(options, lock) {
  const root = safeDeploymentRoot(options.root);
  const snapshot = await pointerSnapshot(root);
  const beforeWrite = async () => {
    await lock?.assertOwned();
    await assertPointerUnchanged(root, snapshot);
  };
  const current = await readCurrent(root);
  if (!current) throw new Error("No active Node deployment exists");
  const directory = resolveCurrentDirectory(root, current);
  const metadata = await readJson(join(directory, "BUILD-METADATA.json"));
  if (
    metadata.schemaVersion !== 1 ||
    metadata.entrypoint !== "dist/cli.js" ||
    metadata.version !== current.version
  )
    throw new Error("Active build metadata does not match current pointer");
  const database = resolve(
    options.database ?? join(root, "data", "one-fetch.sqlite"),
  );
  const identity = await inspectInstalledDatabase(
    database,
    directory,
    metadata.databaseSchemaVersion,
  );
  let capabilities;
  if (options.controlUrl) {
    const response = await globalThis.fetch(
      new globalThis.URL("/api/v1/capabilities", options.controlUrl),
      {
        cache: "no-store",
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok)
      throw new Error(`Capabilities failed with HTTP ${response.status}`);
    capabilities = await response.json();
    if (capabilities.buildVersion !== current.version)
      throw new Error("Running Control build does not match current pointer");
    if (
      capabilities.protocolVersion !== 1 ||
      capabilities.provider !== "node" ||
      capabilities.instanceId !== identity.instanceId ||
      capabilities.controlGatewayPairId !== identity.controlGatewayPairId ||
      capabilities.configVersion !== identity.configVersion
    )
      throw new Error(
        "Running Control identity does not match the selected database",
      );
  }
  if (options.resume === true) {
    if (!options.controlUrl || !options.adminTokenFile)
      throw new Error(
        "Resume requires Control URL and administrator token file",
      );
    await setGatewayPaused(
      options.controlUrl,
      await tokenFromFile(options.adminTokenFile),
      false,
      identity,
      beforeWrite,
    );
  }
  await beforeWrite();
  return {
    schemaVersion: 1,
    state: capabilities ? "verified" : "offline-verified",
    version: current.version,
    databaseSchemaVersion: identity.schemaVersion,
    runtimeVerified: Boolean(capabilities),
    runningBuildVersion: capabilities?.buildVersion,
    gatewayResumed: options.resume === true,
    identity,
  };
}

export async function rollbackNodeDeployment(options) {
  return withNodeDeploymentLock(options.root, "rollback", (lock) =>
    rollbackNodeDeploymentLocked({ ...options, root: lock.root }, lock),
  );
}

async function rollbackNodeDeploymentLocked(options, lock) {
  const root = safeDeploymentRoot(options.root);
  const snapshot = await pointerSnapshot(root);
  const beforeWrite = async () => {
    await lock.assertOwned();
    await assertPointerUnchanged(root, snapshot);
  };
  const current = await readCurrent(root);
  if (!current || current.version !== options.expectedVersion)
    throw new Error("Rollback expected version does not match current pointer");
  if (!current.previousVersion)
    throw new Error("No previous version is recorded");
  if (!/^[a-f0-9]{64}$/u.test(current.previousArchiveSha256 ?? ""))
    throw new Error("Previous archive digest is not recorded");
  if (!options.controlUrl || !options.adminTokenFile)
    throw new Error("Rollback requires paused Control verification");
  const verified = await verifyNodeDeploymentUnlocked({
    ...options,
    resume: false,
  });
  const previousDirectory = join(root, "versions", current.previousVersion);
  const previous = await readJson(
    join(previousDirectory, "BUILD-METADATA.json"),
  );
  if (
    previous.schemaVersion !== 1 ||
    previous.version !== current.previousVersion ||
    previous.entrypoint !== "dist/cli.js"
  )
    throw new Error(
      "Previous build metadata does not match the rollback pointer",
    );
  const database = resolve(
    options.database ?? join(root, "data", "one-fetch.sqlite"),
  );
  if (verified.databaseSchemaVersion !== previous.databaseSchemaVersion) {
    throw new Error(
      "Previous code cannot use the migrated database; restore an isolated backup explicitly",
    );
  }
  await inspectInstalledDatabase(
    database,
    previousDirectory,
    previous.databaseSchemaVersion,
  );
  const token = await tokenFromFile(options.adminTokenFile);
  await setGatewayPaused(
    options.controlUrl,
    token,
    true,
    verified.identity,
    beforeWrite,
  );
  await beforeWrite();
  await writeJsonAtomic(join(root, "current.json"), {
    schemaVersion: 1,
    version: current.previousVersion,
    directory: `versions/${current.previousVersion}`,
    archiveSha256: current.previousArchiveSha256,
    activatedAt: new Date().toISOString(),
    previousVersion: current.version,
    previousArchiveSha256: current.archiveSha256,
  });
  return {
    schemaVersion: 1,
    state: "restart-required",
    version: current.previousVersion,
    databaseRestored: false,
    gatewayPaused: true,
  };
}
