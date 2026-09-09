import { pathToFileURL } from "node:url";

import {
  join,
  packageRequire,
  readJson,
  repositoryRoot,
  requireVersion,
  writeJson,
} from "./lib.mjs";

export async function generateProtocolSchemas(outputDirectory, version) {
  const checkedVersion = requireVersion(version);
  const protocolDirectory = join(repositoryRoot, "packages", "protocol");
  const protocolManifest = await readJson(
    join(protocolDirectory, "package.json"),
  );
  if (protocolManifest.version !== checkedVersion) {
    throw new Error(
      `Protocol version ${protocolManifest.version} does not match ${checkedVersion}`,
    );
  }

  const protocol = await import(
    pathToFileURL(join(protocolDirectory, "dist", "index.js"))
  );
  const { toJSONSchema } = packageRequire(protocolDirectory)("zod");
  const schemaNames = [
    "OneFetchRequestMetaV1Schema",
    "OneFetchResponseMetaV1Schema",
    "OneFetchCapabilitiesV1Schema",
    "PolicySetV1Schema",
    "UserDenyRulesV1Schema",
    "AuditEventV1Schema",
    "ExecutionReportV1Schema",
    "TunnelClientHelloV1Schema",
    "TunnelServerHelloV1Schema",
  ];

  const schemas = {};
  for (const name of schemaNames) {
    const schema = protocol[name];
    if (!schema) throw new Error(`Protocol does not export ${name}`);
    schemas[name.replace(/Schema$/u, "")] = toJSONSchema(schema, {
      target: "draft-2020-12",
      cycles: "ref",
      reused: "ref",
      unrepresentable: "any",
      io: "input",
    });
  }

  const filename = `one-fetch-protocol-schemas-${checkedVersion}.json`;
  await writeJson(join(outputDirectory, filename), {
    format: "one-fetch-json-schema-bundle-v1",
    protocolVersion: 1,
    packageVersion: checkedVersion,
    generatedFrom: "@one-fetch/protocol Zod runtime schemas",
    schemas,
  });
  return filename;
}
