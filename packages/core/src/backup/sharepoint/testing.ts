/**
 * A stateful fake of the SharePoint side of Microsoft Graph for tests: the
 * tenant's sites (`getAllSites`), a site, its libraries as drives with a root
 * delta that reports changes and deletions since a token, file downloads, the
 * libraries' root permissions, lists with columns and items (`expand=fields`),
 * and creating and patching list items. Nothing touches the network; every
 * call is recorded by the underlying fake Graph.
 *
 * No real Microsoft 365 tenant was available while this was written: the
 * shapes follow the Graph v1.0 reference (site, drive, driveItem, list,
 * columnDefinition, listItem), not recorded traffic.
 */
import {
  createFakeGraph,
  type FakeGraph,
  type FixtureResponse,
  type FixtureRoute,
  graphError,
  type RecordedCall,
} from "../../graph/testing/fake-graph.js";

export const FAKE_SP_DOWNLOAD_HOST = "https://contoso.sharepoint.example/download.aspx";

export interface FakeSpEntry {
  id: string;
  name: string;
  /** Parent item id; the library root's id for the top level. */
  parentId: string;
  kind: "folder" | "file";
  content: Buffer;
  /** Bumped with every content change (drives the cTag). */
  revision: number;
  /** Change counter of the library when the entry last changed. */
  changedAt: number;
  deletedAt: number | null;
  shared?: { scope: string };
}

export interface FakeSpLibrary {
  id: string;
  name: string;
  webUrl: string;
  entries: Map<string, FakeSpEntry>;
  /** Library change counter; delta tokens are `T<counter>`. */
  counter: number;
  /** Answer every request for this library with this status (403 = access denied). */
  refuse: number | null;
  permissions: unknown[];
}

export interface FakeSpListItem {
  id: string;
  fields: Record<string, unknown>;
  eTag: string;
  lastModifiedDateTime: string;
}

export interface FakeSpList {
  id: string;
  name: string;
  displayName: string;
  template: string;
  hidden: boolean;
  columns: Record<string, unknown>[];
  items: FakeSpListItem[];
  refuse: number | null;
}

export interface FakeSpSite {
  id: string;
  name: string;
  displayName: string;
  webUrl: string;
  description?: string;
  isPersonalSite?: boolean;
  libraries: FakeSpLibrary[];
  lists: FakeSpList[];
}

const NOT_FOUND: FixtureResponse = { status: 404, json: graphError("itemNotFound") };

function rootId(library: FakeSpLibrary): string {
  return `${library.id}-root`;
}

export class FakeSharePoint {
  readonly sites: FakeSpSite[] = [];
  readonly graph: FakeGraph;
  /** Answer `getAllSites` with this status instead (403 = Sites.Read.All missing). */
  refuseSiteListing: number | null = null;
  private nextId = 1;

  constructor(extraRoutes: FixtureRoute[] = []) {
    this.graph = createFakeGraph([...this.routes(), ...extraRoutes]);
  }

  addSite(input: {
    id: string;
    displayName: string;
    webUrl?: string;
    name?: string;
    isPersonalSite?: boolean;
  }): FakeSpSite {
    const site: FakeSpSite = {
      id: input.id,
      name: input.name ?? input.displayName.replace(/\s+/g, ""),
      displayName: input.displayName,
      webUrl: input.webUrl ?? `https://contoso.sharepoint.example/sites/${input.displayName}`,
      isPersonalSite: input.isPersonalSite,
      libraries: [],
      lists: [],
    };
    this.sites.push(site);
    return site;
  }

  addLibrary(site: FakeSpSite, name: string, id = `b!lib-${this.nextId++}`): FakeSpLibrary {
    const library: FakeSpLibrary = {
      id,
      name,
      webUrl: `${site.webUrl}/${encodeURIComponent(name)}`,
      entries: new Map(),
      counter: 1,
      refuse: null,
      permissions: [
        {
          id: "perm-owners",
          roles: ["owner"],
          grantedToV2: { siteGroup: { displayName: `${site.displayName} Owners` } },
        },
      ],
    };
    site.libraries.push(library);
    return library;
  }

