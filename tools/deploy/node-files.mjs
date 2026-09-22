import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, relative, resolve } from "node:path";
import process from "node:process";
const VERSION_PATTERN = /^0\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u;

export function safeDeploymentRoot(value) {
  const root = resolve(value);
  if (root === parse(root).root || root === resolve(homedir())) {
    throw new Error("Deployment root must be a dedicated subdirectory");
  }
  return root;
}

export async function exists(path) {
  return Boolean(await stat(path).catch(() => undefined));
}

export async function digestFile(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// Single-host cooperative lock, not an expiring distributed lease. An orphan
// stays fail-closed until an operator has stopped all helpers and recovers it.
export async function withNodeDeploymentLock(rootValue, operation, work) {
  if (!["apply", "resume", "rollback"].includes(operation))
    throw new Error("Invalid deployment lock operation");
  const requestedRoot = safeDeploymentRoot(rootValue);
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const root = safeDeploymentRoot(await realpath(requestedRoot));
  const path = join(root, ".deployment-lock.json");
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch {
    throw new Error(
      "Deployment is locked or its lock cannot be created; inspect it without deleting an active lock",
    );
  }
  const owner = randomUUID();
  const lock = {
    schemaVersion: 1,
    owner,
    operation,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  let initialized = false;
  const assertOwned = async () => {
    const current = await readJson(path).catch(() => undefined);
    if (current?.schemaVersion !== 1 || current.owner !== owner)
      throw new Error(
        "Deployment lock ownership was lost; stop and inspect state",
      );
  };
  try {
    await handle.writeFile(JSON.stringify(lock) + "\n");
    await handle.sync();
    initialized = true;
    return await work({ root, assertOwned });
  } finally {
    await handle.close();
    // Incomplete initialization or changed ownership is never auto-repaired.
    if (initialized) {
      await assertOwned();
      await unlink(path);
    }
  }
}

export async function pointerSnapshot(root) {
  try {
    return await readFile(join(root, "current.json"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function assertPointerUnchanged(root, snapshot) {
  if ((await pointerSnapshot(root)) !== snapshot)
    throw new Error("Active deployment pointer changed during the operation");
}

export async function readCurrent(root) {
  const path = join(root, "current.json");
  if (!(await exists(path))) return undefined;
  const value = await readJson(path);
  if (
    value?.schemaVersion !== 1 ||
    !VERSION_PATTERN.test(value.version) ||
    typeof value.directory !== "string" ||
    value.directory !== `versions/${value.version}` ||
    (value.previousVersion !== undefined &&
      !VERSION_PATTERN.test(value.previousVersion)) ||
    !/^[a-f0-9]{64}$/u.test(value.archiveSha256)
  ) {
    throw new Error("Current deployment pointer is invalid");
  }
  return value;
}

export function resolveCurrentDirectory(root, current) {
  const directory = resolve(root, current.directory);
  const relation = relative(root, directory);
  if (relation.startsWith("..") || parse(directory).root === directory)
    throw new Error("Active Node deployment escapes its root");
  return directory;
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
}
