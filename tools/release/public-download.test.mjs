import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  link,
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
  curlArguments,
  downloadAsset,
  requireCurlVersion,
  validateAsset,
} from "./public-download.mjs";

const repository = "OKFred/one-fetch";
const version = "0.1.0";
const content = "synthetic-public-asset";
const asset = {
  id: 12,
  name: "example.tgz",
  state: "uploaded",
  size: content.length,
  digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
  browser_download_url: `https://github.com/${repository}/releases/download/v${version}/example.tgz`,
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "one-fetch-download-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, repository, version, attempts: 2, timeoutSeconds: 1 };
}
function destination(args) {
  return args[args.indexOf("--output") + 1];
}

test("cURL must enforce streaming size limits and support HTTPS", () => {
  requireCurlVersion("curl 8.4.0 (linux)\nProtocols: http https\n");
  requireCurlVersion("curl 9.0.0 (linux)\nProtocols: https\n");
  for (const output of [
    "curl 7.88.0\nProtocols: https",
    "curl 8.3.0\nProtocols: https",
    "curl 8.4.0\nProtocols: http",
    "not curl",
  ]) {
    assert.throws(() => requireCurlVersion(output), /curl_8_4_https_required/u);
  }
});

test("hard-linked cache files cannot overwrite another local file", async (t) => {
  const options = await fixture(t);
  const original = join(options.directory, "preserve.txt");
  await writeFile(original, "do not alter");
  const cache = join(options.directory, `${asset.id}-${asset.digest.slice(7)}`);
  await mkdir(cache);
  await link(original, join(cache, `${asset.name}.part`));
  await assert.rejects(
    downloadAsset(asset, {
      ...options,
      run: () => assert.fail("must not download"),
    }),
    /unsafe_cache_file/u,
  );
  assert.equal(await readFile(original, "utf8"), "do not alter");
});

test("anonymous transport ignores curlrc and forbids HTTP and shell-shaped URLs", () => {
  const args = curlArguments(asset, "file.part", 300);
  assert.equal(args[0], "--disable");
  assert.equal(args[args.indexOf("--proto-redir") + 1], "=https");
  assert.equal(args[args.indexOf("--continue-at") + 1], "-");
  assert.ok(!args.includes("--location-trusted"));
  for (const patch of [
    { name: "../evil" },
    { name: "CON.txt" },
    { name: "body." },
    { name: "-o" },
    { digest: "sha256:bad" },
    { size: -1 },
    { size: 5 * 1024 ** 3 },
    { id: 0 },
    { state: "new" },
    { browser_download_url: "https://example.org/file" },
    { browser_download_url: `${asset.browser_download_url}?token=secret` },
  ])
    assert.throws(
      () => validateAsset({ ...asset, ...patch }, repository, version),
      /invalid_asset/u,
    );
});

test("interrupted transfer resumes and hashes both algorithms without buffering the asset", async (t) => {
  const options = await fixture(t);
  let calls = 0;
  const result = await downloadAsset(asset, {
    ...options,
    run: async (args) => {
      calls += 1;
      const path = destination(args);
      if (calls === 1) {
        await writeFile(path, content.slice(0, 5));
        return 28;
      }
      assert.equal(await readFile(path, "utf8"), content.slice(0, 5));
      await appendFile(path, content.slice(5));
      return 0;
    },
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.source, "anonymous-download");
  assert.equal(
    result.sha512,
    createHash("sha512").update(content).digest("hex"),
  );
  assert.equal(await readFile(result.path, "utf8"), content);
  const reused = await downloadAsset(asset, {
    ...options,
    run: () => assert.fail("cache must not fetch"),
  });
  assert.equal(reused.source, "verified-cache");
  assert.equal(reused.attempts, 0);
});

test("exhausted attempts preserve bytes and a later invocation can resume", async (t) => {
  const options = await fixture(t);
  await assert.rejects(
    downloadAsset(asset, {
      ...options,
      attempts: 1,
      run: async (args) => {
        await writeFile(destination(args), content.slice(0, 4));
        return 28;
      },
    }),
    /download_failed_curl_28/u,
  );
  const result = await downloadAsset(asset, {
    ...options,
    run: async (args) => {
      await appendFile(destination(args), content.slice(4));
      return 0;
    },
  });
  assert.equal(result.resumedBytes, 4);
});

test("corrupt complete artifacts and ignored Range fail without overwrite or false success", async (t) => {
  const options = await fixture(t);
  let path;
  await assert.rejects(
    downloadAsset(asset, {
      ...options,
      run: async (args) => {
        path = destination(args);
        await writeFile(path, "x".repeat(content.length));
        return 0;
      },
    }),
    /digest_mismatch/u,
  );
  assert.equal((await readFile(path)).length, content.length);
  await assert.rejects(
    downloadAsset(asset, {
      ...options,
      run: () => assert.fail("must not overwrite"),
    }),
    /digest_mismatch/u,
  );
  const other = await fixture(t);
  let calls = 0;
  await assert.rejects(
    downloadAsset(asset, {
      ...other,
      run: async () => {
        calls += 1;
        return 33;
      },
    }),
    /download_failed_curl_33/u,
  );
  assert.equal(calls, 1);
});

test("HTTP errors are not retried and oversized or truncated successes cannot pass", async (t) => {
  for (const [code, payload, expected] of [
    [22, "", /download_failed_curl_22/u],
    [0, `${content}x`, /size_mismatch/u],
    [0, "short", /download_failed_curl_0/u],
  ]) {
    const options = await fixture(t);
    await assert.rejects(
      downloadAsset(asset, {
        ...options,
        attempts: 1,
        run: async (args) => {
          await writeFile(destination(args), payload);
          return code;
        },
      }),
      expected,
    );
  }
});

test("same-asset concurrent writers are rejected and locks are released after failures", async (t) => {
  const options = await fixture(t);
  await downloadAsset(asset, {
    ...options,
    run: async (args) => {
      await assert.rejects(downloadAsset(asset, options), /cache_locked/u);
      await writeFile(destination(args), content);
      return 0;
    },
  });
  await downloadAsset(asset, { ...options, run: () => assert.fail("cached") });
});
