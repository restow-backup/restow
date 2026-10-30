import { describe, expect, it } from "vitest";
import { z } from "zod";
import { safeParseLegacy } from "./zod-issues.js";

/** The issues of a failed parse; every expectation below is what zod 3 answered. */
function issuesOf(schema: z.ZodTypeAny, input: unknown) {
  const result = safeParseLegacy(schema, input);
  if (result.success) {
    throw new Error("expected the input to be refused");
  }
  return result.issues;
}

describe("safeParseLegacy", () => {
  it("passes the data of a valid input through", () => {
    expect(safeParseLegacy(z.object({ a: z.string() }), { a: "x" })).toEqual({
      success: true,
      data: { a: "x" },
    });
  });

  it("describes a missing or mistyped value as zod 3 did", () => {
    const schema = z.object({ a: z.string(), n: z.number().int() });
    expect(issuesOf(schema, {})).toEqual([
      {
        code: "invalid_type",
        expected: "string",
        received: "undefined",
        path: ["a"],
        message: "Required",
      },
      {
        code: "invalid_type",
        expected: "number",
        received: "undefined",
        path: ["n"],
        message: "Required",
      },
    ]);
    expect(issuesOf(schema, { a: 1, n: 1.5 })).toEqual([
      {
        code: "invalid_type",
        expected: "string",
        received: "number",
        path: ["a"],
        message: "Expected string, received number",
      },
      {
        code: "invalid_type",
        expected: "integer",
        received: "float",
        path: ["n"],
        message: "Expected integer, received float",
      },
    ]);
    expect(issuesOf(schema, null)).toEqual([
      {
        code: "invalid_type",
        expected: "object",
        received: "null",
        path: [],
        message: "Expected object, received null",
      },
    ]);
  });

  it("names a record as an object and a tuple as an array, as zod 3 did", () => {
    const schema = z.object({
      a: z.record(z.string(), z.number()),
      t: z.tuple([z.string()]),
    });
    expect(issuesOf(schema, { a: "x", t: "y" })).toEqual([
      {
        code: "invalid_type",
        expected: "object",
        received: "string",
        path: ["a"],
        message: "Expected object, received string",
      },
      {
        code: "invalid_type",
        expected: "array",
        received: "string",
        path: ["t"],
        message: "Expected array, received string",
      },
    ]);
  });

  it("describes sizes with their bounds", () => {
    expect(issuesOf(z.object({ a: z.string().min(3) }), { a: "x" })).toEqual([
      {
        code: "too_small",
        minimum: 3,
        type: "string",
        inclusive: true,
        exact: false,
        message: "String must contain at least 3 character(s)",
        path: ["a"],
      },
    ]);
    expect(issuesOf(z.object({ a: z.number().positive() }), { a: 0 })).toEqual([
      {
        code: "too_small",
        minimum: 0,
        type: "number",
        inclusive: false,
        exact: false,
        message: "Number must be greater than 0",
        path: ["a"],
      },
    ]);
    expect(issuesOf(z.object({ a: z.array(z.string()).max(1) }), { a: ["a", "b"] })).toEqual([
      {
        code: "too_big",
        maximum: 1,
        type: "array",
        inclusive: true,
        exact: false,
        message: "Array must contain at most 1 element(s)",
        path: ["a"],
      },
    ]);
  });

  it("names the failed format of a string", () => {
    expect(issuesOf(z.object({ a: z.string().uuid() }), { a: "x" })).toEqual([
      { validation: "uuid", code: "invalid_string", message: "Invalid uuid", path: ["a"] },
    ]);
    expect(issuesOf(z.object({ a: z.string().email() }), { a: "x" })).toEqual([
      { validation: "email", code: "invalid_string", message: "Invalid email", path: ["a"] },
    ]);
    expect(issuesOf(z.object({ a: z.string().datetime({ offset: true }) }), { a: "x" })).toEqual([
      { validation: "datetime", code: "invalid_string", message: "Invalid datetime", path: ["a"] },
    ]);
  });

  it("describes enums, literals, unknown keys and unions", () => {
    expect(issuesOf(z.object({ a: z.enum(["x", "y"]) }), { a: "z" })).toEqual([
      {
        received: "z",
        code: "invalid_enum_value",
        options: ["x", "y"],
        path: ["a"],
        message: "Invalid enum value. Expected 'x' | 'y', received 'z'",
      },
    ]);
    expect(issuesOf(z.object({ a: z.literal("x") }), { a: "y" })).toEqual([
      {
        received: "y",
        code: "invalid_literal",
        expected: "x",
        path: ["a"],
        message: 'Invalid literal value, expected "x"',
      },
    ]);
    expect(issuesOf(z.object({ a: z.string() }).strict(), { a: "x", b: 1 })).toEqual([
      {
        code: "unrecognized_keys",
        keys: ["b"],
        path: [],
        message: "Unrecognized key(s) in object: 'b'",
      },
    ]);
    const union = z.discriminatedUnion("t", [
      z.object({ t: z.literal("a") }),
      z.object({ t: z.literal("b") }),
    ]);
    expect(issuesOf(union, { t: "c" })).toEqual([
      {
        code: "invalid_union_discriminator",
        options: ["a", "b"],
        path: ["t"],
        message: "Invalid discriminator value. Expected 'a' | 'b'",
      },
    ]);
  });

  it("keeps the message and path a schema sets itself", () => {
    const schema = z
      .object({ a: z.string().min(1, "required"), b: z.string() })
      .superRefine((_value, ctx) => {
        ctx.addIssue({ code: "custom", path: ["b"], message: "mine" });
      });
    expect(issuesOf(schema, { a: "", b: "x" })).toEqual([
      {
        code: "too_small",
        minimum: 1,
        type: "string",
        inclusive: true,
        exact: false,
        message: "required",
        path: ["a"],
      },
      { code: "custom", message: "mine", path: ["b"] },
    ]);
    expect(issuesOf(z.object({ a: z.string().refine(() => false) }), { a: "x" })).toEqual([
      { code: "custom", message: "Invalid input", path: ["a"] },
    ]);
  });

  it("never carries the submitted value", () => {
    const issues = issuesOf(z.object({ password: z.string().min(12) }), { password: "hunter2" });
    expect(JSON.stringify(issues)).not.toContain("hunter2");
  });
});
