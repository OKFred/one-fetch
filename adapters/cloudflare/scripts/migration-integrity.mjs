import console from "node:console";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

const adapterRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultMigrationsDirectory = join(adapterRoot, "migrations");
const defaultManifestPath = join(adapterRoot, "migration-manifest.json");
const defaultRuntimeManifestPath = join(
  adapterRoot,
  "src/generated/migration-manifest.ts",
);
const ZERO_CHECKSUM = "0".repeat(64);
const SELF_CHECKSUM_ALGORITHM = "self-zeroed-sha256-v1";
const migrationNamePattern =
  /^(?<sequence>\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u;
const markerPattern =
  /^-- one-fetch-self-checksum-v1: (?<checksum>[0-9a-f]{64})\r?$/gmu;
const ledgerInsertPattern =
  /INSERT INTO one_fetch_migrations \(sequence, file, checksum_algorithm, checksum\)\r?\nVALUES \((?<sequence>\d+), '(?<file>[^']+)', '(?<algorithm>sha256|self-zeroed-sha256-v1)', '(?<checksum>[0-9a-f]{64})'\);/gu;
const regenerateCommand =
  "pnpm --filter @one-fetch/adapter-cloudflare migrations:generate";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function displayPath(path) {
  const localPath = relative(adapterRoot, path);
  return localPath === "" || localPath.startsWith("..") ? path : localPath;
}

function capturedRange(match, groupName) {
  const value = match.groups?.[groupName];
  if (typeof value !== "string") throw new Error("Invalid checksum capture");
  const offset = match[0].lastIndexOf(value);
  return {
    start: match.index + offset,
    end: match.index + offset + value.length,
  };
}

function replaceRanges(text, ranges, replacement) {
  return [...ranges]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, range) =>
        `${result.slice(0, range.start)}${replacement}${result.slice(range.end)}`,
      text,
    );
}

async function readSources(migrationsDirectory) {
  const directoryEntries = (
    await readdir(migrationsDirectory, { withFileTypes: true })
  )
    .filter((entry) => entry.name.toLowerCase().endsWith(".sql"))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (directoryEntries.length === 0) {
    throw new Error(
      `No Cloudflare D1 migrations found in ${displayPath(migrationsDirectory)}`,
    );
  }

  const sources = [];
  for (const [index, directoryEntry] of directoryEntries.entries()) {
    if (!directoryEntry.isFile() || directoryEntry.isSymbolicLink()) {
      throw new Error(
        `Migration must be a regular file: ${directoryEntry.name}`,
      );
    }
    const name = migrationNamePattern.exec(directoryEntry.name);
    if (!name?.groups) {
      throw new Error(
        `Invalid migration name "${directoryEntry.name}"; expected NNNN_lowercase_name.sql`,
      );
    }
    const sequence = Number(name.groups.sequence);
    if (sequence !== index + 1) {
      throw new Error(
        `Migration sequence is not contiguous: expected ${String(index + 1).padStart(4, "0")}, found ${name.groups.sequence}`,
      );
    }

    const path = join(migrationsDirectory, directoryEntry.name);
    const beforeRead = await lstat(path);
    const bytes = await readFile(path);
    const afterRead = await lstat(path);
    if (
      !beforeRead.isFile() ||
      beforeRead.isSymbolicLink() ||
      beforeRead.size !== afterRead.size ||
      beforeRead.mtimeMs !== afterRead.mtimeMs
    ) {
      throw new Error(
        `Migration changed while being read: ${directoryEntry.name}`,
      );
    }
    if (
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf
    ) {
      throw new Error(
        `Migration must not contain a UTF-8 BOM: ${directoryEntry.name}`,
      );
    }
    let text;
    try {
      text = utf8Decoder.decode(bytes);
    } catch (error) {
      throw new Error(`Migration is not valid UTF-8: ${directoryEntry.name}`, {
        cause: error,
      });
    }
    const markers = [...text.matchAll(markerPattern)];
    if (markers.length > 1) {
      throw new Error(
        `Migration has multiple checksum markers: ${directoryEntry.name}`,
      );
    }
    sources.push({
      sequence,
      file: directoryEntry.name,
      path,
      text,
      bytes: bytes.byteLength,
      artifactSha256: sha256(bytes),
      marker: markers[0],
    });
  }
  return sources;
}

