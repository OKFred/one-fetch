import { Buffer } from "node:buffer";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

const blockSize = 512;

function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portablePath(path) {
  return path.split(sep).join("/");
}

function assertSafeRelativePath(path, label) {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a safe relative POSIX path: ${path}`);
  }
  return path;
}

function isInside(root, candidate) {
  const value = relative(root, candidate);
  return (
    value === "" ||
    (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))
  );
}

function writeText(header, offset, length, value, label) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length)
    throw new Error(`${label} exceeds ${length} bytes`);
  encoded.copy(header, offset);
}

function writeOctal(header, offset, length, value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length)
    throw new Error(`${label} exceeds its tar field`);
  writeText(header, offset, length, `${encoded}\0`, label);
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  let separator = path.lastIndexOf("/");
  while (separator > 0) {
    const prefix = path.slice(0, separator);
    const name = path.slice(separator + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
    separator = path.lastIndexOf("/", separator - 1);
  }
  throw new Error(`Archive path cannot be represented by ustar: ${path}`);
}

function tarHeader(entry, mtime) {
  const header = Buffer.alloc(blockSize);
  const { name, prefix } = splitTarPath(entry.path);
  writeText(header, 0, 100, name, "tar name");
  writeOctal(header, 100, 8, entry.mode, "tar mode");
  writeOctal(header, 108, 8, 0, "tar uid");
  writeOctal(header, 116, 8, 0, "tar gid");
  writeOctal(header, 124, 12, entry.contents?.length ?? 0, "tar size");
  writeOctal(header, 136, 12, mtime, "tar mtime");
  header.fill(0x20, 148, 156);
  header[156] =
    entry.type === "file" ? 0x30 : entry.type === "directory" ? 0x35 : 0x32;
  if (entry.linkTarget)
    writeText(header, 157, 100, entry.linkTarget, "tar link target");
  writeText(header, 257, 6, "ustar\0", "tar magic");
  writeText(header, 263, 2, "00", "tar version");
  writeText(header, 265, 32, "root", "tar user");
  writeText(header, 297, 32, "root", "tar group");
  writeOctal(header, 329, 8, 0, "tar device major");
  writeOctal(header, 337, 8, 0, "tar device minor");
  if (prefix) writeText(header, 345, 155, prefix, "tar prefix");
  const checksum = header.reduce((total, value) => total + value, 0);
  writeText(
    header,
    148,
    8,
    `${checksum.toString(8).padStart(6, "0")}\0 `,
    "tar checksum",
  );
  return header;
}

async function collectEntries(sourceDirectory, rootName, executablePaths) {
  const sourceRoot = resolve(sourceDirectory);
  const entries = [{ path: rootName, type: "directory", mode: 0o755 }];

  async function visit(directory, relativeDirectory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => ordinal(left.name, right.name));
    for (const child of children) {
      const path = join(directory, child.name);
      const relativePath = portablePath(join(relativeDirectory, child.name));
      const archivePath = `${rootName}/${relativePath}`;
      const metadata = await lstat(path);
      if (metadata.isDirectory()) {
        entries.push({ path: archivePath, type: "directory", mode: 0o755 });
        await visit(path, join(relativeDirectory, child.name));
      } else if (metadata.isFile()) {
        entries.push({
          path: archivePath,
          type: "file",
          mode: executablePaths.has(relativePath) ? 0o755 : 0o644,
          contents: await readFile(path),
        });
      } else if (metadata.isSymbolicLink()) {
        const resolvedTarget = resolve(dirname(path), await readlink(path));
        if (!isInside(sourceRoot, resolvedTarget)) {
          throw new Error(
            `Archive symlink escapes its source tree: ${relativePath}`,
          );
        }
        const targetArchivePath = `${rootName}/${portablePath(relative(sourceRoot, resolvedTarget))}`;
        const fromDirectory = archivePath.slice(
          0,
          archivePath.lastIndexOf("/"),
        );
        const linkTarget = portablePath(
          relative(fromDirectory, targetArchivePath),
        );
        entries.push({
          path: archivePath,
          type: "symlink",
          mode: 0o777,
          linkTarget,
        });
      } else {
        throw new Error(`Unsupported archive entry type: ${relativePath}`);
      }
    }
  }

  await visit(sourceRoot, "");
  return entries;
}

export async function createDeterministicTarGzip({
  sourceDirectory,
  outputFile,
  rootName,
  mtime = 0,
  executablePaths = [],
}) {
  assertSafeRelativePath(rootName, "Archive root");
  if (!Number.isSafeInteger(mtime) || mtime < 0) {
    throw new Error("Archive mtime must be a non-negative integer");
  }
  const entries = await collectEntries(
    sourceDirectory,
    rootName,
    new Set(
      executablePaths.map((path) =>
        assertSafeRelativePath(path, "Executable path"),
      ),
    ),
  );
  const chunks = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry, mtime));
    if (entry.contents) {
      chunks.push(entry.contents);
      const padding =
        (blockSize - (entry.contents.length % blockSize)) % blockSize;
      if (padding > 0) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(blockSize * 2));
  const compressed = gzipSync(Buffer.concat(chunks), { level: 9 });
  compressed.writeUInt32LE(0, 4);
  compressed[9] = 0xff;
  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, compressed);
  return entries.map((entry) => entry.path);
}
