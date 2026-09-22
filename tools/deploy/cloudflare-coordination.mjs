import { randomUUID } from "node:crypto";
import { deploymentNames, validateBuildId } from "./cloudflare-support.mjs";

export const COORDINATION_TABLE = "one_fetch_deployment_coordination";
export const COORDINATION_DDL = `CREATE TABLE ${COORDINATION_TABLE} (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  deployment_id TEXT NOT NULL, account_id TEXT NOT NULL, database_id TEXT NOT NULL,
  build_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0),
  owner_id TEXT, operation TEXT, updated_at TEXT NOT NULL,
  CHECK ((owner_id IS NULL) = (operation IS NULL))
) STRICT`;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const OPERATIONS = new Set([
  "install",
  "apply",
  "verify",
  "rollback",
  "cleanup",
]);
const FIELDS =
  "singleton,schema_version,deployment_id,account_id,database_id,build_id,revision,owner_id,operation,updated_at";
const WHERE_IDENTITY =
  "singleton = 1 AND schema_version = 1 AND deployment_id = ? AND account_id = ? AND database_id = ?";

export function coordinationIdentity(state) {
  const names = deploymentNames(state.deploymentId);
  if (
    !/^[a-f0-9]{32}$/u.test(state.accountId ?? "") ||
    !UUID.test(state.resources?.databaseId ?? "") ||
    Object.entries(names).some(([key, value]) => state.resources[key] !== value)
  ) {
    throw new Error(
      "Cloudflare deployment identity is invalid or lacks a pinned account",
    );
  }
  return [state.deploymentId, state.accountId, state.resources.databaseId];
}

function checkedRow(rows, state) {
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error(
      "Cloudflare coordination is missing, locked, stale or owned elsewhere",
    );
  const row = rows[0];
  const identity = coordinationIdentity(state);
  if (
    Object.keys(row).sort().join(",") !== FIELDS.split(",").sort().join(",") ||
    row.singleton !== 1 ||
    row.schema_version !== 1 ||
    row.deployment_id !== identity[0] ||
    row.account_id !== identity[1] ||
    row.database_id !== identity[2] ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0 ||
    (row.owner_id !== null && !UUID.test(row.owner_id)) ||
    (row.operation !== null && !OPERATIONS.has(row.operation)) ||
    (row.owner_id === null) !== (row.operation === null) ||
    typeof row.updated_at !== "string" ||
    !Number.isFinite(Date.parse(row.updated_at))
  ) {
    throw new Error("Cloudflare coordination response failed validation");
  }
  validateBuildId(row.build_id);
  return row;
}

// The query function uses SQL parameters. Owner IDs are coordination identifiers,
// not bearer credentials: only Cloudflare account credentials authorize access.
export function createCloudflareCoordinator(state, query) {
  const identity = coordinationIdentity(state);
  const read = async () =>
    checkedRow(
      await query(
        `SELECT ${FIELDS} FROM ${COORDINATION_TABLE} WHERE ${WHERE_IDENTITY}`,
        identity,
      ),
      state,
    );
  return {
    read,
    async initialize(buildId) {
      validateBuildId(buildId);
      // No IF NOT EXISTS or UPSERT: adoption must never replace another owner.
      await query(COORDINATION_DDL, []);
      return checkedRow(
        await query(
          `INSERT INTO ${COORDINATION_TABLE} (${FIELDS}) VALUES (1, 1, ?, ?, ?, ?, 0, NULL, NULL, ?) RETURNING ${FIELDS}`,
          [...identity, buildId, new Date().toISOString()],
        ),
        state,
      );
    },
    async acquire(operation, expectedBuild, recovery) {
      if (!OPERATIONS.has(operation))
        throw new Error("Invalid Cloudflare operation");
      validateBuildId(expectedBuild);
      const owner = randomUUID();
      let condition = "owner_id IS NULL AND build_id = ?";
      let params = [expectedBuild];
      if (recovery !== undefined) {
        if (
          !["rollback", "cleanup", "verify"].includes(operation) ||
          recovery.confirmStopped !== state.deploymentId ||
          !UUID.test(recovery.owner ?? "") ||
          !Number.isSafeInteger(recovery.revision) ||
          recovery.revision < 0
        ) {
          throw new Error(
            "Recovery requires exact owner/revision and confirmation all helpers are stopped",
          );
        }
        condition = "owner_id = ? AND revision = ? AND build_id = ?";
        params = [recovery.owner, recovery.revision, expectedBuild];
      }
      const row = checkedRow(
        await query(
          `UPDATE ${COORDINATION_TABLE} SET owner_id = ?, operation = ?, revision = revision + 1, updated_at = ? WHERE ${WHERE_IDENTITY} AND ${condition} RETURNING ${FIELDS}`,
          [owner, operation, new Date().toISOString(), ...identity, ...params],
        ),
        state,
      );
      if (
        row.owner_id !== owner ||
        row.operation !== operation ||
        row.build_id !== expectedBuild
      )
        throw new Error(
          "Cloudflare lock acknowledgement does not match this operation",
        );
      const assertOwned = async () => {
        const current = await read();
        if (
          current.owner_id !== owner ||
          current.revision !== row.revision ||
          current.operation !== operation ||
          current.build_id !== expectedBuild
        )
          throw new Error("Cloudflare deployment lock ownership was lost");
      };
      return {
        owner,
        revision: row.revision,
        expectedBuild,
        assertOwned,
        async complete(buildId) {
          validateBuildId(buildId);
          const completed = checkedRow(
            await query(
              `UPDATE ${COORDINATION_TABLE} SET owner_id = NULL, operation = NULL, build_id = ?, revision = revision + 1, updated_at = ? WHERE ${WHERE_IDENTITY} AND owner_id = ? AND revision = ? AND build_id = ? RETURNING ${FIELDS}`,
              [
                buildId,
                new Date().toISOString(),
                ...identity,
                owner,
                row.revision,
                expectedBuild,
              ],
            ),
            state,
          );
          if (completed.owner_id !== null || completed.build_id !== buildId)
            throw new Error("Cloudflare lock completion was not acknowledged");
          return completed;
        },
      };
    },
  };
}

// Never release in finally. Failure, a lost acknowledgement, or process death
// retains the shared lock. There is intentionally no TTL or stale-PID takeover.
export async function withCloudflareCoordination(coordinator, options, work) {
  const lock = await coordinator.acquire(
    options.operation,
    options.expectedBuild,
    options.recovery,
  );
  await options.recordLock(lock);
  const result = await work(lock);
  if (!options.deletesDatabase) await lock.complete(result.buildId);
  return result;
}
