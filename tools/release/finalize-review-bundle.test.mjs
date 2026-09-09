import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import process from "node:process";
import test from "node:test";

import {
  assertRequiredReviewArtifacts,
  finalizeReviewBundle,
  requiredReviewArtifactFilenames,
} from "./finalize-review-bundle.mjs";
import { join, readJson, repositoryRoot } from "./lib.mjs";

const version = "0.1.0";

async function makeOutput() {
  const outputRoot = await mkdtemp(
    join(repositoryRoot, `.one-fetch-finalize-test-${process.pid}-`),
  );
  const outputDirectory = join(outputRoot, version);
  await mkdir(outputDirectory, { recursive: true });
  return { outputDirectory, outputRoot };
}

async function writeArtifacts(outputDirectory, filenames) {
  await Promise.all(
    filenames.map((filename) =>
      writeFile(
        join(outputDirectory, filename),
        `test artifact: ${filename}\n`,
        "utf8",
      ),
    ),
  );
}

function checksumNames(contents) {
  return new Set(
    contents
      .trim()
      .split("\n")
      .map((line) => line.slice(line.indexOf("  ") + 2)),
  );
}

test("review bundles require every baseline distribution", () => {
  assert.deepEqual(requiredReviewArtifactFilenames(version), [
    "one-fetch-protocol-0.1.0.tgz",
    "one-fetch-core-0.1.0.tgz",
    "one-fetch-client-0.1.0.tgz",
    "one-fetch-types-0.1.0.tgz",
    "one-fetch-protocol-schemas-0.1.0.json",
    "one-fetch-control-openapi-0.1.0.json",
    "one-fetch-node-0.1.0.tar.gz",
    "one-fetch-node-0.1.0.Dockerfile",
    "one-fetch-node-0.1.0.Dockerfile.dockerignore",
    "one-fetch-node-deploy-0.1.0.mjs",
    "one-fetch-node-oci-0.1.0.json",
    "one-fetch-admin-0.1.0.zip",
  ]);
});

test("review bundle flags require their exact OCI and SBOM artifacts", () => {
  assert.deepEqual(
    requiredReviewArtifactFilenames(version, {
      requireOci: true,
      requireOciSbom: true,
      requireSbom: true,
    }).slice(-3),
    [
      "one-fetch-sbom-0.1.0.cdx.json",
      "one-fetch-node-0.1.0.oci.tar",
      "one-fetch-node-oci-0.1.0.cdx.json",
    ],
  );
});

test("required artifacts reject missing, empty, and non-file entries", async () => {
  const { outputDirectory, outputRoot } = await makeOutput();
  const filenames = requiredReviewArtifactFilenames(version);
  try {
    await writeArtifacts(outputDirectory, filenames);
    await rm(join(outputDirectory, filenames[0]));
    await writeFile(join(outputDirectory, filenames[1]), "", "utf8");
    await rm(join(outputDirectory, filenames[2]));
    await mkdir(join(outputDirectory, filenames[2]));

    await assert.rejects(
      assertRequiredReviewArtifacts(outputDirectory, filenames),
      (error) => {
        assert.match(error.message, new RegExp(filenames[0], "u"));
        assert.match(error.message, new RegExp(filenames[1], "u"));
        assert.match(error.message, new RegExp(filenames[2], "u"));
        return true;
      },
    );
  } finally {
    await rm(outputRoot, { force: true, recursive: true });
  }
});

test("manifest and checksums cover every required review artifact", async () => {
  const { outputDirectory, outputRoot } = await makeOutput();
  const filenames = requiredReviewArtifactFilenames(version, {
    requireOci: true,
    requireOciSbom: true,
    requireSbom: true,
  });
  try {
    await writeArtifacts(outputDirectory, filenames);
    const result = await finalizeReviewBundle([
      "--version",
      version,
      "--output",
      outputRoot,
      "--require-sbom",
      "--require-oci",
      "--require-oci-sbom",
    ]);
    const manifest = await readJson(
      join(outputDirectory, result.manifestFilename),
    );
    const manifestNames = new Set(
      manifest.artifacts.map((artifact) => artifact.name),
    );
    for (const filename of filenames) {
      assert.ok(
        manifestNames.has(filename),
        `${filename} missing from manifest`,
      );
    }

    for (const algorithm of ["SHA256", "SHA512"]) {
      const names = checksumNames(
        await readFile(join(outputDirectory, `${algorithm}SUMS`), "utf8"),
      );
      for (const filename of [...filenames, result.manifestFilename]) {
        assert.ok(names.has(filename), `${filename} missing from ${algorithm}`);
      }
    }
  } finally {
    await rm(outputRoot, { force: true, recursive: true });
  }
});
