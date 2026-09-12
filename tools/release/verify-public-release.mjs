import console from "node:console";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  assertInsideRepository,
  parseArguments,
  repositoryRoot,
} from "./lib.mjs";
import { DownloadError, downloadAsset } from "./public-download.mjs";
import {
  loadPublicRelease,
  publicReleaseIdentity,
  verifyDownloadedRelease,
} from "./public-release.mjs";

export async function verifyPublicRelease(
  argv = process.argv.slice(2),
  dependencies = {},
) {
  const args = parseArguments(argv);
  const allowed = new Set([
    "repository",
    "version",
    "commit",
    "channel",
    "output",
    "attempts",
    "timeout-seconds",
  ]);
  if ([...args.keys()].some((key) => !allowed.has(key)))
    throw new DownloadError("unknown_argument");
  const identity = publicReleaseIdentity(
    args.get("repository") ?? "OKFred/one-fetch",
    args.get("version"),
    args.get("commit"),
    args.get("channel") ?? "preview",
  );
  const attempts = Number(args.get("attempts") ?? 3);
  const timeoutSeconds = Number(args.get("timeout-seconds") ?? 300);
  if (
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 5 ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 3600
  ) {
    throw new DownloadError("invalid_download_limits");
  }
  const directory = assertInsideRepository(
    resolve(
      args.get("output") ??
        join(repositoryRoot, ".tools", "public-release", identity.version),
    ),
  );
  await mkdir(directory, { recursive: true });
  const receipt = {
    schemaVersion: 1,
    ...identity,
    startedAt: new Date().toISOString(),
    state: "incomplete",
    results: [],
    provenanceVerified: false,
  };
  const downloads = [];
  try {
    const release = await loadPublicRelease(identity, dependencies.fetcher);
    receipt.releaseId = release.id;
    receipt.url = release.url;
    const queue = [...release.assets];
    const worker = async () => {
      while (queue.length) {
        const asset = queue.shift();
        try {
          const result = await downloadAsset(asset, {
            ...identity,
            directory: join(directory, "downloads"),
            attempts,
            timeoutSeconds,
            ...(dependencies.run ? { run: dependencies.run } : {}),
          });
          downloads.push(result);
          const publicResult = { ...result };
          delete publicResult.path;
          receipt.results.push({ ...publicResult, state: "verified" });
          (dependencies.log ?? console.log)(
            `Verified: ${asset.name} (${result.source})`,
          );
        } catch (error) {
          receipt.results.push({
            name: asset.name,
            state: "failed",
            code:
              error instanceof DownloadError ? error.code : "local_io_error",
          });
        }
      }
    };
    await Promise.all([worker(), worker()]);
    if (downloads.length !== release.assets.length)
      throw new DownloadError("asset_downloads_incomplete");
    await verifyDownloadedRelease(identity, downloads);
    receipt.state = "passed";
  } catch (error) {
    receipt.error =
      error instanceof DownloadError ? error.code : "verification_failed";
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.results.sort((left, right) => left.name.localeCompare(right.name));
  const receiptPath = join(
    directory,
    `receipt-${Date.now()}-${randomUUID()}.json`,
  );
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
  });
  return { receipt, receiptPath };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { receipt, receiptPath } = await verifyPublicRelease();
    console.log(
      JSON.stringify({
        state: receipt.state,
        assets: receipt.results.length,
        receiptPath,
      }),
    );
    if (receipt.state !== "passed") process.exitCode = 1;
  } catch (error) {
    console.error(
      error instanceof DownloadError
        ? error.code
        : "public_verification_failed",
    );
    process.exitCode = 1;
  }
}
