import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRuntimeImage,
  loopbackPublishedOrigin,
  parseRuntimeArguments,
} from "./node-artifact-input.mjs";
import { removeOwnedRuntimeContainer } from "./node-artifact-runtime.mjs";
import { assertNoRuntimeSecrets } from "./node-runtime-session.mjs";

const commit = "a".repeat(40);
const image = "sha256:" + "b".repeat(64);
const arguments_ = [
  "--directory",
  "/fixture/review",
  "--commit",
  commit,
  "--version",
  "0.1.0",
  "--image",
  image,
  "--platform",
  "linux/amd64",
  "--mode",
  "oci",
  "--output",
  "/fixture/report.json",
];

test("runtime acceptance requires exact identities and explicit safe modes", () => {
  assert.equal(parseRuntimeArguments(arguments_).image, image);
  assert.equal(
    parseRuntimeArguments(
      arguments_.map((value) => (value === "oci" ? "installed" : value)),
    ).mode,
    "installed",
  );
  for (const args of [
    arguments_.slice(0, -2),
    [...arguments_, "--image", image],
    [...arguments_, "--token", "private"],
    arguments_.map((v) => (v === image ? "node:latest" : v)),
    arguments_.map((v) => (v === "linux/amd64" ? "windows/amd64" : v)),
    arguments_.map((v) => (v === "oci" ? "production" : v)),
  ]) {
    assert.throws(() => parseRuntimeArguments(args));
  }
});

test("published service ports must be unambiguous and loopback-only", () => {
  assert.equal(
    loopbackPublishedOrigin("127.0.0.1:23456\n"),
    "http://127.0.0.1:23456",
  );
  for (const value of [
    "0.0.0.0:23456",
    "[::]:23456",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1:123\n127.0.0.1:456",
  ])
    assert.throws(() => loopbackPublishedOrigin(value));
});

test("loaded images must match the reviewed revision, version, source and user", () => {
  const labels = {
    "org.opencontainers.image.revision": commit,
    "org.opencontainers.image.version": "0.1.0",
    "org.opencontainers.image.source": "https://github.com/OKFred/one-fetch",
  };
  assert.doesNotThrow(() =>
    assertRuntimeImage(labels, { commit, version: "0.1.0" }, "node"),
  );
  assert.throws(() =>
    assertRuntimeImage(labels, { commit, version: "0.1.0" }, "root"),
  );
  assert.throws(() =>
    assertRuntimeImage(
      { ...labels, "org.opencontainers.image.revision": "c".repeat(40) },
      { commit, version: "0.1.0" },
      "node",
    ),
  );
});

test("cleanup finds an ambiguously created container, validates ownership, then confirms absence", async () => {
  const commands = [];
  let exists = true;
  const id = "a".repeat(64);
  const result = await removeOwnedRuntimeContainer(
    async (args) => {
      commands.push(args);
      if (args[1] === "ls") return exists ? id : "";
      if (args[1] === "inspect")
        return JSON.stringify({ "one-fetch.acceptance-run": "owned" });
      if (args[1] === "rm") {
        exists = false;
        return id;
      }
      throw new Error("Unexpected command");
    },
    "one-fetch-artifact-example",
    "owned",
  );
  assert.equal(result.containerAbsent, true);
  assert.deepEqual(
    commands.find((args) => args[1] === "rm"),
    ["container", "rm", "--force", "--volumes", id],
  );
  assert.equal(commands.filter((args) => args[1] === "ls").length, 2);
});

for (const failure of [
  "foreign-owner",
  "ambiguous-id",
  "still-present",
  "inventory-failure",
]) {
  test(`cleanup does not claim absence after ${failure}`, async () => {
    const commands = [];
    await assert.rejects(
      removeOwnedRuntimeContainer(
        async (args) => {
          commands.push(args);
          if (failure === "inventory-failure") throw new Error("unavailable");
          if (args[1] === "ls")
            return failure === "ambiguous-id" ? "a\nb" : "a".repeat(64);
          if (args[1] === "inspect")
            return JSON.stringify({
              "one-fetch.acceptance-run":
                failure === "foreign-owner" ? "other" : "owned",
            });
          return "";
        },
        "one-fetch-artifact-example",
        "owned",
      ),
    );
    if (failure !== "still-present")
      assert.equal(
        commands.some((args) => args[1] === "rm"),
        false,
      );
  });
}

test("runtime report refuses secret canaries without echoing their values", () => {
  assert.doesNotThrow(() =>
    assertNoRuntimeSecrets({ passed: true }, ["private-value"]),
  );
  assert.throws(
    () =>
      assertNoRuntimeSecrets({ nested: { leak: "private-value" } }, [
        "private-value",
      ]),
    (error) => !error.message.includes("private-value"),
  );
});
