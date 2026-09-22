// Real PostgreSQL restore regression. Never connects to a hosted or user DB.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { createLogicalBackup } from "./supabase-backup.mjs";
import { verifyBackupIntegrity } from "./backup-integrity.mjs";
import { RPC_CATALOG_QUERY } from "./supabase-rpc-backup.mjs";

const image =
  "public.ecr.aws/supabase/postgres@sha256:b3bfedb107413abb3b8cb0d0874b0414a1dceb3d55bc0c778de6ad22d1f7dc86";
const adapter = resolve(import.meta.dirname, "..");
const runId = randomUUID();
const name = `one-fetch-rpc-restore-${runId}`;
const root = await mkdtemp(join(tmpdir(), "one-fetch-rpc-restore-"));
const report = {
  schemaVersion: 1,
  kind: "supabase-local-backup-restore",
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: adapter,
    encoding: "utf8",
  }).trim(),
  image,
  runId,
  startedAt: new Date().toISOString(),
  checks: {},
  cleanup: false,
};
let container;
let phase = "options";
let reportPath;

function docker(args, input) {
  // Do not print SQL, psql errors, row contents, or Docker environment values.
  try {
    return execFileSync("docker", args, {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    }).trim();
  } catch {
    throw new Error(`Isolated restore command failed during ${phase}`);
  }
}
function sql(database, source) {
  return docker(
    [
      "exec",
      "-i",
      container,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "postgres",
      "-d",
      database,
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "-",
    ],
    source,
  );
}
function catalog(database) {
  return sql(
    database,
    `SELECT coalesce(json_agg(c), '[]') FROM (${RPC_CATALOG_QUERY}) c;`,
  );
}
function assertOwnedContainer() {
  const value = JSON.parse(docker(["inspect", container]))[0];
  assert.equal(value.Id, container);
  assert.equal(value.Name, `/${name}`);
  assert.equal(value.Config.Labels["one-fetch.restore-run"], runId);
  assert.equal(value.HostConfig.NetworkMode, "none");
  assert.equal(Object.keys(value.HostConfig.PortBindings ?? {}).length, 0);
}
async function snapshot(database) {
  const tables = sql(
    database,
    "SELECT tablename FROM pg_tables WHERE schemaname='one_fetch' ORDER BY tablename;",
  ).split("\n");
  const result = {};
  for (const table of tables) {
    assert.match(table, /^[a-z_]+$/u);
    result[table] = JSON.parse(
      sql(
        database,
        `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM one_fetch.${table} t;`,
      ),
    );
  }
  return result;
}