function buildLedgerRows(sources) {
  const rows = [];
  for (const source of sources) {
    const matches = [...source.text.matchAll(ledgerInsertPattern)];
    const insertCount =
      source.text.split("INSERT INTO one_fetch_migrations").length - 1;
    if (matches.length !== insertCount) {
      throw new Error(
        `Migration has a non-canonical ledger INSERT: ${source.file}`,
      );
    }
    for (const match of matches) {
      rows.push({
        sequence: Number(match.groups.sequence),
        file: match.groups.file,
        algorithm: match.groups.algorithm,
        checksum: match.groups.checksum,
        range: capturedRange(match, "checksum"),
        source,
      });
    }
  }
  return rows;
}

function buildEntries(sources, { allowUnfinalized = false } = {}) {
  const bootstrapSources = sources.filter((source) =>
    /CREATE TABLE one_fetch_migrations\s*\(/u.test(source.text),
  );
  if (bootstrapSources.length !== 1) {
    throw new Error("Exactly one migration must create one_fetch_migrations");
  }
  const bootstrap = bootstrapSources[0];
  const rows = buildLedgerRows(sources);
  const rowsBySequence = new Map();
  for (const row of rows) {
    if (rowsBySequence.has(row.sequence)) {
      throw new Error(`Duplicate migration ledger sequence: ${row.sequence}`);
    }
    rowsBySequence.set(row.sequence, row);
  }
  if (rows.length !== sources.length) {
    throw new Error(
      "Migration ledger must contain exactly one row per migration",
    );
  }

  return sources.map((source) => {
    const row = rowsBySequence.get(source.sequence);
    if (!row || row.file !== source.file) {
      throw new Error(`Missing migration ledger row: ${source.file}`);
    }
    const selfChecksummed = source.sequence >= bootstrap.sequence;
    const expectedRowOwner = selfChecksummed
      ? source.sequence
      : bootstrap.sequence;
    if (row.source.sequence !== expectedRowOwner) {
      throw new Error(
        `Migration ledger row is in the wrong file: ${source.file}`,
      );
    }
    if (selfChecksummed !== Boolean(source.marker)) {
      throw new Error(
        `Migration checksum marker boundary is invalid: ${source.file}`,
      );
    }

    const algorithm = selfChecksummed ? SELF_CHECKSUM_ALGORITHM : "sha256";
    if (row.algorithm !== algorithm) {
      throw new Error(
        `Migration checksum algorithm is invalid: ${source.file}`,
      );
    }
    let checksum = source.artifactSha256;
    let markerChecksum;
    if (source.marker) {
      markerChecksum = source.marker.groups.checksum;
      if (markerChecksum !== row.checksum) {
        throw new Error(`Migration checksum copies differ: ${source.file}`);
      }
      const normalized = replaceRanges(
        source.text,
        [capturedRange(source.marker, "checksum"), row.range],
        ZERO_CHECKSUM,
      );
      checksum = sha256(Buffer.from(normalized, "utf8"));
    }
    if (
      row.checksum !== checksum &&
      !(allowUnfinalized && row.checksum === ZERO_CHECKSUM)
    ) {
      throw new Error(`Embedded migration checksum is stale: ${source.file}`);
    }
    return {
      sequence: source.sequence,
      file: source.file,
      bytes: source.bytes,
      checksumAlgorithm: algorithm,
      checksum,
      artifactSha256: source.artifactSha256,
      source,
      row,
      markerChecksum,
    };
  });
}

function publicManifest(entries, migrationsDirectory) {
  return {
    schemaVersion: 2,
    checksumAlgorithm: SELF_CHECKSUM_ALGORITHM,
    artifactHashAlgorithm: "sha256",
    migrationsDirectory: basename(migrationsDirectory),
    migrations: entries.map((entry) => ({
      sequence: entry.sequence,
      file: entry.file,
      bytes: entry.bytes,
      checksumAlgorithm: entry.checksumAlgorithm,
      checksum: entry.checksum,
      artifactSha256: entry.artifactSha256,
    })),
  };
}

export async function buildMigrationManifest({
  migrationsDirectory = defaultMigrationsDirectory,
  allowUnfinalized = false,
} = {}) {
  const sources = await readSources(migrationsDirectory);
  return publicManifest(
    buildEntries(sources, { allowUnfinalized }),
    migrationsDirectory,
  );
}

export function renderMigrationManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function renderRuntimeMigrationManifest(manifest) {
  const entries = manifest.migrations.map(
    ({ sequence, file, checksumAlgorithm, checksum }) => ({
      sequence,
      file,
      checksumAlgorithm,
      checksum,
    }),
  );
  return `/* Generated by scripts/migration-integrity.mjs. Do not edit. */\nexport const CLOUDFLARE_MIGRATION_CHECKSUM_ALGORITHM = ${JSON.stringify(SELF_CHECKSUM_ALGORITHM)} as const;\n\nexport const CLOUDFLARE_MIGRATIONS = ${JSON.stringify(entries, null, 2)} as const;\n`;
}

async function readJson(path) {
  try {
    const text = await readFile(path, "utf8");
    return { value: JSON.parse(text), text };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return null;
    throw error;
  }
}

function assertAppendOnly(previous, entries) {
  if (!previous) return 0;
  const rows = Array.isArray(previous.value?.migrations)
    ? previous.value.migrations
    : null;
  if (!rows) throw new Error("Existing migration manifest is invalid");
  for (const [index, row] of rows.entries()) {
    const entry = entries[index];
    if (
      !entry ||
      row.file !== entry.file ||
      row.bytes !== entry.bytes ||
      (row.artifactSha256 ?? row.sha256) !== entry.artifactSha256 ||
      (row.checksum !== undefined && row.checksum !== entry.checksum)
    ) {
      throw new Error(
        `Applied migration is immutable: ${row.file ?? index + 1}`,
      );
    }
  }
  return rows.length;
}

async function assertRegularOutput(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        `Generated output must be a regular file: ${displayPath(path)}`,
      );
    }
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT")
      throw error;
  }
}

