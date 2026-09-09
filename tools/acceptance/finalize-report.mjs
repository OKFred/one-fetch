import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { AcceptanceReportV1Schema } from "../../packages/conformance/dist/index.js";

function resourceKey(resource) {
  return `${resource.kind}:${resource.id}`;
}

function parseResource(value) {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1)
    throw new Error("--absent expects kind:id");
  return { kind: value.slice(0, separator), id: value.slice(separator + 1) };
}

export function parseFinalizeArguments(values) {
  const options = { absent: [], notApplicable: false };
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (name === "--not-applicable") {
      options.notApplicable = true;
      continue;
    }
    const value = values[index + 1];
    if (name === "--absent" && value !== undefined) {
      options.absent.push(parseResource(value));
      index += 1;
      continue;
    }
    if ((name === "--input" || name === "--output") && value !== undefined) {
      options[name.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${name ?? "<empty>"}`);
  }
  if (!options.input || !options.output)
    throw new Error("--input and --output are required");
  if (resolve(options.input) === resolve(options.output))
    throw new Error("Final report output must differ from the pending report");
  return options;
}

function assertExactCleanup(report, options) {
  if (report.cleanup.state !== "pending")
    throw new Error("Only a pending acceptance report can be finalized");
  const recorded = report.cleanup.resources.map(resourceKey).sort();
  const absent = options.absent.map(resourceKey).sort();
  if (new Set(absent).size !== absent.length)
    throw new Error("Duplicate --absent resource confirmation");
  if (recorded.length === 0) {
    if (!options.notApplicable || absent.length !== 0)
      throw new Error("A report without resources requires --not-applicable");
    return "not-applicable";
  }
  if (options.notApplicable)
    throw new Error("A report with resources cannot be not-applicable");
  if (
    recorded.length !== absent.length ||
    recorded.some((value, index) => value !== absent[index])
  ) {
    throw new Error(
      "Absent-resource confirmations must exactly match the report",
    );
  }
  return "verified";
}

export async function finalizeAcceptanceReport(options) {
  const input = resolve(options.input);
  const output = resolve(options.output);
  const report = AcceptanceReportV1Schema.parse(
    JSON.parse(await readFile(input, "utf8")),
  );
  const state = assertExactCleanup(report, options);
  const finalized = AcceptanceReportV1Schema.parse({
    ...report,
    cleanup: { ...report.cleanup, state },
  });
  await writeFile(output, `${JSON.stringify(finalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return { output, report: finalized };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await finalizeAcceptanceReport(
    parseFinalizeArguments(process.argv.slice(2)),
  );
  process.stdout.write(
    `${JSON.stringify({ cleanup: result.report.cleanup.state, report: result.output })}\n`,
  );
}
