import { join } from "node:path";
import { writeJsonAtomic } from "./node-files.mjs";

// A phase is an observation, never permission to resume traffic or restore data.
// Intent is persisted before a side effect; a lost response stays uncertain.
export async function withNodeDeploymentJournal(lock, work) {
  const path = join(lock.root, "journal", `${lock.owner}.json`);
  let record = {
    schemaVersion: 1,
    operationId: lock.owner,
    operation: lock.operation,
    revision: 0,
    state: "in-progress",
    phase: "preparing",
    gatewayStatus: "unknown",
    createdAt: new Date().toISOString(),
    recovery: {
      automaticDatabaseRestore: false,
      automaticResume: false,
      automaticLockRemoval: false,
    },
  };
  const journal = {
    async advance(phase, details = {}) {
      await lock.assertOwned();
      const next = {
        ...record,
        ...details,
        phase,
        revision: record.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(path, next);
      record = next;
    },
  };
  await journal.advance("preparing");
  try {
    return await work(journal);
  } catch (error) {
    // Do not persist exception text: paths, URLs or vendor errors may be secret.
    // If ownership/storage is lost, preserve the previous durable intent.
    await journal
      .advance(record.phase, {
        state: "failed-needs-inspection",
      })
      .catch(() => {});
    throw error;
  }
}