export async function verifyMigrationManifest({
  migrationsDirectory = defaultMigrationsDirectory,
  manifestPath = defaultManifestPath,
  runtimeManifestPath = defaultRuntimeManifestPath,
} = {}) {
  const expected = await buildMigrationManifest({ migrationsDirectory });
  const actual = await readJson(manifestPath);
  if (!actual) {
    throw new Error(
      `Migration manifest is missing: ${displayPath(manifestPath)}`,
    );
  }
  if (actual.text !== renderMigrationManifest(expected)) {
    throw new Error(
      `Cloudflare migration manifest is stale. Run "${regenerateCommand}".`,
    );
  }
  let runtimeText;
  try {
    runtimeText = await readFile(runtimeManifestPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(
        `Runtime migration manifest is missing: ${displayPath(runtimeManifestPath)}`,
      );
    }
    throw error;
  }
  if (runtimeText !== renderRuntimeMigrationManifest(expected)) {
    throw new Error(
      `Runtime migration manifest is stale. Run "${regenerateCommand}".`,
    );
  }
  return expected;
}

export async function writeMigrationManifest({
  migrationsDirectory = defaultMigrationsDirectory,
  manifestPath = defaultManifestPath,
  runtimeManifestPath = defaultRuntimeManifestPath,
} = {}) {
  await assertRegularOutput(manifestPath);
  await assertRegularOutput(runtimeManifestPath);
  const previous = await readJson(manifestPath);
  const sources = await readSources(migrationsDirectory);
  const entries = buildEntries(sources, { allowUnfinalized: true });
  const immutableCount = assertAppendOnly(previous, entries);
  for (const entry of entries.slice(immutableCount)) {
    if (!entry.source.marker || entry.markerChecksum === entry.checksum)
      continue;
    const finalized = replaceRanges(
      entry.source.text,
      [capturedRange(entry.source.marker, "checksum"), entry.row.range],
      entry.checksum,
    );
    await writeFile(entry.source.path, finalized, "utf8");
  }
  const manifest = await buildMigrationManifest({ migrationsDirectory });
  await writeFile(manifestPath, renderMigrationManifest(manifest), "utf8");
  await writeFile(
    runtimeManifestPath,
    renderRuntimeMigrationManifest(manifest),
    "utf8",
  );
  return manifest;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.length === 0 ? "--check" : args[0];
  if (args.length > 1 || (mode !== "--check" && mode !== "--write")) {
    throw new Error(
      "Usage: node scripts/migration-integrity.mjs [--check|--write]",
    );
  }
  const manifest =
    mode === "--write"
      ? await writeMigrationManifest()
      : await verifyMigrationManifest();
  console.log(
    `${mode === "--write" ? "Wrote" : "Verified"} ${manifest.migrations.length} Cloudflare D1 migrations`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
