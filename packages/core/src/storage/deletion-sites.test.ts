/**
 * Every place in the server's code that deletes storage data is registered with the deletion
 * guard (deletion-guard.ts, docs/STORAGE.md "Restore mode and progress markers"): a delete on a
 * storage backend, a restic forget or prune, a helper that deletes on every target, a move of a
 * repository aside, a row of the archive. A new place fails this test until it names the pass it
 * belongs to in ./deletion-sites.ts (and runs under that pass's permit); a registered place that
 * no longer exists fails it too, so the registry cannot go stale.
 *
 * The scan uses the TypeScript compiler and resolves names through the type checker, so an alias
 * does not hide a site:
 *
 *  - storage: the `delete` (or `deleteAllVersions`) member of a value that has the shape of a
 *    StorageBackend (put, get, head, list, delete) or is a SegmentStore, wherever the member is
 *    taken: `backend.delete(key)`, `backend["delete"](key)`, `backend.delete.bind(backend)`,
 *    `const { delete: remove } = backend`, `keys.forEach(backend.delete, backend)`;
 *  - the archive's rows: `.delete(table)` where the table resolves to the `archiveItems` table of
 *    packages/db (imported under any name, `schema.archiveItems`, `schema["archiveItems"]`, a const
 *    alias), and SQL text `delete from archive_items` in any string or template, including
 *    `sql.raw(...)` and `delete from ${archiveItems}` / `${sql.identifier("archive_items")}`;
 *  - the deleting functions (DELETING_FUNCTIONS): a call that resolves to one of them (imported
 *    under another name, through a namespace, a const alias, destructuring, `.bind`, `.call`,
 *    `.apply`), and the function handed on as a value (`repos.map(resticForget)`).
 *
 * Sites are counted: a function that deletes twice has two sites under one key, and the test
 * fails unless SITE_COUNTS says so, so a second delete added to a registered function is seen.
 * The scanner checks itself on small synthetic sources first ("scanner self-test").
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
/** The file (relative to the scan root) that declares the archive's item table. */
const ARCHIVE_TABLE_FILE = "packages/db/src/schema/archive.ts";
const ARCHIVE_TABLE_NAME = "archiveItems";
/**
 * Registered sites that occur more than once in their function (each one under the same pass).
 * Every other registered site occurs exactly once; a further delete in the same function fails
 * the test until it is counted here.
 */
const SITE_COUNTS: Readonly<Record<string, number>> = {
  // the file dropped after a failed write and after losing the room to another export (resetPermit)
  "apps/worker/src/handlers/export.ts#execute#.delete": 2,
  // restic's DELETE of a whole folder and of one object, both through the loopback
  "packages/core/src/endpoints/restic-rest.ts#handleResticRequest#.delete": 2,
  // the partial manifest and the uncommitted manifest, both under one permit
  "packages/core/src/engine/discard.ts#discardUncommittedSnapshot#deleteOnAllTargets": 2,
  // the replacement pack (not confirmed, lost the swap) and the repacked old pack (gc_repack)
  "packages/core/src/verify/gc.ts#repackOne#deleteEverywhere": 3,
};

const DELETE_MEMBERS = new Set(["delete", "deleteAllVersions"]);
/** SQL that deletes the archive's rows (optionally `only` and a schema-qualified name). */
const ARCHIVE_DELETE_SQL = /\bdelete\s+from\s+(?:only\s+)?(?:"?\w+"?\s*\.\s*)?"?archive_items\b/gi;
/** The archive table's name as an identifier string, e.g. sql.identifier("archive_items"). */
const ARCHIVE_TABLE_TEXT = /^\s*(?:"?\w+"?\s*\.\s*)?"?archive_items"?\s*$/i;
const ARCHIVE_SITE = "delete(archiveItems)";

const COMPILER_OPTIONS: ts.CompilerOptions = {
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
};

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

/** `(x)`, `x as T`, `x!`, `x satisfies T`, `<T>x` → x. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

/** The member a property or element access names: `a.b` → b, `a["b"]`, `a[k]` with k: "b". */
function memberName(checker: ts.TypeChecker, node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node)) {
    const argument = unwrap(node.argumentExpression);
    if (ts.isStringLiteralLike(argument)) {
      return argument.text;
    }
    const type = checker.getTypeAtLocation(argument);
    return type.isStringLiteral() ? type.value : undefined;
  }
  return undefined;
}

