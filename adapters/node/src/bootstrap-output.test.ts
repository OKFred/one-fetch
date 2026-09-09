import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { emitBootstrapToken } from "./bootstrap-output.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("bootstrap token output", () => {
  it("writes a private token file without logging the token", async () => {
    const root = await mkdtemp(join(tmpdir(), "one-fetch-bootstrap-"));
    temporaryDirectories.push(root);
    const destination = join(root, "bootstrap-token");
    const messages: string[] = [];
    await emitBootstrapToken("sensitive-bootstrap-token", destination, (text) =>
      messages.push(text),
    );
    expect(await readFile(destination, "utf8")).toBe(
      "sensitive-bootstrap-token\n",
    );
    expect(messages).toEqual([
      `One-time bootstrap token written to ${resolve(destination)}`,
    ]);
    expect(messages.join(" ")).not.toContain("sensitive-bootstrap-token");
    await expect(
      emitBootstrapToken("replacement", destination, () => undefined),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("keeps interactive stdout behavior when no file is configured", async () => {
    const messages: string[] = [];
    await emitBootstrapToken("interactive-token", undefined, (text) =>
      messages.push(text),
    );
    expect(messages).toEqual([
      "One-time bootstrap token (not recoverable after this output):",
      "interactive-token",
    ]);
  });
});
