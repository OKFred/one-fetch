import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  inspectEmptyBaseline,
  writeEmptyBaselinePart,
} from "./supabase-empty-baseline.mjs";
import { captureRpcBackup } from "./supabase-rpc-backup.mjs";
import {
  backupDigest,
  backupManifest,
  verifyBackupIntegrity,
} from "./backup-integrity.mjs";

const BACKUP_SCHEMAS = "one_fetch,supabase_migrations";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function dumpPart({
  runPnpm,
  databaseLink,
  databasePassword,
  path,
  dataOnly,
}) {
  const arguments_ = [
    "exec",
    "supabase",
    "db",
    "dump",
    "--workdir",
    databaseLink.workdir,
    "--linked",
    "--schema",
    BACKUP_SCHEMAS,
    "--file",
    path,
    "--yes",
  ];
  if (dataOnly) arguments_.splice(-3, 0, "--data-only", "--use-copy");
  await runPnpm(arguments_, {
    label: `Supabase logical ${dataOnly ? "data" : "schema"} backup`,
    environment: { SUPABASE_DB_PASSWORD: databasePassword },
  });
  const bytes = await readFile(path);
  if (bytes.length === 0)
    throw new Error(
      `Supabase logical ${dataOnly ? "data" : "schema"} backup is empty`,
    );
  return {
    path,
    bytes: bytes.length,
    sha256: sha256(bytes),
    source: bytes.toString("utf8"),
  };
}

export function assertFirstInstallBackupIsEmpty(source) {
  if (
    /create\s+schema\s+(?:if\s+not\s+exists\s+)?"?one_fetch"?|one_fetch\./iu.test(
      source,
    )
  ) {
    throw new Error(
      "First install requires an empty one-fetch database schema",
    );
  }
}

export async function createLogicalBackup({
  runPnpm,
  databaseLink,
  recorder,
  databasePassword,
  allowEmptyBaseline = false,
  projectRef,
  expectedCurrentBuild = "none",
}) {
  const prefix = join(
    dirname(recorder.path),
    `database-before-${recorder.state.runId}`,
  );
  const emptyBaseline = allowEmptyBaseline
    ? await inspectEmptyBaseline({ runPnpm, databaseLink, projectRef })
    : undefined;
  // Missing application schemas do not prove that no public RPC remains.
  const rpc = await captureRpcBackup({
    runPnpm,
    databaseLink,
    projectRef,
    path: `${prefix}.rpc.sql`,
    expectedCurrentBuild,
    allowEmpty: allowEmptyBaseline,
  });
  if (allowEmptyBaseline && rpc.count !== 0)
    throw new Error(
      "First install requires an empty one-fetch public RPC inventory",
    );
  const schema = emptyBaseline
    ? await writeEmptyBaselinePart(`${prefix}.schema.sql`, "schema")
    : await dumpPart({
        runPnpm,
        databaseLink,
        databasePassword,
        path: `${prefix}.schema.sql`,
        dataOnly: false,
      });
  const data = emptyBaseline
    ? await writeEmptyBaselinePart(`${prefix}.data.sql`, "data")
    : await dumpPart({
        runPnpm,
        databaseLink,
        databasePassword,
        path: `${prefix}.data.sql`,
        dataOnly: true,
      });
  const manifest = backupManifest({
    format: "supabase-logical-v2",
    schemas: BACKUP_SCHEMAS.split(","),
    schema: { bytes: schema.bytes, sha256: schema.sha256 },
    data: { bytes: data.bytes, sha256: data.sha256 },
    rpc: { bytes: rpc.bytes, sha256: rpc.sha256, count: rpc.count },
    ...(emptyBaseline ? { emptyBaseline } : {}),
  });
  const backup = {
    ...manifest,
    schema,
    data,
    rpc,
    sha256: backupDigest(manifest),
  };
  await verifyBackupIntegrity(backup, recorder.path);
  return backup;
}
