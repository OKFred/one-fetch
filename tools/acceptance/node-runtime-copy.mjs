import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";

export const runtimeBootstrapScript =
  'const fs=require("node:fs");const timer=setInterval(()=>{if(fs.existsSync("/tmp/acceptance/ready")){clearInterval(timer);import("/tmp/acceptance/runtime-entry.mjs").catch(()=>{process.exitCode=1})}},50)';

// Static receiver: only stdin bytes reach a fixed, private container directory.
// No shell, host bind mounts, credential files, or root staging process.
const receiveScript =
  'const fs=require("node:fs"),p=require("node:path"),crypto=require("node:crypto");(async()=>{const file=process.argv[1];fs.mkdirSync(p.dirname(file),{recursive:true,mode:0o700});await require("node:stream/promises").pipeline(process.stdin,fs.createWriteStream(file,{flags:"wx",mode:0o600}));const hash=crypto.createHash("sha256");let bytes=0;for await(const chunk of fs.createReadStream(file)){bytes+=chunk.length;hash.update(chunk)}process.stdout.write(JSON.stringify({bytes,sha256:hash.digest("hex")}))})().catch(()=>{process.exitCode=1})';

export function assertRuntimeCopyTarget(id, target) {
  assert.match(id, /^[a-f0-9]{64}$/u);
  assert.match(target, /^\/tmp\/acceptance\/[a-zA-Z0-9/._-]+$/u);
  assert.ok(target.split("/").every((part) => part !== "." && part !== ".."));
  assert.ok(!target.endsWith("/") && !target.includes("//"));
}

export async function copyRuntimeFile(id, source, target, expectedSha256) {
  assertRuntimeCopyTarget(id, target);
  const details = await lstat(source);
  assert.ok(details.isFile() && !details.isSymbolicLink());
  assert.ok(details.size > 0 && details.size <= 32 * 1024 * 1024);
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(source)) hash.update(bytes);
  const sha256 = hash.digest("hex");
  if (expectedSha256 !== undefined) assert.equal(sha256, expectedSha256);
  const child = spawn(
    "docker",
    [
      "container",
      "exec",
      "--interactive",
      id,
      "node",
      "-e",
      receiveScript,
      target,
    ],
    {
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 120_000,
      windowsHide: true,
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text) => {
    output += text;
    if (output.length > 4096) child.kill();
  });
  const completed = new Promise((accept, reject) => {
    child.once("error", () => reject(new Error("Container copy failed")));
    child.once("close", (code) =>
      code === 0 ? accept() : reject(new Error("Container copy failed")),
    );
  });
  try {
    await Promise.all([
      pipeline(createReadStream(source), child.stdin),
      completed,
    ]);
    assert.deepEqual(JSON.parse(output), { bytes: details.size, sha256 });
  } catch {
    child.kill();
    throw new Error("Container copy integrity check failed");
  }
  return { target, bytes: details.size, sha256 };
}

export async function stageRuntimeFiles(
  id,
  options,
  input,
  repository,
  copy = copyRuntimeFile,
) {
  const files = [
    [
      resolve(repository, "tools/acceptance/target-server.mjs"),
      "fixture/tools/acceptance/target-server.mjs",
    ],
    [
      resolve(repository, "packages/conformance/dist/target.js"),
      "fixture/packages/conformance/dist/target.js",
    ],
  ];
  if (options.mode !== "oci") {
    files.push(
      [input.archive.path, "artifact.tar.gz", input.archive.sha256],
      [
        resolve(repository, "tools/acceptance/node-container-entry.mjs"),
        "runtime-entry.mjs",
      ],
    );
  }
  if (options.mode === "installed") {
    files.push(
      [input.deploy.path, "deployment.mjs", input.deploy.sha256],
      [
        resolve(repository, "tools/acceptance/node-install-entry.mjs"),
        "install-entry.mjs",
      ],
      [
        resolve(repository, "tools/acceptance/node-installed-check.mjs"),
        "installed-check.mjs",
      ],
    );
  }
  const copied = [];
  for (const [source, destination, sha256] of files)
    copied.push(
      await copy(id, source, `/tmp/acceptance/${destination}`, sha256),
    );
  return copied;
}
