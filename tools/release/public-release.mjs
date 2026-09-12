import { readFile } from "node:fs/promises";

import { requiredReviewArtifactFilenames } from "./finalize-review-bundle.mjs";
import { DownloadError, validateAsset } from "./public-download.mjs";

export function publicReleaseIdentity(repository, version, commit, channel) {
  if (
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version) ||
    !/^[0-9a-f]{40}$/u.test(commit) ||
    !["preview", "stable"].includes(channel)
  ) {
    throw new DownloadError("invalid_release_identity");
  }
  return { repository, version, commit, channel };
}

export async function readPublicApi(path, fetcher = globalThis.fetch) {
  let response;
  try {
    response = await fetcher(`https://api.github.com${path}`, {
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: globalThis.AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DownloadError(`github_http_${response.status}`);
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 2 * 1024 ** 2)
        throw new DownloadError("github_metadata_too_large");
      chunks.push(chunk);
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new globalThis.TextDecoder().decode(buffer));
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    throw new DownloadError("github_metadata_unavailable");
  }
}

export async function loadPublicRelease(identity, fetcher) {
  const { repository, version, commit, channel } = publicReleaseIdentity(
    identity.repository,
    identity.version,
    identity.commit,
    identity.channel,
  );
  const base = `/repos/${repository}`;
  const release = await readPublicApi(
    `${base}/releases/tags/v${version}`,
    fetcher,
  );
  if (
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.draft !== false ||
    release.prerelease !== (channel === "preview") ||
    release.tag_name !== `v${version}` ||
    typeof release.published_at !== "string" ||
    release.html_url !==
      `https://github.com/${repository}/releases/tag/v${version}`
  ) {
    throw new DownloadError("release_identity_mismatch");
  }
  const ref = await readPublicApi(`${base}/git/ref/tags/v${version}`, fetcher);
  if (ref.object?.type !== "tag" || !/^[0-9a-f]{40}$/u.test(ref.object.sha)) {
    throw new DownloadError("annotated_tag_required");
  }
  const tag = await readPublicApi(
    `${base}/git/tags/${ref.object.sha}`,
    fetcher,
  );
  if (
    tag.tag !== `v${version}` ||
    tag.object?.type !== "commit" ||
    tag.object.sha !== commit
  ) {
    throw new DownloadError("tag_commit_mismatch");
  }
  const assets = await readPublicApi(
    `${base}/releases/${release.id}/assets?per_page=100`,
    fetcher,
  );
  if (!Array.isArray(assets) || assets.length === 0 || assets.length >= 100) {
    throw new DownloadError("unsupported_asset_count");
  }
  const names = new Set();
  const ids = new Set();
  for (const asset of assets) {
    validateAsset(asset, repository, version);
    if (names.has(asset.name.toLowerCase()) || ids.has(asset.id))
      throw new DownloadError("duplicate_asset");
    names.add(asset.name.toLowerCase());
    ids.add(asset.id);
  }
  for (const filename of [
    ...requiredReviewArtifactFilenames(version, {
      requireOci: true,
      requireOciSbom: true,
      requireSbom: true,
    }),
    `one-fetch-release-manifest-${version}.json`,
    "SHA256SUMS",
    "SHA512SUMS",
  ]) {
    if (!names.has(filename.toLowerCase()))
      throw new DownloadError("missing_release_asset");
  }
  return {
    id: release.id,
    url: release.html_url,
    publishedAt: release.published_at,
    assets,
  };
}

export function parseChecksums(text, width) {
  const result = new Map();
  for (const line of text.trim().split(/\r?\n/u)) {
    const match = new RegExp(
      `^([0-9a-f]{${width}})  ([A-Za-z0-9][A-Za-z0-9._-]{0,179})$`,
      "u",
    ).exec(line);
    if (!match || result.has(match[2]))
      throw new DownloadError("invalid_checksum_file");
    result.set(match[2], match[1]);
  }
  return result;
}

export async function verifyDownloadedRelease(identity, downloads) {
  const files = new Map(downloads.map((result) => [result.name, result]));
  const read = async (name) => {
    const file = files.get(name);
    if (!file || file.bytes > 2 * 1024 ** 2)
      throw new DownloadError("invalid_release_document");
    return readFile(file.path, "utf8");
  };
  const manifest = JSON.parse(
    await read(`one-fetch-release-manifest-${identity.version}.json`),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.protocolVersion !== 1 ||
    manifest.version !== identity.version ||
    manifest.channel !== identity.channel ||
    manifest.source?.commit !== identity.commit ||
    manifest.source.dirty !== false ||
    manifest.source.repository !==
      `https://github.com/${identity.repository}` ||
    !Array.isArray(manifest.artifacts)
  )
    throw new DownloadError("manifest_identity_mismatch");
  const names = new Set();
  for (const entry of manifest.artifacts) {
    const result = files.get(entry.name);
    if (
      names.has(entry.name) ||
      !result ||
      result.bytes !== entry.bytes ||
      result.sha256 !== entry.sha256 ||
      result.sha512 !== entry.sha512
    ) {
      throw new DownloadError("manifest_artifact_mismatch");
    }
    names.add(entry.name);
  }
  for (const filename of requiredReviewArtifactFilenames(identity.version, {
    requireOci: true,
    requireOciSbom: true,
    requireSbom: true,
  }))
    if (!names.has(filename))
      throw new DownloadError("manifest_missing_artifact");
  const checksumNames = [];
  for (const [algorithm, width] of [
    ["sha256", 64],
    ["sha512", 128],
  ]) {
    const sums = parseChecksums(
      await read(`${algorithm.toUpperCase()}SUMS`),
      width,
    );
    for (const [name, digest] of sums) {
      if (files.get(name)?.[algorithm] !== digest)
        throw new DownloadError("checksum_mismatch");
    }
    for (const name of [
      ...names,
      `one-fetch-release-manifest-${identity.version}.json`,
    ]) {
      if (!sums.has(name)) throw new DownloadError("missing_checksum");
    }
    checksumNames.push([...sums.keys()].sort().join("\n"));
  }
  if (checksumNames[0] !== checksumNames[1])
    throw new DownloadError("checksum_inventory_mismatch");
  if (files.has("SUPPLEMENT-SHA256SUMS")) {
    for (const [name, hash] of parseChecksums(
      await read("SUPPLEMENT-SHA256SUMS"),
      64,
    )) {
      if (files.get(name)?.sha256 !== hash)
        throw new DownloadError("supplement_checksum_mismatch");
    }
  }
}
