import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export const repositoryRoot = resolve(scriptDirectory, "../..");
export const defaultOutputRoot = join(repositoryRoot, "artifacts", "release");

export function assertInsideRepository(path) {
  const resolved = resolve(path);
  const prefix = `${repositoryRoot}${sep}`.toLowerCase();
  if (!resolved.toLowerCase().startsWith(prefix)) {
    throw new Error(`Refusing path outside repository: ${resolved}`);
  }
  return resolved;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: false,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${result.stdout ?? ""}${result.stderr ?? ""}`
      : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail}`);
  }
  return options.capture ? String(result.stdout).trim() : "";
}

export function git(...args) {
  return run("git", args, { capture: true });
}

export function corepackPnpm(args, options = {}) {
  const bundledPnpm = join(
    dirname(process.execPath),
    "node_modules",
    "corepack",
    "dist",
    "pnpm.js",
  );
  if (existsSync(bundledPnpm)) {
    return run(process.execPath, [bundledPnpm, ...args], options);
  }
  return run("pnpm", args, options);
}

export function parseArguments(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const [key, inline] = item.slice(2).split("=", 2);
    if (inline !== undefined) parsed.set(key, inline);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      parsed.set(key, argv[index + 1]);
      index += 1;
    } else parsed.set(key, true);
  }
  return parsed;
}

export function requireVersion(value) {
  if (
    typeof value !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)
  ) {
    throw new Error(`Invalid release version: ${String(value)}`);
  }
  return value;
}

export function releaseDirectory(version, outputRoot = defaultOutputRoot) {
  return assertInsideRepository(
    join(resolve(outputRoot), requireVersion(version)),
  );
}

export async function resetDirectory(path) {
  const safePath = assertInsideRepository(path);
  await rm(safePath, { recursive: true, force: true });
  await mkdir(safePath, { recursive: true });
}

export async function copyDirectory(source, destination) {
  await cp(source, destination, { recursive: true, force: true });
}

export async function listFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  if ((await stat(root).catch(() => undefined))?.isDirectory())
    await visit(root);
  return result.sort((left, right) => left.localeCompare(right));
}

export async function digestFile(path, algorithm) {
  return createHash(algorithm)
    .update(await readFile(path))
    .digest("hex");
}

export function releaseAssetUrl(repository, version, filename) {
  return `https://github.com/${repository}/releases/download/v${version}/${filename}`;
}

export function packageRequire(packageDirectory) {
  return createRequire(pathToFileURL(join(packageDirectory, "package.json")));
}

export function relativePosix(from, to) {
  return relative(from, to).split(sep).join("/");
}

export function archiveFilename(packageName, version) {
  return `${packageName.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
}

export async function makeTemporaryDirectory(prefix) {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), prefix));
}

export { basename, join, readFile, rm, writeFile };
