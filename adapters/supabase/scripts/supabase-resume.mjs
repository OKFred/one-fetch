import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const filePattern = /^(\d{12})_[a-z0-9_]+\.sql$/u;
const checksumPattern = /-- one-fetch-self-checksum-v1: ([0-9a-f]{64})/gu;

export async function expectedMigrationIntegrity(adapterRoot) {
  const root = join(adapterRoot, "supabase", "migrations");
  const files = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && filePattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const expected = [];
  for (const file of files) {
    const version = filePattern.exec(file)?.[1];
    const source = await readFile(join(root, file), "utf8");
    const checksums = [...source.matchAll(checksumPattern)];
    if (!version || checksums.length !== 1 || !checksums[0]?.[1]) {
      throw new Error(`Cannot establish migration integrity from ${file}`);
    }
    expected.push({ version, checksum: checksums[0][1] });
  }
  if (expected.length === 0)
    throw new Error("Cannot resume without a migration integrity baseline");
  return expected;
}

export async function assertResumeMigrationIntegrity({ adapterRoot, rpc }) {
  const [expected, actual] = await Promise.all([
    expectedMigrationIntegrity(adapterRoot),
    rpc("of_get_migration_integrity", {}),
  ]);
  const matches =
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((entry, index) => {
      const wanted = expected[index];
      return (
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.keys(entry).sort().join(",") === "checksum,version" &&
        entry.version === wanted?.version &&
        entry.checksum === wanted?.checksum
      );
    });
  if (!matches) {
    throw new Error(
      "Failed first-install resume requires the exact one-fetch migration ledger",
    );
  }
  return expected;
}
