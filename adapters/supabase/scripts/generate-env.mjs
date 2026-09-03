import { Buffer } from "node:buffer";
import { randomBytes, randomUUID, webcrypto } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

const output = option("--out");
const projectRef = option("--project-ref");
const extensionId = option("--extension-id");
const adminOrigin = option("--admin-origin") ?? "http://localhost:5173";
if (!output || !projectRef || !/^[a-z0-9]{20}$/u.test(projectRef)) {
  globalThis.console.error(
    "Usage: node scripts/generate-env.mjs --out <path> --project-ref <20-char-ref> [--extension-id <id>] [--admin-origin <origin>]",
  );
  process.exit(2);
}
if (extensionId && !/^[a-p]{32}$/u.test(extensionId)) {
  globalThis.console.error(
    "Chrome extension IDs contain exactly 32 lowercase a-p characters.",
  );
  process.exit(2);
}

const keyPair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
]);
if (!("privateKey" in keyPair))
  throw new Error("Ed25519 key generation did not return a key pair");
const privateKey = await webcrypto.subtle.exportKey(
  "pkcs8",
  keyPair.privateKey,
);
const publicKey = await webcrypto.subtle.exportKey("spki", keyPair.publicKey);
const base = `https://${projectRef}.supabase.co/functions/v1`;
const lines = [
  `ONE_FETCH_INSTANCE_ID=${randomUUID()}`,
  `ONE_FETCH_BOOTSTRAP_SECRET=${base64url(randomBytes(32))}`,
  `ONE_FETCH_PEPPER=${base64url(randomBytes(32))}`,
  `ONE_FETCH_AUDIT_SIGNING_PRIVATE_KEY=${base64url(privateKey)}`,
  `ONE_FETCH_AUDIT_VERIFYING_PUBLIC_KEY=${base64url(publicKey)}`,
  `ONE_FETCH_AUDIT_KEY_ID=audit-${new Date().toISOString().slice(0, 10)}`,
  `ONE_FETCH_ALLOWED_ADMIN_ORIGINS=${new URL(adminOrigin).origin}`,
  `ONE_FETCH_ALLOWED_CLIENT_ORIGINS=${extensionId ? `chrome-extension://${extensionId}` : ""}`,
  `ONE_FETCH_CONTROL_BASE_URL=${base}/one-fetch-control`,
  `ONE_FETCH_GATEWAY_BASE_URL=${base}/one-fetch-gateway`,
  "ONE_FETCH_BUILD_VERSION=0.1.0-preview",
  "",
];
const outputPath = resolve(output);
await writeFile(outputPath, lines.join("\n"), {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
if (process.platform !== "win32") await chmod(outputPath, 0o600);
globalThis.console.log(
  `Created ${outputPath}. It contains secrets; keep it outside Git and delete it after supabase secrets set.`,
);
