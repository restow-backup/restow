import type {
  FieldError,
  FieldErrors,
  FieldValues,
  Resolver,
  ResolverResult,
} from "react-hook-form";
import type { ZodType } from "zod";

/**
 * Minimal zod resolver for react-hook-form. We avoid the `@hookform/resolvers`
 * dependency. Schemas pass a short reason (e.g. `"email"`, `"required"`) as
 * the issue message; the form maps it to an i18n key with
 * {@link validationKey}, so zod's built-in English text never reaches the UI.
 */
export function zodResolver<TValues extends FieldValues>(
  schema: ZodType<TValues>,
): Resolver<TValues> {
  return (values): ResolverResult<TValues> => {
    const result = schema.safeParse(values);

    if (result.success) {
      return { values: result.data, errors: {} };
    }

    const errors: Record<string, unknown> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.map(String);
      if (path.length > 0 && getPath(errors, path) === undefined) {
        const error: FieldError = { type: issue.code, message: issue.message };
        setPath(errors, path, error);
      }
    }

    return { values: {}, errors: errors as FieldErrors<TValues> };
  };
}

function getPath(target: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = target;
  for (const key of path) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current = target;
  path.forEach((key, index) => {
    if (index === path.length - 1) {
      current[key] = value;
      return;
    }
    const next = current[key];
    if (typeof next !== "object" || next === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  });
}

const KNOWN_REASONS = new Set([
  "required",
  "email",
  "url",
  "httpsRequired",
  "port",
  "minLength",
  "passwordMismatch",
  "totp",
  "emailInUse",
]);

/**
 * Map a field error to its `common:validation.*` key. Unknown reasons (zod
 * defaults) fall back to `required`, which is always a true statement for a
 * failed field and never leaks untranslated text.
 */
export function validationKey(error: FieldError | undefined): string | undefined {
  if (!error) {
    return undefined;
  }
  const reason = typeof error.message === "string" ? error.message : "";
  return `validation.${KNOWN_REASONS.has(reason) ? reason : "required"}`;
}
