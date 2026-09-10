import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
}) {
  const prefix = join(
    dirname(recorder.path),
    `database-before-${recorder.state.runId}`,
  );
  const schema = await dumpPart({
    runPnpm,
    databaseLink,
    databasePassword,
    path: `${prefix}.schema.sql`,
    dataOnly: false,
  });
  const data = await dumpPart({
    runPnpm,
    databaseLink,
    databasePassword,
    path: `${prefix}.data.sql`,
    dataOnly: true,
  });
  const manifest = {
    format: "supabase-logical-v1",
    schemas: BACKUP_SCHEMAS.split(","),
    schema: { bytes: schema.bytes, sha256: schema.sha256 },
    data: { bytes: data.bytes, sha256: data.sha256 },
  };
  return {
    ...manifest,
    schema,
    data,
    sha256: sha256(JSON.stringify(manifest)),
  };
}