  addFolder(library: FakeSpLibrary, name: string, parentId = rootId(library)): FakeSpEntry {
    return this.put(library, { name, parentId, kind: "folder", content: Buffer.alloc(0) });
  }

  addFile(
    library: FakeSpLibrary,
    name: string,
    content: string | Buffer,
    parentId = rootId(library),
  ): FakeSpEntry {
    return this.put(library, {
      name,
      parentId,
      kind: "file",
      content: typeof content === "string" ? Buffer.from(content) : content,
    });
  }

  private put(
    library: FakeSpLibrary,
    input: Pick<FakeSpEntry, "name" | "parentId" | "kind" | "content">,
  ): FakeSpEntry {
    library.counter++;
    const entry: FakeSpEntry = {
      id: `${library.id}-item-${this.nextId++}`,
      ...input,
      revision: 1,
      changedAt: library.counter,
      deletedAt: null,
    };
    library.entries.set(entry.id, entry);
    return entry;
  }

  /** Change a file's content (a new cTag, reported by the next delta). */
  changeFile(library: FakeSpLibrary, entry: FakeSpEntry, content: string | Buffer): void {
    library.counter++;
    entry.content = typeof content === "string" ? Buffer.from(content) : content;
    entry.revision++;
    entry.changedAt = library.counter;
  }

  deleteEntry(library: FakeSpLibrary, entry: FakeSpEntry): void {
    library.counter++;
    entry.deletedAt = library.counter;
    entry.changedAt = library.counter;
  }

  addList(
    site: FakeSpSite,
    input: {
      displayName: string;
      name?: string;
      template?: string;
      hidden?: boolean;
      columns?: Record<string, unknown>[];
    },
  ): FakeSpList {
    const list: FakeSpList = {
      id: `list-${this.nextId++}`,
      name: input.name ?? input.displayName.replace(/\s+/g, ""),
      displayName: input.displayName,
      template: input.template ?? "genericList",
      hidden: input.hidden ?? false,
      columns: input.columns ?? [
        { name: "Title", displayName: "Title", text: {} },
        { name: "Status", displayName: "Status", choice: { choices: ["Open", "Done"] } },
        { name: "Total", displayName: "Total", calculated: { formula: "=1" }, readOnly: true },
        { name: "Created", displayName: "Created", readOnly: true, dateTime: {} },
      ],
      items: [],
      refuse: null,
    };
    site.lists.push(list);
    return list;
  }

  addListItem(list: FakeSpList, fields: Record<string, unknown>): FakeSpListItem {
    const id = String(list.items.reduce((max, item) => Math.max(max, Number(item.id)), 0) + 1);
    const item: FakeSpListItem = {
      id,
      fields: { ...fields },
      eTag: `"${list.id}-${id},1"`,
      lastModifiedDateTime: "2026-09-01T08:00:00Z",
    };
    list.items.push(item);
    return item;
  }

