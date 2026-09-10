import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTransientDatabaseLink,
  readDatabasePassword,
} from "./transient-database-link.mjs";

const projectRef = "abcdefghijklmnopqrst";

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-link-fixture-"));
  await mkdir(join(root, "adapter", "supabase", "migrations"), {
    recursive: true,
  });
  await writeFile(
    join(root, "adapter", "supabase", "config.toml"),
    'project_id = "one-fetch"\n',
  );
  await writeFile(
    join(root, "adapter", "supabase", "migrations", "001.sql"),
    "select 1;\n",
  );
  return root;
}

test("database password uses a restricted file or explicit environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-password-fixture-"));
  try {
    const path = join(root, "database.secret");
    await writeFile(path, "p".repeat(32));
    assert.equal(
      await readDatabasePassword({ dbPasswordFile: path }, {}),
      "p".repeat(32),
    );
    assert.equal(
      await readDatabasePassword({}, { SUPABASE_DB_PASSWORD: "e".repeat(32) }),
      "e".repeat(32),
    );
    await assert.rejects(readDatabasePassword({}, {}), /requires/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transient link stages migrations, verifies the exact project, and cleans up", async () => {
  const root = await fixtureRoot();
  const commands = [];
  try {
    const link = await createTransientDatabaseLink({
      adapterRoot: join(root, "adapter"),
      projectRef,
      databasePassword: "p".repeat(32),
      temporaryRoot: root,
      runPnpm(arguments_, options) {
        commands.push({ arguments_, options });
        const workdir = arguments_[arguments_.indexOf("--workdir") + 1];
        const stateRoot = join(workdir, "supabase", ".temp");
        mkdirSync(stateRoot, { recursive: true });
        writeFileSync(join(stateRoot, "project-ref"), `${projectRef}\n`);
        writeFileSync(
          join(stateRoot, "pooler-url"),
          `postgresql://postgres.${projectRef}@aws-0.test.pooler.supabase.com:5432/postgres`,
        );
      },
    });
    assert.equal(commands.length, 1);
    assert(commands[0].arguments_.includes("link"));
    assert.equal(
      commands[0].options.environment.SUPABASE_DB_PASSWORD,
      "p".repeat(32),
    );
    assert.doesNotMatch(JSON.stringify(commands[0].arguments_), /p{32}/u);
    assert.equal(
      await readFile(
        join(link.workdir, "supabase", "migrations", "001.sql"),
        "utf8",
      ),
      "select 1;\n",
    );
    await link.cleanup();
    await assert.rejects(access(link.workdir));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transient link rejects and removes mismatched project state", async () => {
  const root = await fixtureRoot();
  try {
    await assert.rejects(
      createTransientDatabaseLink({
        adapterRoot: join(root, "adapter"),
        projectRef,
        databasePassword: "p".repeat(32),
        temporaryRoot: root,
        runPnpm(arguments_) {
          const workdir = arguments_[arguments_.indexOf("--workdir") + 1];
          const stateRoot = join(workdir, "supabase", ".temp");
          mkdirSync(stateRoot, { recursive: true });
          writeFileSync(join(stateRoot, "project-ref"), `${"z".repeat(20)}\n`);
          writeFileSync(
            join(stateRoot, "pooler-url"),
            `postgresql://postgres.${projectRef}@aws-0.test.pooler.supabase.com:5432/postgres`,
          );
        },
      }),
      /instead of/u,
    );
    const entries = await import("node:fs/promises").then(({ readdir }) =>
      readdir(root),
    );
    assert.equal(
      entries.some((name) => name.startsWith("one-fetch-supabase-link-")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
