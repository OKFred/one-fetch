import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function emitBootstrapToken(
  token: string,
  outputFile = process.env.ONE_FETCH_BOOTSTRAP_TOKEN_FILE?.trim(),
  log: (message: string) => void = console.log,
): Promise<void> {
  if (!outputFile) {
    log("One-time bootstrap token (not recoverable after this output):");
    log(token);
    return;
  }

  const destination = resolve(outputFile);
  await writeFile(destination, `${token}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  if (process.platform !== "win32") await chmod(destination, 0o600);
  log(`One-time bootstrap token written to ${destination}`);
}
