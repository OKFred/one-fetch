import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import {
  nodeDistributionFilenames,
  validateNodeOciConfiguration,
} from "./build-node-distribution.mjs";
import { createDeterministicTarGzip } from "./deterministic-tar.mjs";
import { readJson, repositoryRoot } from "./lib.mjs";
import { materializePortableNodeModules } from "./portable-node-modules.mjs";

function tarText(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function inspectTar(archive) {
  const tar = gunzipSync(archive);
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const expectedChecksum = Number.parseInt(tarText(header, 148, 8).trim(), 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    assert.equal(
      checksumHeader.reduce((sum, value) => sum + value, 0),
      expectedChecksum,
    );
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const size = Number.parseInt(tarText(header, 124, 12), 8);
    entries.push({
      path: prefix ? `${prefix}/${name}` : name,
      mode: Number.parseInt(tarText(header, 100, 8), 8),
      mtime: Number.parseInt(tarText(header, 136, 12), 8),
      size,
      type: String.fromCharCode(header[156]),
      contents: tar.subarray(offset + 512, offset + 512 + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("Node distribution filenames are versioned and path-safe", () => {
  assert.deepEqual(nodeDistributionFilenames("0.1.0"), {
    archive: "one-fetch-node-0.1.0.tar.gz",
    dockerfile: "one-fetch-node-0.1.0.Dockerfile",
    dockerignore: "one-fetch-node-0.1.0.Dockerfile.dockerignore",
    metadata: "one-fetch-node-oci-0.1.0.json",
  });
  assert.throws(
    () => nodeDistributionFilenames("../0.1.0"),
    /Invalid release/u,
  );
});

test("deterministic tar archives normalize order, metadata, and gzip header", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "one-fetch-tar-test-"));
  try {
    const source = join(temporary, "source");
    const nested = join(source, "a".repeat(80), "b".repeat(40));
    await mkdir(join(source, "dist"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(join(source, "z.txt"), "last\n", "utf8");
    await writeFile(
      join(source, "dist", "cli.js"),
      "#!/usr/bin/env node\n",
      "utf8",
    );
    await writeFile(join(nested, "payload.txt"), "nested\n", "utf8");
    const first = join(temporary, "first.tar.gz");
    const second = join(temporary, "second.tar.gz");
    const options = {
      sourceDirectory: source,
      rootName: "one-fetch",
      mtime: 1_725_408_000,
      executablePaths: ["dist/cli.js"],
    };
    await createDeterministicTarGzip({ ...options, outputFile: first });
    await createDeterministicTarGzip({ ...options, outputFile: second });
    const firstBytes = await readFile(first);
    assert.deepEqual(firstBytes, await readFile(second));
    assert.equal(firstBytes.readUInt32LE(4), 0);
    assert.equal(firstBytes[9], 0xff);

    const entries = inspectTar(firstBytes);
    assert.deepEqual(
      entries.map((entry) => entry.path),
      [
        "one-fetch",
        `one-fetch/${"a".repeat(80)}`,
        `one-fetch/${"a".repeat(80)}/${"b".repeat(40)}`,
        `one-fetch/${"a".repeat(80)}/${"b".repeat(40)}/payload.txt`,
        "one-fetch/dist",
        "one-fetch/dist/cli.js",
        "one-fetch/z.txt",
      ],
    );
    assert.equal(
      entries.find((entry) => entry.path.endsWith("cli.js"))?.mode,
      0o755,
    );
    assert.ok(entries.every((entry) => entry.mtime === 1_725_408_000));
    assert.equal(
      entries
        .find((entry) => entry.path.endsWith("payload.txt"))
        ?.contents.toString(),
      "nested\n",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("deterministic tar refuses unsafe roots and escaping symlinks", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "one-fetch-tar-safety-"));
  try {
    const source = join(temporary, "source");
    const outside = join(temporary, "outside.txt");
    await mkdir(source);
    await writeFile(outside, "secret\n", "utf8");
    await assert.rejects(
      createDeterministicTarGzip({
        sourceDirectory: source,
        outputFile: join(temporary, "unsafe.tar.gz"),
        rootName: "../one-fetch",
      }),
      /safe relative POSIX path/u,
    );
    await symlink(outside, join(source, "escape.txt"));
    await assert.rejects(
      createDeterministicTarGzip({
        sourceDirectory: source,
        outputFile: join(temporary, "escape.tar.gz"),
        rootName: "one-fetch",
      }),
      /symlink escapes/u,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("portable node_modules materializes pnpm packages without links", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "one-fetch-modules-test-"));
  try {
    const modules = join(temporary, "node_modules");
    const store = join(modules, ".pnpm");
    const aggregate = join(store, "node_modules");
    const plain = join(store, "plain@1.0.0", "node_modules", "plain");
    const scoped = join(
      store,
      "@scope+tool@1.0.0",
      "node_modules",
      "@scope",
      "tool",
    );
    await mkdir(join(aggregate, "@scope"), { recursive: true });
    await mkdir(plain, { recursive: true });
    await mkdir(scoped, { recursive: true });
    await writeFile(join(plain, "index.js"), "export default 'plain';\n");
    await writeFile(join(scoped, "index.js"), "export default 'tool';\n");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await symlink(plain, join(aggregate, "plain"), linkType);
    await symlink(scoped, join(aggregate, "@scope", "tool"), linkType);

    assert.deepEqual(await materializePortableNodeModules(modules), [
      "@scope/tool",
      "plain",
    ]);
    assert.equal(
      await readFile(join(modules, "plain", "index.js"), "utf8"),
      "export default 'plain';\n",
    );
    assert.equal(
      await readFile(join(modules, "@scope", "tool", "index.js"), "utf8"),
      "export default 'tool';\n",
    );
    await assert.rejects(readlink(join(modules, "plain")));
    await assert.rejects(lstat(join(modules, ".pnpm")));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("portable node_modules rejects dependencies outside its deployment", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "one-fetch-modules-safety-"));
  try {
    const modules = join(temporary, "node_modules");
    const aggregate = join(modules, ".pnpm", "node_modules");
    const outside = join(temporary, "outside");
    await mkdir(aggregate, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "not a dependency\n");
    await symlink(
      outside,
      join(aggregate, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      materializePortableNodeModules(modules),
      /escapes node_modules/u,
    );
    assert.ok(await lstat(join(modules, ".pnpm")));
    await assert.rejects(lstat(`${modules}.portable`));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Node OCI metadata and Dockerfile pin one non-root multi-platform base", async () => {
  const configuration = await readJson(
    join(repositoryRoot, "adapters", "node", "oci-build.json"),
  );
  const dockerfile = await readFile(
    join(repositoryRoot, "adapters", "node", "Dockerfile"),
    "utf8",
  );
  assert.equal(
    validateNodeOciConfiguration(configuration, dockerfile),
    configuration,
  );
  assert.match(
    configuration.baseImage.reference,
    /node:24\.20\.0-bookworm-slim@sha256:[a-f0-9]{64}$/u,
  );
  assert.match(
    configuration.frontend.reference,
    /dockerfile:1\.7@sha256:[a-f0-9]{64}$/u,
  );
  assert.deepEqual(configuration.build.platforms, [
    "linux/amd64",
    "linux/arm64",
  ]);
  assert.ok(
    dockerfile.indexOf("USER node") > dockerfile.indexOf("ADD one-fetch-node-"),
  );
  assert.match(dockerfile, /ENTRYPOINT \["node", "dist\/cli\.js"\]/u);
  assert.match(dockerfile, /process\.env\.ONE_FETCH_CONTROL_PORT/u);
  assert.equal(
    dockerfile.split(/\r?\n/u)[0],
    `# syntax=${configuration.frontend.reference}`,
  );
  assert.throws(
    () =>
      validateNodeOciConfiguration(
        {
          ...configuration,
          baseImage: { ...configuration.baseImage, indexDigest: "latest" },
        },
        dockerfile,
      ),
    /SHA-256/u,
  );
});

test("Node adapter compiles against the Node 24 type surface", async () => {
  const manifest = await readJson(
    join(repositoryRoot, "adapters", "node", "package.json"),
  );
  assert.equal(manifest.engines.node, ">=24.20.0 <27");
  assert.match(manifest.devDependencies["@types/node"], /^24\./u);
  assert.deepEqual(manifest.files, [
    ".env.example",
    "dist",
    "migration-manifest.json",
    "migrations",
    "README.md",
  ]);
});
