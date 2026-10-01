import type { z } from "zod";

/**
 * Named response shapes of the OpenAPI document. A schema registered here is
 * written once under `#/components/schemas/<name>` and referenced wherever the
 * document meets that schema instance, so client generators produce proper
 * model types. Registration is by instance: `.describe()`, `.extend()` and
 * friends return new, unnamed instances.
 */

const names = new WeakMap<z.ZodTypeAny, string>();

export function component<T extends z.ZodTypeAny>(name: string, schema: T): T {
  names.set(schema, name);
  return schema;
}

export function componentName(schema: z.ZodTypeAny): string | undefined {
  return names.get(schema);
}
