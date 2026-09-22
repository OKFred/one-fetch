import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import { createCloudflareCoordinator } from "../cloudflare-coordination.mjs";

const [path, serializedState] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout = 5000");
const state = JSON.parse(serializedState);
const coordinator = createCloudflareCoordinator(state, async (sql, params) =>
  db
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row })),
);
process.on("message", () => {
  void coordinator
    .acquire("apply", "0.1.0")
    .then((lock) => {
      process.send({
        acquired: true,
        owner: lock.owner,
        revision: lock.revision,
      });
    })
    .catch(() => {
      process.send({ acquired: false });
    });
});
process.send({ ready: true });
