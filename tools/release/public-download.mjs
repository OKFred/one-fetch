import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

export class DownloadError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function requireCurlVersion(output) {
  const match = /^curl (\d+)\.(\d+)\.(\d+)\b/u.exec(output);
  if (
    !match ||
    Number(match[1]) < 8 ||
    (Number(match[1]) === 8 && Number(match[2]) < 4) ||
    !/^Protocols:.*\bhttps\b/mu.test(output)
  ) {
    throw new DownloadError("curl_8_4_https_required");
  }
}

let curlChecked = false;

export function validateAsset(asset, repository, version) {
  if (
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version) ||
    !Number.isSafeInteger(asset?.id) ||
    asset.id <= 0 ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > 4 * 1024 ** 3 ||
    typeof asset.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/u.test(asset.name) ||
    asset.name.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(asset.name) ||
    !/^sha256:[0-9a-f]{64}$/u.test(asset.digest) ||
    asset.state !== "uploaded" ||
    asset.browser_download_url !==
      `https://github.com/${repository}/releases/download/v${version}/${asset.name}`
  )
    throw new DownloadError("invalid_asset_metadata");
  return asset;
}

export async function hashFile(path) {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return { bytes, sha256: sha256.digest("hex"), sha512: sha512.digest("hex") };
}

async function fileSize(path) {
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info && (!info.isFile() || info.nlink !== 1)) {
    throw new DownloadError("unsafe_cache_file");
  }
  return info?.size;
}

export function curlArguments(asset, destination, timeoutSeconds) {
  return [
    "--disable",
    "--location",
    "--fail",
    "--silent",
    "--globoff",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--max-redirs",
    "5",
    "--connect-timeout",
    "20",
    "--max-time",
    String(timeoutSeconds),
    "--max-filesize",
    String(asset.size),
    "--continue-at",
    "-",
    "--output",
    destination,
    "--url",
    asset.browser_download_url,
  ];
}

export async function runCurl(args) {
  const command = process.platform === "win32" ? "curl.exe" : "curl";
  if (!curlChecked) {
    const probe = spawnSync(command, ["--disable", "--version"], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    if (probe.error || probe.status !== 0)
      throw new DownloadError("curl_unavailable");
    requireCurlVersion(probe.stdout);
    curlChecked = true;
  }
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    // Never forward curl stderr: redirect URLs may contain temporary credentials.
    child.once("error", () => reject(new DownloadError("curl_unavailable")));
    child.once("close", (code) => resolveExit(code ?? -1));
  });
}

export async function downloadAsset(asset, options) {
  const {
    directory,
    repository,
    version,
    run = runCurl,
    attempts = 3,
    timeoutSeconds = 300,
  } = options;
  validateAsset(asset, repository, version);
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
  const cache = join(
    resolve(directory),
    `${asset.id}-${asset.digest.slice(7)}`,
  );
  await mkdir(cache, { recursive: true });
  if ((await lstat(cache)).isSymbolicLink())
    throw new DownloadError("unsafe_cache_directory");
  const path = join(cache, asset.name);
  const partial = `${path}.part`;
  const lockPath = join(cache, "download.lock");
  const lock = await open(lockPath, "wx").catch(() => {
    throw new DownloadError("cache_locked");
  });
  let attemptsUsed = 0;
  let resumedBytes = 0;
  try {
    const cached = (await fileSize(path)) !== undefined;
    if (!cached) {
      resumedBytes = (await fileSize(partial)) ?? 0;
      if (resumedBytes > asset.size) throw new DownloadError("size_mismatch");
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if ((await fileSize(partial)) === asset.size) break;
        attemptsUsed += 1;
        const code = await run(curlArguments(asset, partial, timeoutSeconds));
        const size = (await fileSize(partial)) ?? 0;
        if (size > asset.size) throw new DownloadError("size_mismatch");
        if (code === 0 && size === asset.size) break;
        if (
          ![0, 6, 7, 18, 28, 52, 55, 56, 92].includes(code) ||
          attempt === attempts
        ) {
          throw new DownloadError(`download_failed_curl_${code}`);
        }
      }
    }
    const hashes = await hashFile(cached ? path : partial);
    if (hashes.bytes !== asset.size) throw new DownloadError("size_mismatch");
    if (`sha256:${hashes.sha256}` !== asset.digest)
      throw new DownloadError("digest_mismatch");
    if (!cached) await rename(partial, path);
    return {
      name: asset.name,
      ...hashes,
      attempts: attemptsUsed,
      resumedBytes,
      source: attemptsUsed > 0 ? "anonymous-download" : "verified-cache",
      path,
    };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
