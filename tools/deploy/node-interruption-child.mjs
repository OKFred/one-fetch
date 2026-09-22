// Test-only process harness. No barriers/hooks exist in the released helper.
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname } from "node:path";
import process from "node:process";
import { setInterval } from "node:timers";

process.once("message", async ({ helperUrl, operation, barrier, options }) => {
  const stopAtBarrier = async () => {
    process.send({ barrier });
    await new Promise(() => setInterval(() => {}, 1_000));
  };
  const rename = fs.rename;
  fs.rename = async (source, destination) => {
    await rename(source, destination);
    if (
      barrier === "pointer-written" &&
      basename(destination) === "current.json"
    )
      await stopAtBarrier();
    if (basename(dirname(destination)) === "journal") {
      const record = JSON.parse(await fs.readFile(destination, "utf8"));
      if (record.phase === barrier) await stopAtBarrier();
    }
  };
  syncBuiltinESMExports();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (barrier === "control-response-lost" && init?.method === "PUT")
      await stopAtBarrier();
    return response;
  };
  try {
    const helper = await import(helperUrl);
    const commands = {
      apply: helper.applyNodeDeployment,
      resume: helper.verifyNodeDeployment,
      rollback: helper.rollbackNodeDeployment,
    };
    await commands[operation](options);
    process.send({ unexpectedCompletion: true });
  } catch {
    process.send({ unexpectedFailure: true });
  }
  process.exit(1);
});
