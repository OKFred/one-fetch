import { build } from "esbuild";
import { dirname, resolve } from "node:path";

// Keep the release helper standalone while maintaining small source modules.
export async function bundleNodeDeploymentHelper(entrypoint, outfile) {
  await build({
    absWorkingDir: dirname(resolve(entrypoint)),
    entryPoints: [resolve(entrypoint)],
    outfile: resolve(outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
    charset: "utf8",
  });
}