  changeListItem(item: FakeSpListItem, fields: Record<string, unknown>): void {
    item.fields = { ...item.fields, ...fields };
    const version = Number(/,(\d+)"$/.exec(item.eTag)?.[1] ?? "1") + 1;
    item.eTag = item.eTag.replace(/,\d+"$/, `,${version}"`);
    item.lastModifiedDateTime = "2026-09-10T08:00:00Z";
  }

  // -------------------------------------------------------------------------
  // JSON shapes

  private siteJson(site: FakeSpSite): Record<string, unknown> {
    return {
      id: site.id,
      name: site.name,
      displayName: site.displayName,
      description: site.description ?? "",
      webUrl: site.webUrl,
      createdDateTime: "2024-01-01T00:00:00Z",
      lastModifiedDateTime: "2026-09-01T00:00:00Z",
      siteCollection: { hostname: "contoso.sharepoint.example" },
      isPersonalSite: site.isPersonalSite ?? false,
    };
  }

  private pathOf(library: FakeSpLibrary, id: string): string {
    if (id === rootId(library)) {
      return "";
    }
    const entry = library.entries.get(id);
    if (!entry) {
      return "";
    }
    const parent = this.pathOf(library, entry.parentId);
    return parent.length === 0 ? entry.name : `${parent}/${entry.name}`;
  }

  entryJson(library: FakeSpLibrary, entry: FakeSpEntry): Record<string, unknown> {
    if (entry.deletedAt !== null) {
      return {
        id: entry.id,
        deleted: { state: "deleted" },
        parentReference: { driveId: library.id },
      };
    }
    const parentPath = this.pathOf(library, entry.parentId);
    const base: Record<string, unknown> = {
      id: entry.id,
      name: entry.name,
      eTag: `"{${entry.id}},${entry.revision}"`,
      parentReference: {
        driveId: library.id,
        driveType: "documentLibrary",
        id: entry.parentId,
        path: `/drives/${library.id}/root:${parentPath.length === 0 ? "" : `/${parentPath}`}`,
      },
      fileSystemInfo: {
        createdDateTime: "2025-01-01T00:00:00Z",
        lastModifiedDateTime: `2026-09-0${Math.min(9, entry.revision)}T00:00:00Z`,
      },
      createdBy: { user: { displayName: "Alice Example" } },
      ...(entry.shared ? { shared: entry.shared } : {}),
    };
    if (entry.kind === "folder") {
      return { ...base, folder: { childCount: 0 } };
    }
    return {
      ...base,
      size: entry.content.length,
      cTag: `"c:{${entry.id}},${entry.revision}"`,
      file: { mimeType: "application/octet-stream", hashes: {} },
      "@microsoft.graph.downloadUrl": `${FAKE_SP_DOWNLOAD_HOST}?item=${encodeURIComponent(entry.id)}&rev=${entry.revision}`,
    };
  }

  private listJson(list: FakeSpList): Record<string, unknown> {
    return {
      id: list.id,
      name: list.name,
      displayName: list.displayName,
      webUrl: `https://contoso.sharepoint.example/Lists/${list.name}`,
      createdDateTime: "2025-01-01T00:00:00Z",
      lastModifiedDateTime: "2026-09-01T00:00:00Z",
      list: { template: list.template, hidden: list.hidden },
    };
  }

  private itemJson(item: FakeSpListItem): Record<string, unknown> {
    return {
      id: item.id,
      eTag: item.eTag,
      createdDateTime: "2025-06-01T08:00:00Z",
      lastModifiedDateTime: item.lastModifiedDateTime,
      createdBy: { user: { displayName: "Alice Example" } },
      lastModifiedBy: { user: { displayName: "Bob Example" } },
      contentType: { id: "0x01", name: "Item" },
      fields: { "@odata.etag": item.eTag, id: item.id, ...item.fields },
    };
  }

  // -------------------------------------------------------------------------
  // Lookups

  private siteBy(segment: string): FakeSpSite | undefined {
    const id = decodeURIComponent(segment);
    return this.sites.find((site) => site.id === id);
  }

  private libraryBy(segment: string): FakeSpLibrary | undefined {
    const id = decodeURIComponent(segment);
    for (const site of this.sites) {
      const library = site.libraries.find((candidate) => candidate.id === id);
      if (library) {
        return library;
      }
    }
    return undefined;
  }

  private delta(library: FakeSpLibrary, url: URL): FixtureResponse {
    if (library.refuse !== null) {
      return { status: library.refuse, json: graphError("accessDenied") };
    }
    const token = url.searchParams.get("token");
    const since = token === null ? 0 : Number(token.slice(1));
    const root = { id: rootId(library), name: "root", root: {}, folder: {} };
    const entries = [...library.entries.values()].filter((entry) =>
      token === null ? entry.deletedAt === null : entry.changedAt > since,
    );
    const link = `https://graph.microsoft.com/v1.0/drives/${library.id}/root/delta?token=T${library.counter}`;
    return {
      status: 200,
      json: {
        "@odata.deltaLink": link,
        value: [
          ...(token === null ? [root] : []),
          ...entries.map((entry) => this.entryJson(library, entry)),
        ],
      },
    };
  }

  private routes(): FixtureRoute[] {
    const pathMatch = (pattern: RegExp) => (url: URL) => pattern.test(url.pathname);
    const segments = (call: RecordedCall) => new URL(call.url).pathname.split("/");
    return [
      {
        method: "GET",
        url: pathMatch(/^\/v1\.0\/sites\/getAllSites$/),
        respond: () =>
          this.refuseSiteListing !== null
            ? { status: this.refuseSiteListing, json: graphError("accessDenied") }
            : { status: 200, json: { value: this.sites.map((site) => this.siteJson(site)) } },
      },
      {
        method: "GET",
        url: pathMatch(/^\/v1\.0\/sites\/[^/]+$/),
        respond: (call) => {
          const site = this.siteBy(segments(call)[3] ?? "");
          return site ? { status: 200, json: this.siteJson(site) } : NOT_FOUND;
        },
      },
      {
        method: "GET",
        url: pathMatch(/^\/v1\.0\/sites\/[^/]+\/drives$/),
        respond: (call) => {
          const site = this.siteBy(segments(call)[3] ?? "");
          if (!site) {
            return NOT_FOUND;
          }
          return {
            status: 200,
            json: {
              value: site.libraries.map((library) => ({
                id: library.id,
                name: library.name,
                driveType: "documentLibrary",
                webUrl: library.webUrl,
                createdDateTime: "2025-01-01T00:00:00Z",
                lastModifiedDateTime: "2026-09-01T00:00:00Z",
              })),
            },
          };
        },
      },
      {
        method: "GET",
        url: pathMatch(/^\/v1\.0\/drives\/[^/]+$/),
        respond: (call) => {
          const library = this.libraryBy(segments(call)[3] ?? "");
          return library
            ? {
                status: 200,
                json: { id: library.id, name: library.name, driveType: "documentLibrary" },
              }
            : NOT_FOUND;
        },
      },
      {
        method: "GET",
        url: pathMatch(/^\/v1\.0\/drives\/[^/]+\/root\/delta$/),
        respond: (call) => {
          const library = this.libraryBy(segments(call)[3] ?? "");
          return library ? this.delta(library, new URL(call.url)) : NOT_FOUND;
        },
      },
      {
        method: "GET",
        url: pathMatch(/^\/v1\.0\/drives\/[^/]+\/root\/permissions$/),
        respond: (call) => {
          const library = this.libraryBy(segments(call)[3] ?? "");
          if (!library) {
            return NOT_FOUND;
          }
          return library.refuse !== null
            ? { status: library.refuse, json: graphError("accessDenied") }
            : { status: 200, json: { value: library.permissions } };
        },
      },
      {
        method: "GET",
        url: (url) => url.href.startsWith(FAKE_SP_DOWNLOAD_HOST),
        respond: (call) => {
          const url = new URL(call.url);
          const id = url.searchParams.get("item") ?? "";
          for (const site of this.sites) {
            for (const library of site.libraries) {
              const entry = library.entries.get(id);
              if (entry && entry.deletedAt === null) {
                return { status: 200, bytes: new Uint8Array(entry.content) };
              }
            }
          }
          return NOT_FOUND;
        },
      },
      {
        method: "GET",
        url: pathMatch(/^\/v1\.0\/sites\/[^/]+\/lists$/),
        respond: (call) => {
          const site = this.siteBy(segments(call)[3] ?? "");
          if (!site) {
            return NOT_FOUND;
          }
          const libraries = site.libraries.map((library) => ({
            id: `list-of-${library.id}`,
            name: library.name,
            displayName: library.name,
            list: { template: "documentLibrary", hidden: false },
          }));
          return {
            status: 200,
            json: { value: [...libraries, ...site.lists.map((list) => this.listJson(list))] },
          };
        },
      },
      {
        method: "GET",
        url: pathMatch(/^\/v1\.0\/sites\/[^/]+\/lists\/[^/]+\/columns$/),
        respond: (call) => {
          const list = this.listOf(call);
          if (!list) {
            return NOT_FOUND;
          }
          return list.refuse !== null
            ? { status: list.refuse, json: graphError("accessDenied") }
            : { status: 200, json: { value: list.columns } };
        },
      },
      {
        method: "GET",
        url: pathMatch(/^\/v1\.0\/sites\/[^/]+\/lists\/[^/]+\/items$/),
        respond: (call) => {
          const list = this.listOf(call);
          if (!list) {
            return NOT_FOUND;
          }
          if (list.refuse !== null) {
            return { status: list.refuse, json: graphError("accessDenied") };
          }
          // Two items per page, so paging is exercised.
          const url = new URL(call.url);
          const skip = Number(url.searchParams.get("skip") ?? "0");
          const page = list.items.slice(skip, skip + 2);
          const next = skip + 2 < list.items.length;
          const nextUrl = new URL(url.href);
          nextUrl.searchParams.set("skip", String(skip + 2));
          return {
            status: 200,
            json: {
              value: page.map((item) => this.itemJson(item)),
              ...(next ? { "@odata.nextLink": nextUrl.href } : {}),
            },
          };
        },
      },
      {
        method: "GET",
        url: pathMatch(/^\/v1\.0\/sites\/[^/]+\/lists\/[^/]+\/items\/[^/]+$/),
        respond: (call) => {
          const list = this.listOf(call);
          const id = decodeURIComponent(segments(call)[7] ?? "");
          const item = list?.items.find((candidate) => candidate.id === id);
          return item ? { status: 200, json: this.itemJson(item) } : NOT_FOUND;
        },
      },
      {
        method: "POST",
        url: pathMatch(/^\/v1\.0\/sites\/[^/]+\/lists\/[^/]+\/items$/),
        respond: (call) => {
          const list = this.listOf(call);
          if (!list) {
            return NOT_FOUND;
          }
          const body = call.json as { fields?: Record<string, unknown> };
          const invalid = Object.keys(body.fields ?? {}).find(
            (key) =>
              !key.includes("@") &&
              !list.columns.some(
                (column) => column.name === key || `${column.name}LookupId` === key,
              ),
          );
          if (invalid) {
            return {
              status: 400,
              json: graphError("invalidRequest", `Field '${invalid}' is not recognized`),
            };
          }
          const readOnly = list.columns.find(
            (column) =>
              column.readOnly === true && body.fields?.[String(column.name)] !== undefined,
          );
          if (readOnly) {
            return {
              status: 400,
              json: graphError("invalidRequest", `Field '${readOnly.name}' is read-only`),
            };
          }
          const item = this.addListItem(list, body.fields ?? {});
          return { status: 201, json: this.itemJson(item) };
        },
      },
      {
        method: "PATCH",
        url: pathMatch(/^\/v1\.0\/sites\/[^/]+\/lists\/[^/]+\/items\/[^/]+\/fields$/),
        respond: (call) => {
          const list = this.listOf(call);
          const id = decodeURIComponent(segments(call)[7] ?? "");
          const item = list?.items.find((candidate) => candidate.id === id);
          if (!item) {
            return NOT_FOUND;
          }
          this.changeListItem(item, (call.json as Record<string, unknown>) ?? {});
          return { status: 200, json: item.fields };
        },
      },
    ];
  }

  private listOf(call: RecordedCall): FakeSpList | undefined {
    const parts = new URL(call.url).pathname.split("/");
    const site = this.siteBy(parts[3] ?? "");
    const listId = decodeURIComponent(parts[5] ?? "");
    return site?.lists.find((list) => list.id === listId);
  }
}