/** The property a destructuring element takes: `{ delete: remove }` → delete. */
function bindingPropertyName(
  checker: ts.TypeChecker,
  element: ts.BindingElement,
): string | undefined {
  const property = element.propertyName;
  if (!property) {
    return ts.isIdentifier(element.name) ? element.name.text : undefined;
  }
  if (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) {
    return property.text;
  }
  if (ts.isComputedPropertyName(property)) {
    const type = checker.getTypeAtLocation(property.expression);
    return type.isStringLiteral() ? type.value : undefined;
  }
  return undefined;
}

function canonical(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return checker.getExportSymbolOfSymbol(target);
}

/**
 * The symbol an expression finally stands for: through import aliases, const aliases
 * (`const t = archiveItems`), destructuring (`const { resticForget: f } = restic`) and `.bind`.
 */
function followSymbol(checker: ts.TypeChecker, symbol: ts.Symbol, depth: number): ts.Symbol {
  const resolved = canonical(checker, symbol);
  if (depth > 8) {
    return resolved;
  }
  const declaration = resolved.valueDeclaration;
  if (
    declaration &&
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    declaration.initializer &&
    ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const
  ) {
    return resolveSymbol(checker, declaration.initializer, depth + 1) ?? resolved;
  }
  if (
    declaration &&
    ts.isBindingElement(declaration) &&
    ts.isObjectBindingPattern(declaration.parent)
  ) {
    const name = bindingPropertyName(checker, declaration);
    const property = name
      ? checker.getPropertyOfType(checker.getTypeAtLocation(declaration.parent), name)
      : undefined;
    if (property) {
      return followSymbol(checker, property, depth + 1);
    }
  }
  return resolved;
}

function resolveSymbol(
  checker: ts.TypeChecker,
  node: ts.Expression,
  depth = 0,
): ts.Symbol | undefined {
  const expression = unwrap(node);
  if (
    ts.isCallExpression(expression) &&
    (ts.isPropertyAccessExpression(expression.expression) ||
      ts.isElementAccessExpression(expression.expression)) &&
    memberName(checker, expression.expression) === "bind"
  ) {
    return resolveSymbol(checker, expression.expression.expression, depth + 1);
  }
  let symbol: ts.Symbol | undefined;
  if (ts.isIdentifier(expression)) {
    symbol = checker.getSymbolAtLocation(expression);
  } else if (ts.isPropertyAccessExpression(expression)) {
    symbol = checker.getSymbolAtLocation(expression.name);
  } else if (ts.isElementAccessExpression(expression)) {
    const name = memberName(checker, expression);
    symbol = name
      ? checker.getPropertyOfType(checker.getTypeAtLocation(expression.expression), name)
      : undefined;
  }
  return symbol ? followSymbol(checker, symbol, depth) : undefined;
}

function declaredName(symbol: ts.Symbol): string {
  const name = symbol.valueDeclaration && ts.getNameOfDeclaration(symbol.valueDeclaration);
  return name && ts.isIdentifier(name) ? name.text : symbol.getName();
}

/** `if (backend.deleteAllVersions)`, `typeof x.delete`, `x.delete !== undefined`: no delete. */
function isPresenceCheck(node: ts.Expression): boolean {
  const parent = node.parent;
  if (ts.isIfStatement(parent) || ts.isWhileStatement(parent)) {
    return parent.expression === node;
  }
  if (ts.isConditionalExpression(parent)) {
    return parent.condition === node;
  }
  if (ts.isTypeOfExpression(parent)) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(parent)) {
    return parent.operator === ts.SyntaxKind.ExclamationToken;
  }
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    return (
      (operator === ts.SyntaxKind.AmpersandAmpersandToken && parent.left === node) ||
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsToken
    );
  }
  return false;
}

