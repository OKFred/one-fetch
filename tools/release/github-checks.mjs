const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const commitPattern = /^[0-9a-f]{40}$/u;

function compareRuns(left, right) {
  const attemptDifference = (right.run_attempt ?? 0) - (left.run_attempt ?? 0);
  if (attemptDifference !== 0) return attemptDifference;
  return String(right.created_at ?? "").localeCompare(
    String(left.created_at ?? ""),
  );
}

export function requireSuccessfulWorkflowRuns(
  runs,
  commit,
  requiredNames = ["CI", "CodeQL"],
) {
  if (!commitPattern.test(commit)) throw new Error("Invalid Git commit SHA");
  const accepted = [];
  for (const name of requiredNames) {
    const latest = runs
      .filter((run) => run.name === name && run.head_sha === commit)
      .sort(compareRuns)[0];
    if (!latest) {
      throw new Error(`${name} has not run for commit ${commit}`);
    }
    if (latest.status !== "completed" || latest.conclusion !== "success") {
      throw new Error(
        `${name} is ${latest.status}/${latest.conclusion ?? "pending"} for commit ${commit}`,
      );
    }
    accepted.push({ id: latest.id, name, url: latest.html_url });
  }
  return accepted;
}

export async function fetchWorkflowRuns(repository, commit, token) {
  if (!repositoryPattern.test(repository)) {
    throw new Error("Invalid GitHub repository name");
  }
  if (!commitPattern.test(commit)) throw new Error("Invalid Git commit SHA");
  if (!token) throw new Error("GITHUB_TOKEN is required");

  const url = new URL(
    `https://api.github.com/repos/${repository}/actions/runs`,
  );
  url.searchParams.set("head_sha", commit);
  url.searchParams.set("per_page", "100");
  const response = await globalThis.fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: globalThis.AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub Actions query failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload.workflow_runs)) {
    throw new Error("GitHub Actions response has no workflow_runs array");
  }
  return payload.workflow_runs;
}
import { URL } from "node:url";
