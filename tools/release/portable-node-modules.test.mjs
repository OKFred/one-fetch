import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createSharedDeployFixture,
  linkPackage,
  writeJson,
  writePackage,
} from "./node-deploy-fixture.test-helper.mjs";
import { materializePortableNodeModules } from "./portable-node-modules.mjs";

async function withFixture(prefix, callback) {
  const temporary = await mkdtemp(join(tmpdir(), prefix));
  try {
    await callback(await createSharedDeployFixture(temporary), temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("materializer merges shared deploy direct and transitive packages", async () => {
  await withFixture("one-fetch-portable-success-", async (fixture) => {
    const packages = await materializePortableNodeModules(fixture.nodeModules, {
      expectedStoreDir: fixture.store,
      workspaceDirectory: fixture.workspace,
    });
    assert.deepEqual(
      packages.map(({ name, version }) => ({ name, version })),
      [
        { name: "@fixture/core", version: "0.1.0" },
        { name: "@fixture/protocol", version: "0.1.0" },
        { name: "alpha", version: "1.0.0" },
        { name: "beta", version: "2.0.0" },
      ],
    );
    assert.equal(
      await readFile(join(fixture.nodeModules, "beta", "index.js"), "utf8"),
      'export default "beta";\n',
    );
    await assert.rejects(readlink(join(fixture.nodeModules, "alpha")));
    await assert.rejects(lstat(join(fixture.nodeModules, ".pnpm")));
    await assert.rejects(lstat(`${fixture.nodeModules}.pnpm-source`));
  });
});

test("materializer rejects logical-name and canonical-target escapes", async (t) => {
  await t.test("logical package name mismatch", async () => {
    await withFixture("one-fetch-portable-name-", async (fixture) => {
      await writeJson(join(fixture.alpha, "package.json"), {
        name: "not-alpha",
        version: "1.0.0",
      });
      await assert.rejects(
        materializePortableNodeModules(fixture.nodeModules, {
          expectedStoreDir: fixture.store,
          workspaceDirectory: fixture.workspace,
        }),
        /Logical package alpha resolves to not-alpha/u,
      );
    });
  });

  await t.test("package target outside node_modules", async () => {
    await withFixture(
      "one-fetch-portable-escape-",
      async (fixture, temporary) => {
        const outside = join(temporary, "outside");
        await writePackage(outside, { name: "alpha", version: "1.0.0" });
        const direct = join(fixture.nodeModules, "alpha");
        await rm(direct, { recursive: true, force: true });
        await linkPackage(outside, direct);
        await assert.rejects(
          materializePortableNodeModules(fixture.nodeModules, {
            expectedStoreDir: fixture.store,
            workspaceDirectory: fixture.workspace,
          }),
          /outside deployment node_modules/u,
        );
      },
    );
  });
});

test("materializer fails closed on duplicate peer contexts", async () => {
  await withFixture("one-fetch-portable-peer-", async (fixture) => {
    await fixture.addPackage({
      context: "alpha@1.0.0(peer@2.0.0)",
      exposure: "aggregate",
      name: "alpha",
      version: "1.0.0",
    });
    await fixture.savePackageMap();
    await assert.rejects(
      materializePortableNodeModules(fixture.nodeModules, {
        expectedStoreDir: fixture.store,
        workspaceDirectory: fixture.workspace,
      }),
      /Conflicting package alpha/u,
    );
  });
});

test("materializer rejects native and platform-specific packages", async (t) => {
  for (const field of ["os", "cpu", "libc"]) {
    await t.test(field, async () => {
      await withFixture(`one-fetch-portable-${field}-`, async (fixture) => {
        await writeJson(join(fixture.alpha, "package.json"), {
          name: "alpha",
          version: "1.0.0",
          [field]: ["linux"],
        });
        await assert.rejects(
          materializePortableNodeModules(fixture.nodeModules, {
            expectedStoreDir: fixture.store,
            workspaceDirectory: fixture.workspace,
          }),
          new RegExp(`non-portable ${field}`, "u"),
        );
      });
    });
  }
  await t.test("native addon", async () => {
    await withFixture("one-fetch-portable-native-", async (fixture) => {
      await writeFile(join(fixture.alpha, "binding.node"), "not native\n");
      await assert.rejects(
        materializePortableNodeModules(fixture.nodeModules, {
          expectedStoreDir: fixture.store,
          workspaceDirectory: fixture.workspace,
        }),
        /Native \.node binary/u,
      );
    });
  });
});

test("materializer rejects absolute build-machine references", async () => {
  await withFixture("one-fetch-portable-path-", async (fixture) => {
    await writeFile(
      join(fixture.alpha, "build-path.txt"),
      `${fixture.workspace}\n`,
      "utf8",
    );
    await assert.rejects(
      materializePortableNodeModules(fixture.nodeModules, {
        expectedStoreDir: fixture.store,
        workspaceDirectory: fixture.workspace,
      }),
      /absolute workspace reference/u,
    );
  });
});

test("materializer rejects JSON-escaped build-machine references", async () => {
  await withFixture("one-fetch-portable-json-path-", async (fixture) => {
    await writeFile(
      join(fixture.alpha, "build-path.json"),
      JSON.stringify({ path: fixture.workspace }),
      "utf8",
    );
    await assert.rejects(
      materializePortableNodeModules(fixture.nodeModules, {
        expectedStoreDir: fixture.store,
        workspaceDirectory: fixture.workspace,
      }),
      /absolute workspace reference/u,
    );
  });
});
