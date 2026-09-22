import { build } from "esbuild";

// Keep the release helper standalone while maintaining small source modules.
export async function bundleNodeDeploymentHelper(entrypoint, outfile) {
  await build({
    entryPoints: [entrypoint],
    outfile,
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
