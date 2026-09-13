import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const part = z
  .object({
    bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: digest,
  })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal("supabase-logical-v2"),
    schemas: z.tuple([
      z.literal("one_fetch"),
      z.literal("supabase_migrations"),
    ]),
    schema: part,
    data: part,
    rpc: part.extend({ count: z.number().int().min(0).max(256) }),
    emptyBaseline: z
      .object({
        projectRef: z.string().regex(/^[a-z0-9]{20}$/u),
        checkedAt: z.iso.datetime(),
        schemas: z.tuple([]),
        querySha256: digest,
      })
      .strict()
      .optional(),
  })
  .strict();

export function backupManifest(backup) {
  const summary = (value) => ({ bytes: value?.bytes, sha256: value?.sha256 });
  try {
    return manifestSchema.parse({
      format: backup.format,
      schemas: backup.schemas,
      schema: summary(backup.schema),
      data: summary(backup.data),
      rpc: { ...summary(backup.rpc), count: backup.rpc?.count },
      ...(backup.emptyBaseline ? { emptyBaseline: backup.emptyBaseline } : {}),
    });
  } catch {
    throw new Error(
      "Incomplete or unsupported logical backup manifest; v2 requires schema, RPC and data",
    );
  }
}

export function backupDigest(backup) {
  return createHash("sha256")
    .update(JSON.stringify(backupManifest(backup)))
    .digest("hex");
}

// Read-only integrity gate. Never executes SQL or claims behavioral recovery.
export async function verifyBackupIntegrity(backup, statePath) {
  const manifest = backupManifest(backup);
  if (backupDigest(manifest) !== backup.sha256)
    throw new Error("Logical backup manifest digest mismatch");
  const directory = await realpath(dirname(resolve(statePath)));
  const seen = new Set();
  for (const kind of ["schema", "rpc", "data"]) {
    const path = backup[kind]?.path;
    if (typeof path !== "string") throw new Error("Missing backup part path");
    const absolute = resolve(path);
    const details = await lstat(absolute);
    const canonical = await realpath(absolute);
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      dirname(canonical) !== directory ||
      seen.has(canonical) ||
      !canonical.endsWith(`.${kind}.sql`)
    )
      throw new Error(
        "Backup parts must be distinct regular files beside their state file",
      );
    seen.add(canonical);
    if (details.size !== manifest[kind].bytes)
      throw new Error(`Logical backup ${kind} size mismatch`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(canonical)) hash.update(chunk);
    if (hash.digest("hex") !== manifest[kind].sha256)
      throw new Error(`Logical backup ${kind} digest mismatch`);
  }
  return {
    format: manifest.format,
    parts: 3,
    rpcCount: manifest.rpc.count,
    integrityVerified: true,
    restoreVerified: false,
  };
}
