import { DatabaseSync } from "node:sqlite";

const MINIMUM_NODE = [24, 20, 0] as const;
const MAXIMUM_NODE_MAJOR = 27;

const compareVersion = (
  left: readonly number[],
  right: readonly number[],
): number => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export const assertSupportedRuntime = (): void => {
  const current = process.versions.node.split(".").map(Number);
  if (
    current.some(Number.isNaN) ||
    compareVersion(current, MINIMUM_NODE) < 0 ||
    current[0] === undefined ||
    current[0] >= MAXIMUM_NODE_MAJOR
  ) {
    throw new Error(
      `one-fetch requires Node >=24.20.0 <27; current runtime is ${process.versions.node}`,
    );
  }

  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      "PRAGMA foreign_keys = ON; CREATE TABLE probe(value INTEGER NOT NULL);",
    );
    database.prepare("INSERT INTO probe(value) VALUES (?)").run(1);
    const row = database.prepare("SELECT value FROM probe").get() as {
      value?: unknown;
    };
    if (row.value !== 1)
      throw new Error("node:sqlite query probe returned an unexpected value");
    const integrity = database.prepare("PRAGMA integrity_check").get() as {
      integrity_check?: unknown;
    };
    if (integrity.integrity_check !== "ok")
      throw new Error("node:sqlite integrity probe failed");
  } finally {
    database.close();
  }
};
