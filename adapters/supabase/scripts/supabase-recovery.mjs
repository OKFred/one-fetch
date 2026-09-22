import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deploymentFunctionSlugs } from "./deploy-support.mjs";

export async function hashRecoveryTree(root) {
  const details = await lstat(root);
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error("Recovery root must be a regular directory");
  const hash = createHash("sha256");
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Recovery source cannot contain symbolic links");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        const relativePath = path.slice(root.length).replaceAll("\\", "/");
        hash.update(JSON.stringify([relativePath, bytes.byteLength]));
        hash.update(bytes);
      } else throw new Error("Recovery source contains an unsupported entry");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

export async function capturePriorFunctions(
  runPnpm,
  projectRef,
  statePath,
  runId,
) {
  const root = join(dirname(statePath), `recovery-${runId}`);
  await mkdir(join(root, "supabase"), { recursive: true });
  await writeFile(
    join(root, "supabase", "config.toml"),
    `project_id = "one-fetch-recovery"\n\n[functions.one-fetch-control]\nverify_jwt = false\nentrypoint = "./functions/one-fetch-control/index.js"\n\n[functions.one-fetch-gateway]\nverify_jwt = false\nentrypoint = "./functions/one-fetch-gateway/index.js"\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  for (const slug of deploymentFunctionSlugs) {
    await runPnpm(
      [
        "exec",
        "supabase",
        "functions",
        "download",
        slug,
        "--project-ref",
        projectRef,
        "--use-api",
        "--workdir",
        root,
      ],
      { label: `download prior ${slug}` },
    );
  }
  return { root, sha256: await hashRecoveryTree(root) };
}

async function restorePriorFunctions(context, recovery) {
  if (!recovery || (await hashRecoveryTree(recovery.root)) !== recovery.sha256)
    throw new Error("Recovery source checksum mismatch");
  for (const slug of deploymentFunctionSlugs) {
    await context.renewRecoveryLease();
    await context.runPnpm(
      [
        "exec",
        "supabase",
        "functions",
        "deploy",
        slug,
        "--project-ref",
        context.options.projectRef,
        "--no-verify-jwt",
        "--use-api",
        "--workdir",
        recovery.root,
      ],
      { label: `restore prior ${slug}` },
    );
  }
}

export async function tryRecovery(context, attempted, recovery, completed) {
  const result = {
    functionRollbackAttempted: false,
    functionRollbackSucceeded: false,
  };
  if (completed || attempted.length === 0) return result;
  result.functionRollbackAttempted = true;
  try {
    if (context.options.expectedCurrentBuild === "none") {
      for (const slug of [...attempted].reverse()) {
        await context.renewRecoveryLease();
        await context.runPnpm(
          [
            "exec",
            "supabase",
            "functions",
            "delete",
            slug,
            "--project-ref",
            context.options.projectRef,
            "--workdir",
            context.databaseLink.workdir,
            "--yes",
          ],
          { label: `remove partial ${slug}` },
        );
      }
      const remaining = await context.functionList();
      if (deploymentFunctionSlugs.some((slug) => remaining.has(slug)))
        throw new Error("Partial Function deletion was not confirmed");
      result.functionAbsenceVerified = true;
    } else {
      await restorePriorFunctions(context, recovery);
      const runtime = await context.inspectCurrent();
      if (runtime.buildId !== context.options.expectedCurrentBuild)
        throw new Error(
          "Recovered Control/Gateway build does not match prior build",
        );
      await context.confirmPaused();
      result.recoveredBuildId = runtime.buildId;
      result.gatewayPauseVerified = true;
    }
    result.functionRollbackSucceeded = true;
  } catch (error) {
    result.functionRollbackError =
      error instanceof Error ? error.message : "unknown";
  }
  return result;
}
