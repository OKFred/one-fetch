import console from "node:console";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

import { repositoryRoot } from "./lib.mjs";

const coreRoot = join(repositoryRoot, "packages", "core", "src");
const forbidden = [
  /^node:/u,
  /^cloudflare:/u,
  /^https?:/u,
  /^jsr:/u,
  /^npm:/u,
  /^@cloudflare(?:\/|$)/u,
  /^@supabase(?:\/|$)/u,
  /(?:^|\/)adapters(?:\/|$)/u,
];
const violations = [];

function moduleText(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier.text
      : undefined;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return undefined;
}

for (const entry of await readdir(coreRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
  const path = join(coreRoot, entry.name);
  const source = ts.createSourceFile(
    path,
    await readFile(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  function visit(node) {
    const specifier = moduleText(node);
    if (specifier && forbidden.some((pattern) => pattern.test(specifier))) {
      const position = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      violations.push(
        `${entry.name}:${position.line + 1}: forbidden import ${specifier}`,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

if (violations.length > 0) {
  throw new Error(
    `Shared core import boundary failed:\n${violations.join("\n")}`,
  );
}
console.log("Shared core uses runtime-neutral imports");
