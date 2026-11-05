/**
 * Every place in the server's code that deletes storage data is registered with the deletion
 * guard (deletion-guard.ts, docs/STORAGE.md "Restore mode and progress markers"): a delete on a
 * storage backend, a restic forget or prune, a helper that deletes on every target, a move of a
 * repository aside, a row of the archive. A new place fails this test until it names the pass it
 * belongs to in ./deletion-sites.ts (and runs under that pass's permit); a registered place that
 * no longer exists fails it too, so the registry cannot go stale.
 *
 * The scan uses the TypeScript compiler: a `.delete()` counts when its receiver has the shape of
 * a StorageBackend (put, get, head, list, delete) or is a SegmentStore. A row of the archive
 * counts both as `.delete(archiveItems)` and as `delete from ${archiveItems}` in a sql template.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DELETION_PASSES } from "./deletion-guard.js";
import { DELETION_SITES } from "./deletion-sites.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SOURCES = [
  "packages/core/src",
  "packages/db/src",
  "apps/worker/src",
  "apps/api/src",
  "apps/scheduler/src",
  "ee/worker/src",
  "ee/api/src",
];
/** Functions that delete storage data on their own (their call sites are what is registered). */
const DELETING_FUNCTIONS = new Set([
  "resticForget",
  "resticPrune",
  "deleteOnAllTargets",
  "deletePartialManifest",
  "discardUncommittedSnapshot",
  "moveAside",
  "moveRepositoryAside",
  "removeRepositoryObjects",
  "deleteEverywhere",
  "deleteUnder",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === "testing" || name === "testdata") {
      continue;
    }
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

function enclosingName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      const owner =
        ts.isMethodDeclaration(current) && ts.isClassLike(current.parent) && current.parent.name
          ? `${current.parent.name.text}.`
          : "";
      return `${owner}${current.name.getText()}`;
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name)) {
      if (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer)) {
        return current.name.text;
      }
    }
    if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
  }
  return "<module>";
}

function isStorageLike(checker: ts.TypeChecker, type: ts.Type): boolean {
  const name = type.getSymbol()?.getName() ?? type.aliasSymbol?.getName();
  if (name === "SegmentStore") {
    return true;
  }
  const types = type.isUnion() ? type.types : [type];
  return types.some((candidate) =>
    ["put", "get", "head", "list", "delete"].every((property) =>
      checker.getPropertyOfType(candidate, property),
    ),
  );
}

function scan(): string[] {
  const files = SOURCES.flatMap((dir) => sourceFiles(join(ROOT, dir)));
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    resolveJsonModule: true,
    esModuleInterop: true,
    types: ["node"],
    lib: ["lib.es2023.d.ts"],
  });
  const checker = program.getTypeChecker();
  const sites = new Set<string>();
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !files.includes(file.fileName.split("/").join(sep))) {
      continue;
    }
    const rel = relative(ROOT, file.fileName).split(sep).join("/");
    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node) && ts.isTemplateExpression(node.template)) {
        // sql`... delete from ${archiveItems} ...`: the archive's rows, deleted in raw SQL.
        let before = node.template.head.text;
        for (const span of node.template.templateSpans) {
          if (
            /\bdelete\s+from\s*$/i.test(before) &&
            ts.isIdentifier(span.expression) &&
            span.expression.text === "archiveItems"
          ) {
            sites.add(`${rel}#${enclosingName(node)}#delete(archiveItems)`);
          }
          before = span.literal.text;
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          (callee.name.text === "delete" || callee.name.text === "deleteAllVersions")
        ) {
          const firstArgument = node.arguments[0];
          if (
            callee.name.text === "delete" &&
            firstArgument &&
            ts.isIdentifier(firstArgument) &&
            firstArgument.text === "archiveItems"
          ) {
            sites.add(`${rel}#${enclosingName(node)}#delete(archiveItems)`);
          } else if (isStorageLike(checker, checker.getTypeAtLocation(callee.expression))) {
            sites.add(`${rel}#${enclosingName(node)}#.${callee.name.text}`);
          }
        } else {
          const name = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee)
              ? callee.name.text
              : null;
          if (name && DELETING_FUNCTIONS.has(name)) {
            sites.add(`${rel}#${enclosingName(node)}#${name}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return [...sites].sort();
}

describe("storage deletion sites", () => {
  const found = scan();

  it("finds the known sites (the scan works)", () => {
    expect(found).toContain("packages/core/src/verify/gc.ts#sweepWithPermit#.delete");
  });

  it("registers every site with the deletion guard", () => {
    const unregistered = found.filter((site) => !(site in DELETION_SITES));
    expect(
      unregistered,
      "register it with the deletion guard (DELETION_PASSES) in packages/core/src/storage/deletion-sites.ts",
    ).toEqual([]);
  });

  it("names a known pass, or why no pass is needed, for every site", () => {
    const passes = new Set<string>(DELETION_PASSES);
    const unknown = Object.entries(DELETION_SITES).filter(
      ([, pass]) =>
        !passes.has(pass) && !["delegate", "always", "own_writes", "helper"].includes(pass),
    );
    expect(unknown).toEqual([]);
  });

  it("keeps no registry entry without a site", () => {
    const stale = Object.keys(DELETION_SITES).filter((site) => !found.includes(site));
    expect(stale).toEqual([]);
  });
}, 180_000);
