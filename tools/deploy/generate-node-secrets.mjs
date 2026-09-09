import { Buffer } from "node:buffer";
import { randomBytes, webcrypto } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export async function generateNodeSecrets(output) {
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
    ONE_FETCH_AUDIT_SIGNING_PRIVATE_KEY:
      Buffer.from(privateKey).toString("base64"),
    ONE_FETCH_INSTANCE_PEPPER: randomBytes(32).toString("base64url"),
    ONE_FETCH_PROTOCOL_SIGNING_KEY: randomBytes(32).toString("base64url"),
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
  const result = await generateNodeSecrets(output);
  process.stdout.write(
    `Created ${result.output}. Import it through the service secret store and retain it for recovery.\n`,
  );
}
