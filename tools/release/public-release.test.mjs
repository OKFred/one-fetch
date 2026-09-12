import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { requiredReviewArtifactFilenames } from "./finalize-review-bundle.mjs";
import { repositoryRoot } from "./lib.mjs";
import {
  loadPublicRelease,
  parseChecksums,
  readPublicApi,
} from "./public-release.mjs";
import { verifyPublicRelease } from "./verify-public-release.mjs";

const identity = {
  repository: "OKFred/one-fetch",
  version: "0.1.0",
  commit: "a".repeat(40),
  channel: "preview",
};
const hash = (data, algorithm) =>
  createHash(algorithm).update(data).digest("hex");

function publicFixture() {
  const contents = new Map(
    requiredReviewArtifactFilenames(identity.version, {
      requireOci: true,
      requireOciSbom: true,
      requireSbom: true,
    }).map((name) => [name, `synthetic artifact: ${name}`]),
  );
  const artifacts = [...contents].map(([name, body]) => ({
    name,
    bytes: body.length,
    sha256: hash(body, "sha256"),
    sha512: hash(body, "sha512"),
  }));
  contents.set(
    "one-fetch-release-manifest-0.1.0.json",
    JSON.stringify({
      schemaVersion: 1,
      version: identity.version,
      channel: "preview",
      protocolVersion: 1,
      source: {
        commit: identity.commit,
        dirty: false,
        repository: "https://github.com/OKFred/one-fetch",
      },
      artifacts,
    }),
  );
  const subjects = [...contents];
  for (const algorithm of ["sha256", "sha512"])
    contents.set(
      `${algorithm.toUpperCase()}SUMS`,
      subjects
        .map(([name, data]) => `${hash(data, algorithm)}  ${name}`)
        .join("\n") + "\n",
    );
  const assets = () =>
    [...contents].map(([name, body], index) => ({
      id: index + 1,
      name,
      state: "uploaded",
      size: body.length,
      digest: `sha256:${hash(body, "sha256")}`,
      browser_download_url: `https://github.com/OKFred/one-fetch/releases/download/v0.1.0/${name}`,
    }));
  const release = {
    id: 7,
    draft: false,
    prerelease: true,
    tag_name: "v0.1.0",
    published_at: "2026-09-10T00:00:00Z",
    target_commitish: "main",
    html_url: "https://github.com/OKFred/one-fetch/releases/tag/v0.1.0",
  };
  const ref = { object: { type: "tag", sha: "b".repeat(40) } };
  const tag = {
    tag: "v0.1.0",
    object: { type: "commit", sha: identity.commit },
  };
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, undefined);
    const path = new globalThis.URL(url).pathname;
    const value = path.endsWith("/releases/tags/v0.1.0")
      ? release
      : path.endsWith("/git/ref/tags/v0.1.0")
        ? ref
        : path.includes("/git/tags/")
          ? tag
          : assets();
    return globalThis.Response.json(value);
  };
  const run = async (args) => {
    const name = args.at(-1).split("/").at(-1);
    await writeFile(args[args.indexOf("--output") + 1], contents.get(name));
    return 0;
  };
  return { contents, release, ref, tag, assets, fetcher, run };
}

async function outputDirectory(t) {
  const base = join(repositoryRoot, ".tools");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "public-verification-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("published identity uses the annotated tag commit, not the moving target_commitish", async () => {
  const fixture = publicFixture();
  const release = await loadPublicRelease(identity, fixture.fetcher);
  assert.equal(release.assets.length, 18);
  fixture.tag.object.sha = "c".repeat(40);
  await assert.rejects(
    loadPublicRelease(identity, fixture.fetcher),
    /tag_commit_mismatch/u,
  );
  fixture.ref.object.type = "commit";
  await assert.rejects(
    loadPublicRelease(identity, fixture.fetcher),
    /annotated_tag_required/u,
  );
});

test("draft, wrong channel, missing artifact, and duplicate asset names fail closed", async () => {
  const draft = publicFixture();
  draft.release.draft = true;
  await assert.rejects(
    loadPublicRelease(identity, draft.fetcher),
    /release_identity_mismatch/u,
  );
  const stable = publicFixture();
  stable.release.prerelease = false;
  await assert.rejects(
    loadPublicRelease(identity, stable.fetcher),
    /release_identity_mismatch/u,
  );
  const missing = publicFixture();
  missing.contents.delete("one-fetch-node-0.1.0.oci.tar");
  await assert.rejects(
    loadPublicRelease(identity, missing.fetcher),
    /missing_release_asset/u,
  );
  const duplicate = publicFixture();
  const fetcher = async (url, options) =>
    url.includes("/assets?")
      ? globalThis.Response.json([...duplicate.assets(), duplicate.assets()[0]])
      : duplicate.fetcher(url, options);
  await assert.rejects(
    loadPublicRelease(identity, fetcher),
    /duplicate_asset/u,
  );
});

