/**
 * Small helpers shared by the resource modules: URL building, OData quoting,
 * paging over `@odata.nextLink`, and turning non-2xx answers into GraphError.
 */
import type { GraphClient, GraphRequest, GraphResponse } from "../client.js";
import { GraphError } from "../errors.js";

/** One page of a collection response. */
export interface CollectionPage<T> {
  value?: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

/** Perform a request and return the body, throwing {@link GraphError} on non-2xx. */
export async function requestOk<T>(client: GraphClient, req: GraphRequest): Promise<T> {
  const response = await client.request<T>(req);
  return bodyOrThrow(response, req);
}

/** Return the body of a 2xx response, otherwise throw a {@link GraphError}. */
export function bodyOrThrow<T>(response: GraphResponse<T>, req: GraphRequest): T {
  if (response.status >= 200 && response.status < 300) {
    return response.body;
  }
  throw new GraphError({
    status: response.status,
    method: req.method,
    url: req.url,
    headers: response.headers,
    payload: response.body,
  });
}

/** Iterate all items of a paged collection, following `@odata.nextLink`. */
export async function* paginate<T>(
  client: GraphClient,
  url: string,
  headers?: Record<string, string>,
): AsyncGenerator<T, void, unknown> {
  let next: string | undefined = url;
  while (next) {
    const req: GraphRequest = { method: "GET", url: next, headers };
    const page: CollectionPage<T> = await requestOk<CollectionPage<T>>(client, req);
    for (const item of page.value ?? []) {
      yield item;
    }
    next = page["@odata.nextLink"];
  }
}

/** Drain an async iterator into an array. */
export async function collect<T>(iterator: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterator) {
    items.push(item);
  }
  return items;
}

/** `/users/{id}` with the id (or UPN) safely encoded. */
export function userPath(userId: string): string {
  return `/users/${encodeURIComponent(userId)}`;
}

/** Quote a string for an OData `$filter` literal (single quotes are doubled). */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Build a query string from defined entries; keys are used verbatim, values encoded. */
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** Split a folder path on `/` and drop empty segments. */
export function splitPath(path: string | string[]): string[] {
  const segments = Array.isArray(path) ? path : path.split("/");
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Remove OData annotations (`@odata.*`, `@removed`, `@microsoft.graph.*`) and given keys. */
export function stripReadOnly<T extends Record<string, unknown>>(
  item: T,
  readOnlyKeys: readonly string[],
): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    if (key.includes("@") || readOnlyKeys.includes(key) || value === undefined) {
      continue;
    }
    result[key] = value;
  }
  return result as Partial<T>;
}
