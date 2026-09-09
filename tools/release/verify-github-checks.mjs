import console from "node:console";
import process from "node:process";

import {
  fetchWorkflowRuns,
  requireSuccessfulWorkflowRuns,
} from "./github-checks.mjs";
import { parseArguments } from "./lib.mjs";

const argumentsMap = parseArguments(process.argv.slice(2));
const repository =
  argumentsMap.get("repository") ?? process.env.GITHUB_REPOSITORY;
const commit = argumentsMap.get("sha") ?? process.env.GITHUB_SHA;

if (typeof repository !== "string" || typeof commit !== "string") {
  throw new Error("GitHub repository and commit SHA are required");
}

const runs = await fetchWorkflowRuns(
  repository,
  commit,
  process.env.GITHUB_TOKEN,
);
const accepted = requireSuccessfulWorkflowRuns(runs, commit);
for (const run of accepted) {
  console.log(`${run.name} verified: ${run.url ?? `run ${run.id}`}`);
}