test("metadata errors redact network details, cancel error bodies, and bound JSON buffering", async () => {
  await assert.rejects(
    readPublicApi("/test", async () => {
      throw new Error("secret-canary");
    }),
    { message: "github_metadata_unavailable" },
  );
  let cancelled = false;
  const body = new globalThis.ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readPublicApi(
      "/test",
      async () => new globalThis.Response(body, { status: 403 }),
    ),
    /github_http_403/u,
  );
  assert.equal(cancelled, true);
  await assert.rejects(
    readPublicApi(
      "/test",
      async () => new globalThis.Response("x".repeat(2 * 1024 ** 2 + 1)),
    ),
    /github_metadata_too_large/u,
  );
  await assert.rejects(
    readPublicApi("/test", async () => new globalThis.Response("not JSON")),
    /github_metadata_unavailable/u,
  );
});

test("checksum syntax rejects duplicate names, path traversal and malformed digests", () => {
  const line = `${"a".repeat(64)}  body.zip`;
  assert.equal(
    parseChecksums(`${line}\r\n`, 64).get("body.zip"),
    "a".repeat(64),
  );
  for (const input of [
    "",
    `${line}\n${line}`,
    `${"a".repeat(64)}  ../evil`,
    "bad  body.zip",
  ]) {
    assert.throws(() => parseChecksums(input, 64), /invalid_checksum_file/u);
  }
});

test("full verification persists distinct receipts and honestly marks cache reuse", async (t) => {
  const fixture = publicFixture();
  const output = await outputDirectory(t);
  const args = [
    "--version",
    "0.1.0",
    "--commit",
    identity.commit,
    "--output",
    output,
  ];
  const first = await verifyPublicRelease(args, { ...fixture, log() {} });
  assert.equal(first.receipt.state, "passed");
  assert.equal(first.receipt.provenanceVerified, false);
  assert.ok(
    first.receipt.results.every(
      (entry) => entry.source === "anonymous-download",
    ),
  );
  assert.ok(first.receipt.results.every((entry) => !("path" in entry)));
  const second = await verifyPublicRelease(args, { ...fixture, log() {} });
  assert.equal(second.receipt.state, "passed");
  assert.ok(
    second.receipt.results.every((entry) => entry.source === "verified-cache"),
  );
  assert.notEqual(first.receiptPath, second.receiptPath);
  assert.equal(
    JSON.parse(await readFile(first.receiptPath, "utf8")).state,
    "passed",
  );
});

test("partial failures produce a receipt, retain successes and never include stderr secrets", async (t) => {
  const fixture = publicFixture();
  const output = await outputDirectory(t);
  const result = await verifyPublicRelease(
    ["--version", "0.1.0", "--commit", identity.commit, "--output", output],
    {
      ...fixture,
      log() {},
      run: async (args) => {
        if (args.at(-1).endsWith(".oci.tar"))
          throw new Error("secret-redirect-token");
        return fixture.run(args);
      },
    },
  );
  assert.equal(result.receipt.state, "incomplete");
  assert.equal(
    result.receipt.results.filter((entry) => entry.state === "verified").length,
    17,
  );
  assert.equal(result.receipt.error, "asset_downloads_incomplete");
  assert.ok(
    !(await readFile(result.receiptPath, "utf8")).includes(
      "secret-redirect-token",
    ),
  );
});

test("API digests alone cannot bless a wrong manifest or bad release checksum", async (t) => {
  for (const kind of ["manifest", "checksum"]) {
    const fixture = publicFixture();
    if (kind === "manifest") {
      const name = "one-fetch-release-manifest-0.1.0.json";
      const manifest = JSON.parse(fixture.contents.get(name));
      manifest.source.commit = "d".repeat(40);
      fixture.contents.set(name, JSON.stringify(manifest));
    } else
      fixture.contents.set(
        "SHA512SUMS",
        `${"0".repeat(128)}  one-fetch-node-0.1.0.oci.tar\n`,
      );
    const result = await verifyPublicRelease(
      [
        "--version",
        "0.1.0",
        "--commit",
        identity.commit,
        "--output",
        await outputDirectory(t),
      ],
      { ...fixture, log() {} },
    );
    assert.equal(result.receipt.state, "incomplete");
    assert.equal(
      result.receipt.error,
      kind === "manifest" ? "manifest_identity_mismatch" : "checksum_mismatch",
    );
  }
});
