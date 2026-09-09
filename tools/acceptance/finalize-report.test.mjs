import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { finalizeAcceptanceReport } from "./finalize-report.mjs";

function pendingReport(resources) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-10T00:00:00.000Z",
    commit: "a".repeat(40),
    adapter: "cloudflare",
    buildVersion: "0.1.0+cloudflare.gaaaaaaaaaaaa",
    protocolVersion: 1,
    instanceId: "instance-1",
    configVersion: "config-1",
    capabilitiesSha256: "b".repeat(64),
    endpoints: {
      controlOrigin: "https://control.example",
      gatewayOrigin: "https://gateway.example",
      targetOrigin: "https://target.example",
    },
    suite: { passed: true, results: [] },
    cleanup: { state: "pending", resources },
  };
}

test("cleanup verification requires the exact recorded resource set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-fetch-acceptance-"));
  try {
    const input = join(directory, "pending.json");
    const output = join(directory, "verified.json");
    await writeFile(
      input,
      JSON.stringify(pendingReport([{ kind: "worker", id: "fixture-1" }])),
    );
    await assert.rejects(
      finalizeAcceptanceReport({ input, output, absent: [] }),
      /exactly match/u,
    );
    const result = await finalizeAcceptanceReport({
      input,
      output,
      absent: [{ kind: "worker", id: "fixture-1" }],
      notApplicable: false,
    });
    assert.equal(result.report.cleanup.state, "verified");
    assert.equal(
      JSON.parse(await readFile(output, "utf8")).cleanup.state,
      "verified",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resource-free reports require an explicit not-applicable decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-fetch-acceptance-"));
  try {
    const input = join(directory, "pending.json");
    const output = join(directory, "final.json");
    await writeFile(input, JSON.stringify(pendingReport([])));
    await assert.rejects(
      finalizeAcceptanceReport({ input, output, absent: [] }),
      /--not-applicable/u,
    );
    const result = await finalizeAcceptanceReport({
      input,
      output,
      absent: [],
      notApplicable: true,
    });
    assert.equal(result.report.cleanup.state, "not-applicable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
