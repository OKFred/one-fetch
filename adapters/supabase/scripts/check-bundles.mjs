import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const denoCli = require.resolve("deno/bin.cjs");
const adapterRoot = resolve(import.meta.dirname, "..");
const functionsRoot = join(adapterRoot, "supabase", "functions");
const functionNames = ["one-fetch-control", "one-fetch-gateway"];
const maxBundleBytes = 10 * 1024 * 1024;
const buildVersionMarker = "__ONE_FETCH_BUILD_VERSION__";
const previewBuildVersion = "0.1.0-preview";

export function parseBundleOptions(argv) {
  const modeArgument = argv[0];
  if (!["--check", "--stage"].includes(modeArgument)) {
    throw new Error(
      "Usage: node scripts/check-bundles.mjs --check|--stage [--build-id <id>]",
    );
  }
  let buildVersion = previewBuildVersion;
  if (argv.length > 1) {
    if (
      modeArgument !== "--stage" ||
      argv.length !== 3 ||
      argv[1] !== "--build-id" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+supabase\.g[a-f0-9]{12}$/u.test(
        argv[2] ?? "",
      )
    ) {
      throw new Error(
        "Usage: node scripts/check-bundles.mjs --check|--stage [--build-id <id>]",
      );
    }
    buildVersion = argv[2];
  }
  return { mode: modeArgument.slice(2), buildVersion };
}

export function parseMode(argv) {
  return parseBundleOptions(argv).mode;
}

export function injectBuildVersion(source, buildVersion) {
  const occurrences = source.split(buildVersionMarker).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Function bundle must contain exactly one build marker, found ${occurrences}`,
    );
  }
  return source.replace(buildVersionMarker, buildVersion);
}

export function inspectBundle(source, functionName) {
  const bytes = Buffer.byteLength(source);
  if (bytes === 0 || bytes > maxBundleBytes) {
    throw new Error(`${functionName} bundle has an invalid size: ${bytes}`);
  }
  if (!/export\s*\{[^}]*\bas\s+default\b[^}]*\}/u.test(source)) {
    throw new Error(`${functionName} bundle does not export a default handler`);
  }

  const imports = [
    ...source.matchAll(
      /^(?:import|export)\s+(?:[^"'\r\n]*?\s+from\s+)?["']([^"'\r\n]+)["'];?\s*$/gmu,
    ),
  ].map((match) => match[1]);
  const unsupported = imports.filter(
    (specifier) => specifier !== undefined && !specifier.startsWith("node:"),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `${functionName} bundle retained external imports: ${unsupported.join(", ")}`,
    );
  }

  return {
    bytes,
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}

export function inspectModuleGraph(graph, rootUrl, functionName) {
  const normalizeSpecifier = (specifier) =>
    process.platform === "win32" ? specifier.toLowerCase() : specifier;
  const normalizedRootUrl = normalizeSpecifier(rootUrl);
  const errors = graph.modules
    .filter((module) => "error" in module)
    .map((module) => module.error);
  const dependencies = graph.modules
    .map((module) => module.specifier)
    .filter(
      (specifier) =>
        normalizeSpecifier(specifier) !== normalizedRootUrl &&
        !specifier.startsWith("node:"),
    );
  if (
    errors.length > 0 ||
    dependencies.length > 0 ||
    Object.keys(graph.npmPackages ?? {}).length > 0
  ) {
    throw new Error(
      `${functionName} bundle is not self-contained: ${[
        ...errors,
        ...dependencies,
      ].join(", ")}`,
    );
  }
}

function runDeno(arguments_, functionName) {
  const result = spawnSync(process.execPath, [denoCli, ...arguments_], {
    cwd: adapterRoot,
    encoding: "utf8",
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${functionName} generated bundle validation failed`);
  }
  return result.stdout;
}

function validateBundle(outputPath, functionName) {
  const outputUrl = pathToFileURL(outputPath).href;
  runDeno(["check", "--no-config", outputUrl], functionName);
  const graph = JSON.parse(
    runDeno(["info", "--json", "--no-config", outputUrl], functionName),
  );
  inspectModuleGraph(graph, outputUrl, functionName);
}

function bundleFunction(functionName, outputPath) {
  const functionRoot = join(functionsRoot, functionName);
  const result = spawnSync(
    process.execPath,
    [
      denoCli,
      "bundle",
      "--frozen-lockfile",
      "--no-check",
      "--platform=deno",
      "--packages=bundle",
      "--inline-imports=true",
      "--format=esm",
      "--config",
      join(functionRoot, "deno.json"),
      "--output",
      outputPath,
      join(functionRoot, "index.ts"),
    ],
    { cwd: adapterRoot, encoding: "utf8" },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${functionName} bundle failed`);
  }
}

async function stageBundle(functionName, sourcePath, details) {
  const bundleRoot = join(functionsRoot, functionName, ".one-fetch-bundle");
  await mkdir(bundleRoot, { recursive: true });
  await copyFile(sourcePath, join(bundleRoot, "index.js"));
  await writeFile(
    join(bundleRoot, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        functionName,
        entrypoint: "index.ts",
        bundle: "index.js",
        ...details,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export async function buildBundles(mode, buildVersion = previewBuildVersion) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "one-fetch-supabase-"));
  try {
    const outputs = [];
    for (const functionName of functionNames) {
      const outputPath = join(temporaryRoot, `${functionName}.js`);
      bundleFunction(functionName, outputPath);
      const source = injectBuildVersion(
        await readFile(outputPath, "utf8"),
        buildVersion,
      );
      await writeFile(outputPath, source, "utf8");
      validateBundle(outputPath, functionName);
      outputs.push({
        functionName,
        outputPath,
        details: { ...inspectBundle(source, functionName), buildVersion },
      });
    }

    if (mode === "stage") {
      for (const output of outputs) {
        await stageBundle(
          output.functionName,
          output.outputPath,
          output.details,
        );
      }
    }
    return outputs.map(({ functionName, details }) => ({
      functionName,
      ...details,
    }));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) {
  const { mode, buildVersion } = parseBundleOptions(process.argv.slice(2));
  const outputs = await buildBundles(mode, buildVersion);
  for (const output of outputs) {
    console.log(
      `${mode === "stage" ? "Staged" : "Checked"} ${output.functionName}: ${output.bytes} bytes, sha256 ${output.sha256}`,
    );
  }
}
