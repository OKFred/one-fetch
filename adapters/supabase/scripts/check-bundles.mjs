import { spawnSync } from "node:child_process";
import console from "node:console";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const denoCli = require.resolve("deno/bin.cjs");
const adapterRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "one-fetch-supabase-"));

const functions = ["one-fetch-control", "one-fetch-gateway"];
try {
  for (const functionName of functions) {
    const functionRoot = join(
      adapterRoot,
      "supabase",
      "functions",
      functionName,
    );
    const result = spawnSync(
      process.execPath,
      [
        denoCli,
        "bundle",
        "--frozen-lockfile",
        "--no-check",
        "--platform=deno",
        "--config",
        join(functionRoot, "deno.json"),
        "--outdir",
        join(temporaryRoot, functionName),
        join(functionRoot, "index.ts"),
      ],
      { cwd: adapterRoot, encoding: "utf8" },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
      throw new Error(`${functionName} bundle preflight failed`);
    }
  }
  console.log("Supabase Edge Function bundle preflight passed");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
