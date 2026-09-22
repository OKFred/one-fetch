import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const CATALOG_QUERY =
  "select nspname from pg_catalog.pg_namespace where nspname in ('one_fetch', 'supabase_migrations') order by nspname";

export async function inspectEmptyBaseline({
  runPnpm,
  databaseLink,
  projectRef,
}) {
  if (!/^[a-z0-9]{20}$/u.test(projectRef))
    throw new Error("Empty baseline requires an explicit project identity");
  const source = await runPnpm(
    [
      "exec",
      "supabase",
      "db",
      "query",
      "--linked",
      "--workdir",
      databaseLink.workdir,
      "--project-ref",
      projectRef,
      "--output",
      "json",
      CATALOG_QUERY,
    ],
    { capture: true, label: "inspect first-install schema catalog" },
  );
  const result = JSON.parse(source);
  if (
    !Array.isArray(result?.rows) ||
    result.rows.some(
      (row) =>
        !row ||
        Object.keys(row).length !== 1 ||
        !["one_fetch", "supabase_migrations"].includes(row.nspname),
    )
  )
    throw new Error("Invalid first-install schema inventory");
  const schemas = result.rows.map((row) => row.nspname);
  if (new Set(schemas).size !== schemas.length)
    throw new Error("Duplicate first-install schema inventory");
  return schemas.length === 0
    ? {
        projectRef,
        checkedAt: new Date().toISOString(),
        schemas,
        querySha256: createHash("sha256").update(CATALOG_QUERY).digest("hex"),
      }
    : undefined;
}

export async function writeEmptyBaselinePart(path, kind) {
  const source = `-- one-fetch verified empty first-install ${kind} baseline\n-- No application or migration schema existed at the catalog check.\n-- This is not a backup of other Supabase schemas.\n`;
  await writeFile(path, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return {
    path,
    source,
    bytes: Buffer.byteLength(source),
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}
