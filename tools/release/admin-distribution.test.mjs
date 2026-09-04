import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import test from "node:test";

import { createDeterministicZip } from "./deterministic-zip.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("deterministic ZIP output is stable regardless of entry order", () => {
  const first = createDeterministicZip([
    { name: "index.html", data: "<main>one-fetch</main>" },
    { name: "assets/app.js", data: "export default 1;" },
  ]);
  const second = createDeterministicZip([
    { name: "assets/app.js", data: Buffer.from("export default 1;") },
    { name: "index.html", data: Buffer.from("<main>one-fetch</main>") },
  ]);
  assert.equal(digest(first), digest(second));
  assert.equal(first.readUInt32LE(0), 0x04034b50);
  assert.equal(first.readUInt32LE(first.length - 22), 0x06054b50);
});

test("deterministic ZIP writes the standard CRC-32 value", () => {
  const archive = createDeterministicZip([
    { name: "known.txt", data: "123456789" },
  ]);
  assert.equal(archive.readUInt32LE(14), 0xcbf43926);
});

test("deterministic ZIP rejects traversal, duplicate, and empty archives", () => {
  assert.throws(() => createDeterministicZip([]), /requires at least one/u);
  for (const name of ["../secret", "/root", "a\\b", "a//b", "a/./b"]) {
    assert.throws(
      () => createDeterministicZip([{ name, data: "x" }]),
      /Unsafe ZIP/u,
    );
  }
  assert.throws(
    () =>
      createDeterministicZip([
        { name: "index.html", data: "a" },
        { name: "index.html", data: "b" },
      ]),
    /unique/u,
  );
});