/** `wrapped.delete = ...`: the member is defined (a wrapper), not taken. */
function isAssignmentTarget(node: ts.Expression): boolean {
  const parent = node.parent;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

/** Where a value escapes as a value (not called, not aliased through a const or `.bind`). */
function isValueReference(node: ts.Expression): boolean {
  const parent = node.parent;
  return (
    ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.expression !== node &&
      (parent.arguments ?? ([] as readonly ts.Expression[])).includes(node)) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === node) ||
    ts.isShorthandPropertyAssignment(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isReturnStatement(parent) ||
    ts.isSpreadElement(parent) ||
    (ts.isArrowFunction(parent) && parent.body === node) ||
    (ts.isBinaryExpression(parent) &&
      parent.right === node &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
  );
}

/** Every deletion site in `files`, `file#function#call` once per occurrence (sorted). */
function scanProgram(program: ts.Program, files: readonly string[], root: string): string[] {
  const checker = program.getTypeChecker();
  const fileSet = new Set(files.map((file) => file.split("/").join(sep)));
  const ours = program
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile && fileSet.has(file.fileName.split("/").join(sep)));
  const relativeName = (file: ts.SourceFile) => relative(root, file.fileName).split(sep).join("/");

  // The archive table and the deleting functions, as the checker's symbols.
  let archiveTable: ts.Symbol | undefined;
  const deletingFunctions = new Set<ts.Symbol>();
  for (const file of ours) {
    const visit = (node: ts.Node): void => {
      const name =
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isVariableDeclaration(node)
          ? node.name
          : undefined;
      if (name && ts.isIdentifier(name)) {
        const symbol = checker.getSymbolAtLocation(name);
        if (
          symbol &&
          relativeName(file) === ARCHIVE_TABLE_FILE &&
          ts.isVariableDeclaration(node) &&
          name.text === ARCHIVE_TABLE_NAME
        ) {
          archiveTable = canonical(checker, symbol);
        }
        if (
          symbol &&
          DELETING_FUNCTIONS.has(name.text) &&
          (ts.isFunctionDeclaration(node) ||
            ts.isMethodDeclaration(node) ||
            (ts.isVariableDeclaration(node) &&
              !!node.initializer &&
              (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))))
        ) {
          deletingFunctions.add(canonical(checker, symbol));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  if (!archiveTable) {
    throw new Error(`${ARCHIVE_TABLE_FILE} does not declare ${ARCHIVE_TABLE_NAME}`);
  }
  const missing = [...DELETING_FUNCTIONS].filter(
    (name) => ![...deletingFunctions].some((symbol) => declaredName(symbol) === name),
  );
  if (missing.length > 0) {
    throw new Error(`DELETING_FUNCTIONS names functions that no longer exist: ${missing}`);
  }

  const isArchiveTable = (node: ts.Expression): boolean => {
    const expression = unwrap(node);
    if (ts.isStringLiteralLike(expression)) {
      return ARCHIVE_TABLE_TEXT.test(expression.text);
    }
    if (ts.isCallExpression(expression)) {
      // sql.identifier("archive_items"), sql.raw(getTableName(archiveItems)), alias(archiveItems)
      return expression.arguments.some(isArchiveTable);
    }
    return resolveSymbol(checker, expression) === archiveTable;
  };
  const deletingFunction = (node: ts.Expression): string | undefined => {
    const symbol = resolveSymbol(checker, node);
    return symbol && deletingFunctions.has(symbol) ? declaredName(symbol) : undefined;
  };
  const archiveDeletes = (text: string): number => text.match(ARCHIVE_DELETE_SQL)?.length ?? 0;

  const sites: string[] = [];
  for (const file of ours) {
    const rel = relativeName(file);
    const add = (node: ts.Node, call: string, count = 1): void => {
      for (let index = 0; index < count; index += 1) {
        sites.push(`${rel}#${enclosingName(node)}#${call}`);
      }
    };
    const visit = (node: ts.Node): void => {
      // SQL text that deletes archive rows: plain strings, sql.raw(...), templates with the table
      // given as text or as ${archiveItems} (under any name).
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        add(node, ARCHIVE_SITE, archiveDeletes(node.text));
      } else if (ts.isTemplateExpression(node)) {
        const text = node.templateSpans.reduce(
          (sql, span) =>
            `${sql}${isArchiveTable(span.expression) ? "archive_items" : "(expr)"}${span.literal.text}`,
          node.head.text,
        );
        add(node, ARCHIVE_SITE, archiveDeletes(text));
      }

      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        const firstArgument = node.arguments[0];
        const calleeMember = memberName(checker, callee);
        const deletesArchive =
          firstArgument !== undefined &&
          isArchiveTable(firstArgument) &&
          (calleeMember === "delete" || resolveSymbol(checker, callee)?.getName() === "delete");
        if (deletesArchive) {
          add(node, ARCHIVE_SITE);
        } else if (!(calleeMember && DELETE_MEMBERS.has(calleeMember))) {
          // f(), ns.f(), alias(), f.bind(...)(), f.call(...), f.apply(...)
          const target =
            (calleeMember === "call" || calleeMember === "apply") &&
            (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
              ? callee.expression
              : callee;
          const name =
            deletingFunction(target) ??
            (ts.isIdentifier(callee) && DELETING_FUNCTIONS.has(callee.text)
              ? callee.text
              : ts.isPropertyAccessExpression(callee) && DELETING_FUNCTIONS.has(callee.name.text)
                ? callee.name.text
                : undefined);
          if (name) {
            add(node, name);
          }
        }
      }

      // The delete member of a storage backend, wherever it is taken (called, bound, handed on).
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const member = memberName(checker, node);
        const archiveCall =
          ts.isCallExpression(node.parent) &&
          node.parent.expression === node &&
          node.parent.arguments[0] !== undefined &&
          isArchiveTable(node.parent.arguments[0]);
        if (
          member &&
          DELETE_MEMBERS.has(member) &&
          !archiveCall &&
          !isPresenceCheck(node) &&
          !isAssignmentTarget(node) &&
          isStorageLike(checker, checker.getTypeAtLocation(node.expression))
        ) {
          add(node, `.${member}`);
        }
      }
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const member = bindingPropertyName(checker, node);
        if (
          member &&
          DELETE_MEMBERS.has(member) &&
          isStorageLike(checker, checker.getTypeAtLocation(node.parent))
        ) {
          add(node, `.${member}`);
        }
      }

      // A deleting function handed on as a value: repos.map(resticForget), { forget: resticForget }.
      if (
        (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) &&
        isValueReference(node)
      ) {
        const symbol = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : undefined;
        const name = symbol
          ? deletingFunctions.has(followSymbol(checker, symbol, 0))
            ? declaredName(followSymbol(checker, symbol, 0))
            : undefined
          : deletingFunction(node);
        if (name) {
          add(node, name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return sites.sort();
}

function scan(): string[] {
  const files = SOURCES.flatMap((dir) => sourceFiles(join(ROOT, dir)));
  return scanProgram(ts.createProgram(files, COMPILER_OPTIONS), files, ROOT);
}

function countSites(sites: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const site of sites) {
    counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  return counts;
}

// --- scanner self-test: synthetic sources -----------------------------------------------------

const VIRTUAL_ROOT = "/virtual-deletion-sites/";
const CASES_DIR = "apps/cases/src/";
const SUPPORT: Record<string, string> = {
  [ARCHIVE_TABLE_FILE]: `
    export const archiveItems = { id: "id", tenantId: "tenant_id" } as const;
    export const archiveItemCaptures = { id: "id" } as const;
  `,
  "packages/db/src/index.ts": `
    export * from "./schema/archive.js";
    export * as schema from "./schema/archive.js";
  `,
  "packages/db/src/sql.ts": `
    export interface SQL { readonly text: string }
    export function sql(strings: TemplateStringsArray, ...values: unknown[]): SQL {
      return { text: strings.join("?") + values.length };
    }
    sql.raw = (text: string): SQL => ({ text });
    sql.identifier = (name: string): SQL => ({ text: name });
    export interface Where { where(condition: unknown): Promise<void> }
    export interface Db {
      delete(table: object): Where;
      execute(query: SQL | string): Promise<void>;
      select(): { from(table: object): Promise<unknown[]> };
    }
    export interface Client { query(text: string, values?: unknown[]): Promise<void> }
  `,
  "packages/core/src/backend.ts": `
    export interface StorageBackend {
      put(key: string, body: Uint8Array): Promise<void>;
      get(key: string): Promise<Uint8Array>;
      head(key: string): Promise<boolean>;
      list(prefix: string): AsyncIterable<string>;
      delete(key: string): Promise<void>;
      deleteAllVersions?(key: string, now: Date): Promise<void>;
    }
  `,
  "packages/core/src/restic.ts": `
    export async function resticForget(repo: string, keep?: number): Promise<void> { void repo; void keep; }
    export async function resticPrune(repo: string): Promise<void> { void repo; }
    export async function resticCheck(repo: string): Promise<void> { void repo; }
    ${[...DELETING_FUNCTIONS]
      .filter((name) => name !== "resticForget" && name !== "resticPrune")
      .map((name) => `export async function ${name}(): Promise<void> {}`)
      .join("\n")}
  `,
};
const IMPORTS = `
  import { archiveItems, archiveItemCaptures } from "../../../packages/db/src/schema/archive.js";
  import * as schema from "../../../packages/db/src/schema/archive.js";
  import { sql, type Client, type Db } from "../../../packages/db/src/sql.js";
  import type { StorageBackend } from "../../../packages/core/src/backend.js";
  import * as restic from "../../../packages/core/src/restic.js";
  import { resticForget, resticPrune } from "../../../packages/core/src/restic.js";
  void archiveItems; void archiveItemCaptures; void schema; void sql; void restic;
  void resticForget; void resticPrune;
  export type Context = { db: Db; client: Client; backend: StorageBackend; key: string; id: string };
`;
/**
 * Each case is one file; `sites` are its sites, one per occurrence, as `function#call` (or just
 * `call` for the function `run`).
 */
const CASES: ReadonlyArray<{ name: string; code: string; sites: string[] }> = [
  // the forms the scan always knew (it still finds them)
  {
    name: "direct-forms",
    code: `export async function run({ db, backend, key }: Context) {
      await backend.delete(key);
      await db.delete(archiveItems).where(1);
      await restic.resticForget(key);
      await resticPrune(key);
    }
    export async function raw({ db, key }: Context) {
      await db.execute(sql\`delete from \${archiveItems} where id = \${key}\`);
    }`,
    sites: [ARCHIVE_SITE, `raw#${ARCHIVE_SITE}`, ".delete", "resticForget", "resticPrune"],
  },
  // the archive table under another name
  {
    name: "table-aliased-import",
    code: `import { archiveItems as items } from "../../../packages/db/src/schema/archive.js";
      export async function run({ db }: Context) { await db.delete(items).where(1); }`,
    sites: [ARCHIVE_SITE],
  },
  {
    name: "table-reexported",
    code: `import { archiveItems as items, schema as s } from "../../../packages/db/src/index.js";
      export async function run({ db }: Context) {
        await db.delete(items).where(1);
        await db.delete(s.archiveItems).where(1);
      }`,
    sites: [ARCHIVE_SITE, ARCHIVE_SITE],
  },
  {
    name: "table-namespace",
    code: `export async function run({ db }: Context) { await db.delete(schema.archiveItems).where(1); }`,
    sites: [ARCHIVE_SITE],
  },
  {
    name: "table-element-access",
    code: `export async function run({ db }: Context) { await db.delete(schema["archiveItems"]).where(1); }`,
    sites: [ARCHIVE_SITE],
  },
  {
    name: "table-const-alias",
    code: `const table = archiveItems;
      export async function run({ db }: Context) { await db.delete(table as typeof archiveItems).where(1); }`,
    sites: [ARCHIVE_SITE],
  },
  {
    name: "table-bound-delete",
    code: `export async function run({ db }: Context) {
      const remove = db.delete.bind(db);
      await remove(archiveItems).where(1);
      await db["delete"](archiveItems).where(1);
    }`,
    sites: [ARCHIVE_SITE, ARCHIVE_SITE],
  },
  // the archive table in SQL text
  {
    name: "sql-literal-template",
    code: `export async function run({ db, id }: Context) {
      await db.execute(sql\`DELETE FROM "archive_items" WHERE id = \${id}\`);
      await db.execute(sql\`delete from public.archive_items\`);
    }`,
    sites: [ARCHIVE_SITE, ARCHIVE_SITE],
  },
  {
    name: "sql-raw",
    code: `export async function run({ db }: Context) {
      await db.execute(sql.raw("delete from archive_items where tenant_id = $1"));
    }`,
    sites: [ARCHIVE_SITE],
  },
  {
    name: "sql-plain-query",
    code: `export async function run({ client, id }: Context) {
      await client.query('DELETE FROM ONLY "public"."archive_items" WHERE id = $1', [id]);
    }`,
    sites: [ARCHIVE_SITE],
  },
  {
    name: "sql-table-span",
    code: `export async function run({ db }: Context) {
      await db.execute(sql\`delete from \${sql.identifier("archive_items")}\`);
      await db.execute(sql\`delete from \${schema.archiveItems}\`);
      await db.execute(sql\`delete from \${sql.raw('"archive_items"')} where true\`);
    }`,
    sites: [ARCHIVE_SITE, ARCHIVE_SITE, ARCHIVE_SITE],
  },
  // the delete member of a storage backend
  {
    name: "backend-element-access",
    code: `export async function run({ backend, key }: Context) {
      await backend["delete"](key);
      const op = "delete" as const;
      await backend[op](key);
    }`,
    sites: [".delete", ".delete"],
  },
  {
    name: "backend-bind",
    code: `export async function run({ backend, key }: Context) {
      const remove = backend.delete.bind(backend);
      await remove(key);
      if (backend.deleteAllVersions) {
        const removeAll = backend.deleteAllVersions.bind(backend);
        await removeAll(key, new Date());
      }
    }`,
    sites: [".delete", ".deleteAllVersions"],
  },
  {
    // a wrapper defining the member and handing the delete on (progress-marker.ts): one site
    name: "backend-wrapped",
    code: `export function wrap(backend: StorageBackend): StorageBackend {
      const wrapped: StorageBackend = { ...backend };
      if (backend.deleteAllVersions) {
        const removeAll = backend.deleteAllVersions.bind(backend);
        wrapped.deleteAllVersions = (key, now) => removeAll(key, now);
      }
      return wrapped;
    }`,
    sites: ["wrap#.deleteAllVersions"],
  },
  {
    name: "backend-destructuring",
    code: `export async function run({ backend, key }: Context) {
      const { delete: remove } = backend;
      await remove.call(backend, key);
    }
    export async function clear({ delete: remove }: StorageBackend, key: string) { await remove(key); }`,
    sites: [".delete", "clear#.delete"],
  },
  {
    name: "backend-handed-on",
    code: `export async function run({ backend }: Context, keys: string[]) {
      keys.forEach(backend.delete, backend);
    }`,
    sites: [".delete"],
  },
  // the deleting functions under another name
  {
    name: "function-aliased-import",
    code: `import { resticForget as forget } from "../../../packages/core/src/restic.js";
      export async function run({ key }: Context) { await forget(key); }`,
    sites: ["resticForget"],
  },
  {
    name: "function-element-access",
    code: `export async function run({ key }: Context) { await restic["resticPrune"](key); }`,
    sites: ["resticPrune"],
  },
  {
    name: "function-const-and-destructuring",
    code: `const forget = resticForget;
      export async function run({ key }: Context) {
        const { resticPrune: prune } = restic;
        await forget(key);
        await prune(key);
      }`,
    sites: ["resticForget", "resticPrune"],
  },
  {
    name: "function-bind-call-apply",
    code: `export async function run({ key }: Context) {
      const forget = resticForget.bind(null, key);
      await forget();
      await resticPrune.call(null, key);
      await restic.resticForget.apply(null, [key]);
    }`,
    sites: ["resticForget", "resticForget", "resticPrune"],
  },
  {
    name: "function-handed-on",
    code: `export async function run(repos: string[]) {
      await Promise.all(repos.map(resticForget));
      return { prune: restic.resticPrune };
    }`,
    sites: ["resticForget", "resticPrune"],
  },
  // counted per occurrence
  {
    name: "counted-per-occurrence",
    code: `export async function run({ db, backend, key }: Context) {
      await backend.delete(key);
      await backend.delete(\`\${key}.idx\`);
      await resticForget(key);
      await resticForget(key, 1);
      await db.execute(sql\`delete from archive_items where id = 1; delete from archive_items where id = 2\`);
    }`,
    sites: [ARCHIVE_SITE, ARCHIVE_SITE, ".delete", ".delete", "resticForget", "resticForget"],
  },
  // what is not a site
  {
    name: "not-sites",
    code: `async function forget(key: string) { void key; }
      export async function run({ db, client, key }: Context) {
        new Map<string, number>().delete(key);
        new Set<string>().delete(key);
        await db.delete(archiveItemCaptures).where(1);
        await db.select().from(archiveItems);
        await db.execute(sql\`select * from archive_items where id = \${archiveItems.id}\`);
        await client.query("delete from archive_items_staging");
        await forget(key);
        await restic.resticCheck(key);
        const map = { delete: (k: string) => k };
        map.delete(key);
      }
      export function check(backend: StorageBackend): boolean {
        if (backend.deleteAllVersions) {
          return typeof backend.deleteAllVersions === "function" && !backend.deleteAllVersions;
        }
        return backend.deleteAllVersions !== undefined ? true : !!backend.deleteAllVersions;
      }`,
    sites: [],
  },
];

function virtualProgram(sources: Record<string, string>): {
  program: ts.Program;
  files: string[];
} {
  const contents = new Map<string, string>(
    Object.entries(sources).map(([path, code]) => [`${VIRTUAL_ROOT}${path}`, code] as const),
  );
  const options = { ...COMPILER_OPTIONS, types: [] };
  const host = ts.createCompilerHost(options, true);
  const base = { ...host };
  host.getSourceFile = (fileName, language, ...rest) => {
    const code = contents.get(fileName);
    return code === undefined
      ? base.getSourceFile(fileName, language, ...rest)
      : ts.createSourceFile(fileName, code, language, true);
  };
  host.fileExists = (fileName) => contents.has(fileName) || base.fileExists(fileName);
  host.readFile = (fileName) => contents.get(fileName) ?? base.readFile(fileName);
  host.directoryExists = (dir) =>
    [...contents.keys()].some((file) => file.startsWith(`${dir.replace(/\/$/, "")}/`)) ||
    (base.directoryExists?.(dir) ?? false);
  host.realpath = (path) =>
    path.startsWith(VIRTUAL_ROOT) ? path : (base.realpath?.(path) ?? path);
  const files = [...contents.keys()];
  return { program: ts.createProgram(files, options, host), files };
}

describe("storage deletion sites: scanner self-test", () => {
  const { program, files } = virtualProgram({
    ...SUPPORT,
    ...Object.fromEntries(
      CASES.map(({ name, code }) => [`${CASES_DIR}${name}.ts`, `${IMPORTS}\n${code}`]),
    ),
  });
  const found = scanProgram(program, files, VIRTUAL_ROOT);

  it("compiles the synthetic sources", () => {
    const errors = ts
      .getPreEmitDiagnostics(program)
      .map((d) => `${d.file?.fileName}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    expect(errors).toEqual([]);
  });

  it.each(CASES)("$name", ({ name, sites }) => {
    const prefix = `${CASES_DIR}${name}.ts#`;
    const calls = found
      .filter((site) => site.startsWith(prefix))
      .map((site) => site.slice(prefix.length));
    expect(calls).toEqual(sites.map((call) => (call.includes("#") ? call : `run#${call}`)).sort());
  });

  it("finds nothing in the support files", () => {
    expect(found.filter((site) => !site.startsWith(CASES_DIR))).toEqual([]);
  });
});

describe("storage deletion sites", () => {
  const found = scan();
  const counts = countSites(found);

  it("finds the known sites (the scan works)", () => {
    expect(found).toContain("packages/core/src/verify/gc.ts#sweepWithPermit#.delete");
  });

  it("registers every site with the deletion guard", () => {
    const unregistered = [...counts.keys()].filter((site) => !(site in DELETION_SITES));
    expect(
      unregistered,
      "register it with the deletion guard (DELETION_PASSES) in packages/core/src/storage/deletion-sites.ts",
    ).toEqual([]);
  });

  it("counts every occurrence of a registered site", () => {
    const miscounted = [...counts]
      .filter(([site, count]) => site in DELETION_SITES && count !== (SITE_COUNTS[site] ?? 1))
      .map(([site, count]) => `${site}: ${count} (expected ${SITE_COUNTS[site] ?? 1})`);
    expect(
      miscounted,
      "a further delete in a registered function runs under its pass too: check it, then count it in SITE_COUNTS",
    ).toEqual([]);
    const pointless = Object.entries(SITE_COUNTS).filter(
      ([site, count]) => !(site in DELETION_SITES) || count < 2,
    );
    expect(pointless).toEqual([]);
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
    const stale = Object.keys(DELETION_SITES).filter((site) => !counts.has(site));
    expect(stale).toEqual([]);
  });
}, 180_000);
