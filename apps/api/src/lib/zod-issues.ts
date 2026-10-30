import type { z } from "zod";

/**
 * Validation issues in the shape the API has always answered with (the `issues` member of a 422
 * problem, docs/ARCHITECTURE.md "API"): `code`, `path` and `message`, plus the details the code
 * names (`expected`/`received`, `minimum`/`type`, `validation`, `options`, ...).
 *
 * zod 4 renamed several codes and fields and rewrote its default messages. Clients of the
 * integration API and the web UI read these bodies, so the shape stays the one of zod 3: the
 * messages come from {@link legacyErrorMap} (per call, so better-auth and every other user of
 * zod in the process keep zod's own wording), the fields from {@link legacyIssues}. A message a
 * schema sets itself (`.min(1, "required")`) always wins over the map and passes through.
 */

export interface LegacyIssue {
  code: string;
  path: (string | number)[];
  message: string;
  [detail: string]: unknown;
}

/** What zod hands the error map and puts in an issue; the fields we read, all optional. */
interface RawIssue {
  code?: string;
  input?: unknown;
  path?: PropertyKey[];
  message?: string;
  expected?: string;
  received?: string;
  origin?: string;
  format?: string;
  values?: unknown[];
  minimum?: unknown;
  maximum?: unknown;
  inclusive?: boolean;
  exact?: boolean;
  divisor?: number;
  keys?: string[];
  note?: string;
  options?: unknown[];
  prefix?: string;
  suffix?: string;
  includes?: string;
  pattern?: string;
  params?: unknown;
  errors?: RawIssue[][];
}

/** zod 3's name for the type of a value (`getParsedType`). */
function parsedType(value: unknown): string {
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(value) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    default:
      break;
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  if (value instanceof Promise) {
    return "promise";
  }
  if (value instanceof Map) {
    return "map";
  }
  if (value instanceof Set) {
    return "set";
  }
  if (value instanceof Date) {
    return "date";
  }
  return "object";
}

function joinValues(values: readonly unknown[], separator = " | "): string {
  return values.map((value) => (typeof value === "string" ? `'${value}'` : value)).join(separator);
}

function isInvalidDate(issue: RawIssue): boolean {
  return issue.expected === "date" && issue.received === "Invalid Date";
}

/** The kind of a bounded value, as zod 3 named it in `type`. */
function boundedType(origin: string | undefined): string {
  return origin === "int" || origin === "number" ? "number" : (origin ?? "number");
}

function sizeMessage(issue: RawIssue, direction: "min" | "max"): string | undefined {
  const type = boundedType(issue.origin);
  const bound = direction === "min" ? issue.minimum : issue.maximum;
  const exact = issue.exact === true;
  const more = direction === "min";
  switch (type) {
    case "array":
    case "set":
      return `Array must contain ${
        exact
          ? "exactly"
          : issue.inclusive
            ? (more ? "at least" : "at most")
            : more
              ? "more than"
              : "less than"
      } ${bound} element(s)`;
    case "string":
      return `String must contain ${
        exact
          ? "exactly"
          : issue.inclusive
            ? (more ? "at least" : "at most")
            : more
              ? "over"
              : "under"
      } ${bound} character(s)`;
    case "number":
      return `Number must be ${
        exact
          ? "exactly equal to "
          : issue.inclusive
            ? more
              ? "greater than or equal to "
              : "less than or equal to "
            : more
              ? "greater than "
              : "less than "
      }${bound}`;
    default:
      return undefined;
  }
}

/** zod 3 named the parsed types "integer", "object" (also for records) and "array" (also for tuples). */
function legacyExpected(expected: string | undefined): string | undefined {
  switch (expected) {
    case "int":
      return "integer";
    case "record":
      return "object";
    case "tuple":
      return "array";
    default:
      return expected;
  }
}

/** The default message zod 3 gave an issue, or undefined to leave zod 4's own wording. */
function legacyMessage(issue: RawIssue): string | undefined {
  switch (issue.code) {
    case "invalid_type": {
      if (isInvalidDate(issue)) {
        return "Invalid date";
      }
      const received = parsedType(issue.input);
      if (received === "undefined") {
        return "Required";
      }
      return `Expected ${legacyExpected(issue.expected)}, received ${
        issue.expected === "int" && received === "number" ? "float" : received
      }`;
    }
    case "too_small":
      return sizeMessage(issue, "min");
    case "too_big":
      return sizeMessage(issue, "max");
    case "not_multiple_of":
      return `Number must be a multiple of ${issue.divisor}`;
    case "invalid_format":
      switch (issue.format) {
        case "regex":
          return "Invalid";
        case "starts_with":
          return `Invalid input: must start with "${issue.prefix}"`;
        case "ends_with":
          return `Invalid input: must end with "${issue.suffix}"`;
        case "includes":
          return `Invalid input: must include "${issue.includes}"`;
        case "guid":
          return "Invalid uuid";
        default:
          return `Invalid ${issue.format}`;
      }
    case "invalid_value": {
      const values = issue.values ?? [];
      if (values.length === 1) {
        return `Invalid literal value, expected ${JSON.stringify(values[0])}`;
      }
      if (typeof issue.input === "string") {
        return `Invalid enum value. Expected ${joinValues(values)}, received '${issue.input}'`;
      }
      return issue.input === undefined
        ? "Required"
        : `Expected ${joinValues(values)}, received ${parsedType(issue.input)}`;
    }
    case "unrecognized_keys":
      return `Unrecognized key(s) in object: ${(issue.keys ?? []).map((key) => `'${key}'`).join(", ")}`;
    case "invalid_union":
      return issue.note === "No matching discriminator"
        ? `Invalid discriminator value. Expected ${joinValues(issue.options ?? [])}`
        : "Invalid input";
    default:
      return undefined;
  }
}

