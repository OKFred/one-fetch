import { readFile } from "node:fs/promises";
import process from "node:process";
import { verifyBackupIntegrity } from "./backup-integrity.mjs";

try {
  if (process.argv.length !== 4 || process.argv[2] !== "--state-file")
    throw new Error(
      "Use --state-file <deployment-state.json>; verification never restores a database",
    );
  const state = JSON.parse(await readFile(process.argv[3], "utf8"));
  const result = await verifyBackupIntegrity(state.backup, process.argv[3]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  // Do not echo untrusted state contents, SQL or credential-bearing paths.
  process.stderr.write(
    "Backup integrity verification failed; check v2 manifest, part paths, sizes and digests. No SQL was executed.\n",
  );
  process.exitCode = 1;
}
