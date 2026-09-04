import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";
import process from "node:process";
import test from "node:test";

import { createInstalledWorkspaceFixture } from "./node-deploy-fixture.test-helper.mjs";
import { repositoryRoot } from "./lib.mjs";
import {
  inspectFrozenPnpmWorkspace,
  isPathInside,
  runSharedPnpmDeploy,
  sharedDeployArguments,
} from "./pnpm-shared-deploy.mjs";

async function withWorkspace(prefix, callback) {
  const temporary = await mkdtemp(join(tmpdir(), prefix));
  try {
    await callback(await createInstalledWorkspaceFixture(temporary), temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("Windows containment rejects a different drive", () => {
  assert.equal(isPathInside("C:\\workspace", "D:\\outside", win32), false);
  assert.equal(
    isPathInside("C:\\workspace", "C:\\workspace\\node_modules", win32),
    true,
  );
  assert.equal(
    isPathInside("C:\\workspace", "C:\\workspace-other", win32),
    false,
  );
});

test("shared deploy uses only the pinned frozen offline pnpm path", () => {
  const target = join(tmpdir(), "one-fetch-pnpm-target");
  const argumentsList = sharedDeployArguments(
    target,
    join(tmpdir(), "one-fetch-pnpm-store"),
    join(tmpdir(), "one-fetch-pnpm-cache"),
  );
  assert.ok(argumentsList.includes("--config.inject-workspace-packages=true"));
  assert.ok(argumentsList.includes("--prod"));
  assert.ok(argumentsList.includes("--offline"));
  assert.ok(argumentsList.includes("--frozen-lockfile"));
  assert.ok(argumentsList.includes("--frozen-store"));
  assert.ok(argumentsList.includes("--ignore-scripts"));
  assert.ok(argumentsList.includes("--trust-lockfile"));
  assert.ok(
    argumentsList.some((item) => item.startsWith("--config.cache-dir=")),
  );
  assert.equal(argumentsList.includes("--legacy"), false);
  assert.equal(argumentsList.at(-1), resolve(target));
});

test("frozen workspace preflight accepts the exact installed pnpm state", async () => {
  await withWorkspace("one-fetch-pnpm-state-", async (fixture) => {
    const result = await inspectFrozenPnpmWorkspace(fixture.workspace);
    assert.equal(result.storeDir, fixture.store);
    assert.match(result.pnpmBin, /pnpm[\\/]bin[\\/]pnpm\.cjs$/u);
  });
});

test("frozen workspace preflight rejects lock and package manager drift", async (t) => {
  await t.test("lock bytes", async () => {
    await withWorkspace("one-fetch-pnpm-lock-", async (fixture) => {
      await writeFile(
        join(fixture.virtualStore, "lock.yaml"),
        "stale\n",
        "utf8",
      );
      await assert.rejects(
        inspectFrozenPnpmWorkspace(fixture.workspace),
        /byte for byte/u,
      );
    });
  });
  await t.test("root packageManager", async () => {
    await withWorkspace("one-fetch-pnpm-root-", async (fixture) => {
      await writeFile(
        join(fixture.workspace, "package.json"),
        '{"packageManager":"pnpm@11.24.0"}\n',
        "utf8",
      );
      await assert.rejects(
        inspectFrozenPnpmWorkspace(fixture.workspace),
        /Root packageManager/u,
      );
    });
  });
  await t.test("installed pnpm", async () => {
    await withWorkspace("one-fetch-pnpm-cli-", async (fixture) => {
      const manifestPath = join(fixture.pnpmPackage, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.version = "11.24.0";
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
      await assert.rejects(
        inspectFrozenPnpmWorkspace(fixture.workspace),
        /Installed pnpm package/u,
      );
    });
  });
});

test("frozen workspace preflight rejects incomplete or unsafe modules state", async (t) => {
  for (const [label, mutate, pattern] of [
    [
      "optional dependencies",
      (state) => {
        state.included.optionalDependencies = false;
      },
      /production and optional/u,
    ],
    [
      "pending builds",
      (state) => {
        state.pendingBuilds = ["native-addon"];
      },
      /pending dependency build/u,
    ],
    [
      "ignored builds",
      (state) => {
        state.ignoredBuilds = ["native-addon"];
      },
      /ignored dependency build/u,
    ],
    [
      "layout",
      (state) => {
        state.layoutVersion = 4;
      },
      /layout version 5/u,
    ],
  ]) {
    await t.test(label, async () => {
      await withWorkspace(`one-fetch-pnpm-${label}-`, async (fixture) => {
        const state = await fixture.readModules();
        mutate(state);
        await fixture.writeModules(state);
        await assert.rejects(
          inspectFrozenPnpmWorkspace(fixture.workspace),
          pattern,
        );
      });
    });
  }
  await t.test("missing content store", async () => {
    await withWorkspace("one-fetch-pnpm-store-", async (fixture, temporary) => {
      const state = await fixture.readModules();
      state.storeDir = join(temporary, "missing-store");
      await fixture.writeModules(state);
      await assert.rejects(
        inspectFrozenPnpmWorkspace(fixture.workspace),
        /existing directory/u,
      );
    });
  });
});

test("real pinned pnpm deploys with an empty metadata cache", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "one-fetch-pnpm-offline-"));
  try {
    const deployment = join(temporary, "deployment");
    const cache = join(temporary, "empty-cache");
    await mkdir(cache);
    await runSharedPnpmDeploy({
      cacheDirectory: cache,
      destinationDirectory: deployment,
      environment: {
        ...process.env,
        COREPACK_HOME: join(temporary, "empty-corepack"),
        XDG_CACHE_HOME: join(temporary, "empty-xdg"),
        npm_config_cache: join(temporary, "empty-npm"),
      },
      workspaceDirectory: repositoryRoot,
    });
    assert.ok(
      await readFile(join(deployment, "node_modules", ".modules.yaml"), "utf8"),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