/** Pass as `{ error }` to `safeParse`: zod 3's default messages for the issues without their own. */
export function legacyErrorMap(issue: RawIssue): string | undefined {
  return legacyMessage(issue);
}

function legacyPath(path: readonly PropertyKey[] | undefined): (string | number)[] {
  return (path ?? []).map((segment) => (typeof segment === "number" ? segment : String(segment)));
}

function legacyIssue(issue: RawIssue, parentPath: (string | number)[] = []): LegacyIssue {
  const path = [...parentPath, ...legacyPath(issue.path)];
  const message = issue.message ?? "Invalid input";
  switch (issue.code) {
    case "invalid_type": {
      if (isInvalidDate(issue)) {
        return { code: "invalid_date", path, message };
      }
      const received = parsedType(issue.input);
      return {
        code: "invalid_type",
        expected: legacyExpected(issue.expected),
        received: issue.expected === "int" && received === "number" ? "float" : received,
        path,
        message,
      };
    }
    case "too_small":
    case "too_big": {
      const small = issue.code === "too_small";
      return {
        code: issue.code,
        [small ? "minimum" : "maximum"]: small ? issue.minimum : issue.maximum,
        type: boundedType(issue.origin),
        inclusive: issue.inclusive ?? false,
        exact: issue.exact ?? false,
        message,
        path,
      };
    }
    case "not_multiple_of":
      return { code: issue.code, multipleOf: issue.divisor, message, path };
    case "invalid_format": {
      const validation =
        issue.format === "starts_with"
          ? { startsWith: issue.prefix }
          : issue.format === "ends_with"
            ? { endsWith: issue.suffix }
            : issue.format === "includes"
              ? { includes: issue.includes }
              : issue.format === "guid"
                ? "uuid"
                : issue.format;
      return { validation, code: "invalid_string", message, path };
    }
    case "invalid_value": {
      const values = issue.values ?? [];
      if (values.length === 1) {
        return {
          received: issue.input,
          code: "invalid_literal",
          expected: values[0],
          path,
          message,
        };
      }
      if (typeof issue.input === "string") {
        return {
          received: issue.input,
          code: "invalid_enum_value",
          options: values,
          path,
          message,
        };
      }
      return {
        expected: joinValues(values),
        received: parsedType(issue.input),
        code: "invalid_type",
        path,
        message,
      };
    }
    case "unrecognized_keys":
      return { code: issue.code, keys: issue.keys, path, message };
    case "invalid_union":
      if (issue.note === "No matching discriminator") {
        return { code: "invalid_union_discriminator", options: issue.options, path, message };
      }
      return {
        code: "invalid_union",
        unionErrors: (issue.errors ?? []).map((errors) => ({
          issues: errors.map((nested) => legacyIssue(nested, path)),
          name: "ZodError",
        })),
        path,
        message,
      };
    case "custom":
      return {
        code: "custom",
        ...(issue.params === undefined ? {} : { params: issue.params }),
        message,
        path,
      };
    default: {
      const {
        input: _input,
        inst: _inst,
        continue: _continue,
        ...rest
      } = issue as RawIssue & {
        inst?: unknown;
        continue?: unknown;
      };
      return { ...rest, code: issue.code ?? "custom", path, message };
    }
  }
}

/** The issues of a failed parse (made with `reportInput`) in the shape of zod 3. */
export function legacyIssues(error: z.ZodError): LegacyIssue[] {
  return (error.issues as unknown as RawIssue[]).map((issue) => legacyIssue(issue));
}

export type LegacyParse<T> =
  | { success: true; data: T }
  | { success: false; issues: LegacyIssue[]; error: z.ZodError };

/**
 * `schema.safeParse(data)` whose failure carries zod 3's issues. Use it wherever the issues or
 * their messages reach a client.
 */
export function safeParseLegacy<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
): LegacyParse<z.infer<S>> {
  const result = schema.safeParse(data, { error: legacyErrorMap, reportInput: true });
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, issues: legacyIssues(result.error), error: result.error };
}
