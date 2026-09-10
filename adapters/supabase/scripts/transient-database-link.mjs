import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";

async function readRestrictedFile(path, label) {
  const resolved = resolve(path);
  const details = await stat(resolved);
  if (!details.isFile()) throw new Error(`${label} path is not a file`);
  return (await readFile(resolved, "utf8")).trim();
}

export async function readDatabasePassword(options, environment = process.env) {
  const value = options.dbPasswordFile
    ? await readRestrictedFile(options.dbPasswordFile, "database password")
    : environment.SUPABASE_DB_PASSWORD?.trim();
  if (!value || value.length < 16) {
    throw new Error(
      "Hosted database preflight requires --db-password-file or SUPABASE_DB_PASSWORD",
    );
  }
  return value;
}

async function stageProject(sourceRoot, workdir) {
  const source = join(sourceRoot, "supabase");
  const target = join(workdir, "supabase");
  const targetMigrations = join(target, "migrations");
  await mkdir(targetMigrations, { recursive: true });
  await copyFile(join(source, "config.toml"), join(target, "config.toml"));
  const migrations = (await readdir(join(source, "migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (migrations.length === 0)
    throw new Error("No Supabase migrations were available to stage");
  await Promise.all(
    migrations.map((name) =>
      copyFile(join(source, "migrations", name), join(targetMigrations, name)),
    ),
  );
  await cp(join(source, "functions"), join(target, "functions"), {
    recursive: true,
  });
}

async function verifyLink(workdir, projectRef) {
  const stateRoot = join(workdir, "supabase", ".temp");
  const linkedProject = (
    await readFile(join(stateRoot, "project-ref"), "utf8")
  ).trim();
  if (linkedProject !== projectRef) {
    throw new Error(
      `Transient Supabase link resolved ${linkedProject || "an empty project"} instead of ${projectRef}`,
    );
  }
  const pooler = new URL(
    (await readFile(join(stateRoot, "pooler-url"), "utf8")).trim(),
  );
  if (
    pooler.protocol !== "postgresql:" ||
    pooler.password !== "" ||
    pooler.username !== `postgres.${projectRef}` ||
    !pooler.hostname.endsWith(".pooler.supabase.com")
  ) {
    throw new Error("Supabase did not return a safe IPv4 pooler link");
  }
}

export async function createTransientDatabaseLink({
  adapterRoot,
  projectRef,
  databasePassword,
  runPnpm,
  temporaryRoot = tmpdir(),
}) {
  const workdir = await mkdtemp(
    join(resolve(temporaryRoot), "one-fetch-supabase-link-"),
  );
  let ready = false;
  try {
    await stageProject(adapterRoot, workdir);
    runPnpm(
      [
        "exec",
        "supabase",
        "link",
        "--workdir",
        workdir,
        "--project-ref",
        projectRef,
        "--yes",
      ],
      {
        label: "isolated Supabase IPv4 link",
        environment: { SUPABASE_DB_PASSWORD: databasePassword },
      },
    );
    await verifyLink(workdir, projectRef);
    ready = true;
    return {
      projectRef,
      workdir,
      async cleanup() {
        await rm(workdir, { recursive: true, force: true });
      },
    };
  } finally {
    if (!ready) await rm(workdir, { recursive: true, force: true });
  }
}
