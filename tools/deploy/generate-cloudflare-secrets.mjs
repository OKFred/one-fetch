import { Buffer } from "node:buffer";
import { randomBytes, webcrypto } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export async function generateCloudflareSecrets(output) {
  if (typeof output !== "string" || output.length === 0)
    throw new Error("A secrets output path is required");
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in keyPair))
    throw new Error("Ed25519 key generation did not return a key pair");
  const privateKey = await webcrypto.subtle.exportKey(
    "pkcs8",
    keyPair.privateKey,
  );
  const secrets = {
    AUDIT_SIGNING_KEY: base64url(privateKey),
    BOOTSTRAP_SECRET: base64url(randomBytes(32)),
    ENCRYPTION_KEY: base64url(randomBytes(32)),
    INSTANCE_PEPPER: base64url(randomBytes(32)),
  };
  const outputPath = resolve(output);
  await writeFile(outputPath, `${JSON.stringify(secrets, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  if (process.platform !== "win32") await chmod(outputPath, 0o600);
  return { output: outputPath, secrets };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const index = process.argv.indexOf("--output");
  const output = index < 0 ? undefined : process.argv[index + 1];
  const result = await generateCloudflareSecrets(output);
  process.stdout.write(
    `Created ${result.output}. It contains secrets and must be deleted after deployment.\n`,
  );
}
