import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const migrationPath = "adapters/supabase/supabase/migrations";
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
export const RPC_CATALOG_QUERY = `select
  p.proname as name,
  pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
  pg_catalog.pg_get_functiondef(p.oid) as definition,
  pg_catalog.pg_get_userbyid(p.proowner) as owner,
  p.prosecdef as security_definer,
  coalesce((select jsonb_agg(jsonb_build_object(
    'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end,
    'privilege', a.privilege_type, 'grantable', a.is_grantable
  ) order by a.grantee, a.privilege_type)
  from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a), '[]'::jsonb) as grants
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname ~ '^of_' and p.prokind = 'f'
order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)`;

const FunctionSchema = z
  .object({
    name: z.string().regex(/^of_[a-z0-9_]+$/u),
    arguments: z
      .string()
      .max(4096)
      .regex(/^[a-z0-9_ ,[\]]*$/u),
    definition: z
      .string()
      .min(1)
      .max(256 * 1024),
    owner: z.literal("postgres"),
    security_definer: z.literal(true),
    grants: z
      .array(
        z
          .object({
            grantee: z.enum(["postgres", "service_role"]),
            privilege: z.literal("EXECUTE"),
            grantable: z.boolean(),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();

// Use the immutable SOURCE build, not the destination's possibly newer RPC set.
// Never broaden a backup to every public table/function in the project.
export async function ownedRpcNames(expectedCurrentBuild) {
  let sources;
  if (expectedCurrentBuild && expectedCurrentBuild !== "none") {
    const match = /\.g([a-f0-9]{12,40})$/u.exec(expectedCurrentBuild);
    if (!match) throw new Error("Invalid RPC backup source build");
    const commit = execFileSync(
      "git",
      ["rev-parse", "--verify", `${match[1]}^{commit}`],
      { cwd: repositoryRoot, encoding: "utf8" },
    ).trim();
    const files = execFileSync(
      "git",
      ["ls-tree", "--name-only", commit, `${migrationPath}/`],
      { cwd: repositoryRoot, encoding: "utf8" },
    )
      .trim()
      .split(/\r?\n/u);
    sources = files
      .filter((name) =>
        /^adapters\/supabase\/supabase\/migrations\/\d{12}_[a-z0-9_]+\.sql$/u.test(
          name,
        ),
      )
      .sort()
      .map((name) =>
        execFileSync("git", ["show", `${commit}:${name}`], {
          cwd: repositoryRoot,
          encoding: "utf8",
        }),
      );
  } else {
    const directory = resolve(repositoryRoot, migrationPath);
    const files = (await readdir(directory)).filter((name) =>
      /^\d{12}_[a-z0-9_]+\.sql$/u.test(name),
    );
    files.sort();
    sources = await Promise.all(
      files.map((name) => readFile(resolve(directory, name), "utf8")),
    );
  }
  const names = new Set();
  for (const source of sources) {
    // The checked-in migration contract uses one signature per public RPC name.
    // Process retirement in migration order instead of exporting retired APIs.
    for (const match of source.matchAll(
      /(create(?:\s+or\s+replace)?|drop)\s+function\s+public\.(of_[a-z0-9_]+)\s*\(/giu,
    )) {
      if (match[1].toLowerCase() === "drop") names.delete(match[2]);
      else names.add(match[2]);
    }
  }
  if (names.size === 0)
    throw new Error("Immutable RPC source inventory is empty");
  return [...names].sort();
}

export function serializeRpcCatalog(source, expectedNames, allowEmpty = false) {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source) > MAX_CATALOG_BYTES
  )
    throw new Error("RPC backup catalog exceeds its size limit");
  let rows;
  try {
    rows = z
      .object({ rows: z.array(FunctionSchema).max(256) })
      .parse(JSON.parse(source)).rows;
  } catch {
    // Do not echo database definitions or unexpected ACL values in diagnostics.
    throw new Error("Invalid RPC backup catalog or unsafe privileges");
  }
  if (rows.length === 0 && allowEmpty)
    return {
      source:
        "-- No owned public RPC existed before first installation.\n-- This is not a backup of other Supabase schemas.\n",
      count: 0,
    };
  const names = [...new Set(rows.map((row) => row.name))].sort();
  if (names.length !== rows.length)
    throw new Error(
      "RPC overloads require an explicit backup inventory upgrade",
    );
  if (
    JSON.stringify(names) !== JSON.stringify([...new Set(expectedNames)].sort())
  )
    throw new Error(
      "RPC backup inventory does not match the immutable source build",
    );
  const signatures = new Set();
  const statements = [
    "-- one-fetch owned public RPC backup; restore after schema, before data.",
    "BEGIN;",
    "SET LOCAL check_function_bodies = false;",
  ];
  for (const row of rows) {
    const signature = `public.${row.name}(${row.arguments})`;
    if (signatures.has(signature))
      throw new Error("Duplicate RPC backup signature");
    signatures.add(signature);
    if (
      !row.definition.startsWith(
        `CREATE OR REPLACE FUNCTION public.${row.name}(`,
      )
    )
      throw new Error("RPC definition does not match its catalog identity");
    const ownerGrant = row.grants.find((grant) => grant.grantee === "postgres");
    const serviceGrant = row.grants.find(
      (grant) => grant.grantee === "service_role",
    );
    if (
      row.grants.length !== 2 ||
      !ownerGrant ||
      ownerGrant.grantable ||
      !serviceGrant ||
      serviceGrant.grantable
    )
      throw new Error(
        "RPC backup privileges do not match the service-role boundary",
      );
    statements.push(
      row.definition.trimEnd().replace(/;?$/u, ";"),
      `ALTER FUNCTION ${signature} OWNER TO postgres;`,
      `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated, service_role;`,
      `GRANT EXECUTE ON FUNCTION ${signature} TO service_role;`,
    );
  }
  statements.push("COMMIT;", "");
  return { source: statements.join("\n"), count: rows.length };
}

export async function captureRpcBackup({
  runPnpm,
  databaseLink,
  projectRef,
  path,
  expectedCurrentBuild,
  allowEmpty = false,
}) {
  if (!/^[a-z0-9]{20}$/u.test(projectRef))
    throw new Error("Explicit RPC backup project identity required");
  // Windows npm command shims can truncate a multiline SQL argument to SELECT.
  // Keep the exact query in a private, exclusive file instead of shell argv.
  const queryPath = `${path}.query.sql`;
  await writeFile(queryPath, RPC_CATALOG_QUERY, { flag: "wx", mode: 0o600 });
  let catalog;
  try {
    catalog = await runPnpm(
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
        "--file",
        queryPath,
      ],
      { capture: true, label: "capture owned public RPC catalog" },
    );
  } finally {
    await unlink(queryPath);
  }
  const result = serializeRpcCatalog(
    catalog,
    await ownedRpcNames(expectedCurrentBuild),
    allowEmpty,
  );
  const bytes = Buffer.from(result.source);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return {
    ...result,
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