try {
  if (process.argv.length !== 2) {
    assert.equal(process.argv.length, 4);
    assert.equal(process.argv[2], "--report");
    reportPath = resolve(process.argv[3]);
  }
  phase = "container";
  try {
    docker(["image", "inspect", image]);
  } catch {
    docker(["pull", image]);
  }
  container = docker([
    "create",
    "--name",
    name,
    "--network",
    "none",
    "--label",
    `one-fetch.restore-run=${runId}`,
    "--tmpfs",
    "/var/lib/postgresql/data",
    "--env",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    image,
  ]);
  assert.match(container, /^[a-f0-9]{64}$/u);
  assertOwnedContainer();
  docker(["start", container]);
  phase = "postgres-ready";
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      sql("postgres", "SELECT 1;");
      ready = true;
      break;
    } catch {
      await setTimeout(500);
    }
  }
  assert.ok(ready);
  report.postgres = sql("postgres", "SHOW server_version;");
  phase = "migrate-source";
  sql(
    "postgres",
    "CREATE DATABASE rpc_source; CREATE DATABASE rpc_legacy; CREATE DATABASE rpc_restored;",
  );
  for (const database of ["rpc_source", "rpc_legacy", "rpc_restored"])
    sql(
      database,
      "CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;",
    );
  sql(
    "rpc_source",
    "CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);",
  );
  const migrations = (await readdir(join(adapter, "supabase/migrations")))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrations) {
    assert.match(file, /^\d{12}_[a-z0-9_]+\.sql$/u);
    sql(
      "rpc_source",
      await readFile(join(adapter, "supabase/migrations", file), "utf8"),
    );
    sql(
      "rpc_source",
      `INSERT INTO supabase_migrations.schema_migrations VALUES ('${file.slice(0, 12)}');`,
    );
  }
  // Synthetic persisted account/session plus an unrelated public object canary.
  sql(
    "rpc_source",
    `
    INSERT INTO one_fetch.admins(id,username,password_hash) VALUES
      ('90000000-0000-4000-8000-000000000001','restore-synthetic','synthetic-hash');
    INSERT INTO one_fetch.sessions(id,admin_id,family_id,access_token_hash,refresh_token_hash,access_expires_at,refresh_expires_at)
      VALUES ('90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000001',
      '90000000-0000-4000-8000-000000000003',repeat('9',64),repeat('8',64),now()+interval '1 hour',now()+interval '1 day');
    CREATE TABLE public.unrelated_canary(value text); INSERT INTO public.unrelated_canary VALUES ('not-in-backup');
  `,
  );
  phase = "backup";
  const sourceCatalog = JSON.parse(catalog("rpc_source"));
  const sourceRows = await snapshot("rpc_source");
  const statePath = join(root, "state.json");
  const backup = await createLogicalBackup({
    recorder: { path: statePath, state: { runId } },
    databaseLink: { workdir: root },
    projectRef: "abcdefghijklmnopqrst",
    expectedCurrentBuild: `0.1.0+supabase.g${report.commit}`,
    runPnpm: async (args) => {
      if (args.includes("query")) {
        assert.ok(args.includes("--file"));
        assert.equal(
          await readFile(args[args.indexOf("--file") + 1], "utf8"),
          RPC_CATALOG_QUERY,
        );
        return JSON.stringify({ rows: JSON.parse(catalog("rpc_source")) });
      }
      assert.ok(args.includes("dump"));
      assert.equal(
        args[args.indexOf("--schema") + 1],
        "one_fetch,supabase_migrations",
      );
      const dump = docker([
        "exec",
        container,
        "pg_dump",
        "-U",
        "postgres",
        "-d",
        "rpc_source",
        args.includes("--data-only") ? "--data-only" : "--schema-only",
        "--schema=one_fetch",
        "--schema=supabase_migrations",
      ]);
      await writeFile(args[args.indexOf("--file") + 1], `${dump}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    },
  });
  report.checks.integrity = await verifyBackupIntegrity(backup, statePath);
  phase = "restore";
  sql("rpc_legacy", backup.schema.source);
  sql("rpc_legacy", backup.data.source);
  assert.equal(JSON.parse(catalog("rpc_legacy")).length, 0);
  report.checks.legacyPairHasNoPublicRpc = true;
  for (const kind of ["schema", "rpc", "data"])
    sql("rpc_restored", backup[kind].source);
  assert.deepEqual(JSON.parse(catalog("rpc_restored")), sourceCatalog);
  assert.deepEqual(await snapshot("rpc_restored"), sourceRows);
  assert.equal(
    Number(
      sql(
        "rpc_restored",
        "SELECT count(*) FROM supabase_migrations.schema_migrations;",
      ),
    ),
    migrations.length,
  );
  assert.equal(
    sql(
      "rpc_restored",
      "SELECT to_regclass('public.unrelated_canary') IS NULL;",
    ),
    "t",
  );
  report.checks.restoredRpcCount = sourceCatalog.length;
  report.checks.restoredTables = Object.keys(sourceRows).length;
  report.checks.catalogAndRowsIdentical = true;
  report.checks.providerMigrationRows = migrations.length;
  report.checks.unrelatedPublicObjectsExcluded = true;
  phase = "restored-account";
  const login = JSON.parse(
    sql(
      "rpc_restored",
      "SET ROLE service_role; SELECT public.of_get_admin_for_login('restore-synthetic');",
    ),
  );
  assert.equal(login.passwordHash, "synthetic-hash");
  const access = JSON.parse(
    sql(
      "rpc_restored",
      "SET ROLE service_role; SELECT public.of_authenticate_access(repeat('9',64));",
    ),
  );
  assert.equal(access.adminId, login.adminId);
  report.checks.persistedAccountAndSession = true;
  for (const role of ["anon", "authenticated"]) {
    assert.equal(
      sql(
        "rpc_restored",
        `SELECT has_function_privilege('${role}','public.of_get_admin_for_login(text)','EXECUTE');`,
      ),
      "f",
    );
    assert.throws(() =>
      sql(
        "rpc_restored",
        `SET ROLE ${role}; SELECT public.of_get_admin_for_login('restore-synthetic');`,
      ),
    );
  }
  report.checks.publicRolesDenied = true;
  // Clear only this synthetic account (cascades its one session) for the existing
  // transaction-rolled-back SQL suite, which expects an unbootstrapped database.
  sql(
    "rpc_restored",
    "DELETE FROM one_fetch.admins WHERE id='90000000-0000-4000-8000-000000000001';",
  );
  phase = "restored-pgtap";
  const suites = (await readdir(join(adapter, "supabase/tests")))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  let assertions = 0;
  for (const file of suites) {
    const output = sql(
      "rpc_restored",
      await readFile(join(adapter, "supabase/tests", file), "utf8"),
    );
    assert.doesNotMatch(output, /(?:^|\n)(?:not ok|Bail out!|# Looks like)/u);
    const planned = Number(/^1\.\.(\d+)$/mu.exec(output)?.[1]);
    const passed = [...output.matchAll(/^ok \d+\b/gmu)].length;
    assert.ok(planned > 0);
    assert.equal(passed, planned);
    assertions += passed;
  }
  report.checks.restoredSqlSuites = suites.length;
  report.checks.restoredSqlAssertions = assertions;
  report.result = "passed";
} catch {
  report.result = "failed";
  report.failurePhase = phase;
  process.exitCode = 1;
} finally {
  try {
    if (container) {
      assertOwnedContainer();
      docker(["rm", "--force", container]);
      const remaining = docker([
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `label=one-fetch.restore-run=${runId}`,
      ]);
      assert.equal(remaining, "");
    }
    await rm(root, { recursive: true, force: true }); // exact mkdtemp directory, no user data
    report.cleanup = true;
  } catch {
    report.cleanup = false;
    report.containerName = name; // non-secret, exact manual cleanup target
    process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath)
    await writeFile(reportPath, output, { flag: "wx", mode: 0o600 });
  process.stdout.write(output);
}
