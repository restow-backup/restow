/**
 * Indexes the site run keeps so that a library or list never scans every object of the site: a
 * site has thousands of lists and libraries and a million items, and one scan per list or
 * library made a run quadratic.
 */
import type { SnapshotWriter } from "../../engine/snapshot.js";
import type { ManifestObject } from "../../manifest.js";
import { SITE_OBJECT_TYPES } from "./layout.js";

function byPath(a: ManifestObject, b: ManifestObject): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** The previous snapshot's objects, indexed once by folder and by list. */
export class PreviousSiteObjects {
  /** In path order: the objects below a folder are one run of it. */
  private readonly sorted: readonly ManifestObject[];
  private byList: Map<string, Map<string, ManifestObject>> | null = null;
  private schemas: Map<string, ManifestObject> | null = null;

  constructor(objects: readonly ManifestObject[]) {
    // A manifest lists its objects in path order already; the stable sort keeps them so.
    this.sorted = [...objects].sort(byPath);
  }

  /** The objects below `prefix`, relative to it (as `objectsBelow`), in path order. */
  below(prefix: string): ManifestObject[] {
    const head = `${prefix}/`;
    const result: ManifestObject[] = [];
    for (let i = this.lowerBound(head); i < this.sorted.length; i++) {
      const object = this.sorted[i] as ManifestObject;
      if (!object.path.startsWith(head)) {
        break;
      }
      result.push({ ...object, path: object.path.slice(head.length) });
    }
    return result;
  }

  /** The items of a list, by list item id (wherever the list lay then). */
  listItems(listId: string): ReadonlyMap<string, ManifestObject> {
    this.indexLists();
    return this.byList?.get(listId) ?? new Map();
  }

  /** The column schema of a list. */
  listSchema(listId: string): ManifestObject | undefined {
    this.indexLists();
    return this.schemas?.get(listId);
  }

  /** The first index whose path sorts at or after `head`. */
  private lowerBound(head: string): number {
    let low = 0;
    let high = this.sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.sorted[middle] as ManifestObject).path < head) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  private indexLists(): void {
    if (this.byList && this.schemas) {
      return;
    }
    const byList = new Map<string, Map<string, ManifestObject>>();
    const schemas = new Map<string, ManifestObject>();
    for (const object of this.sorted) {
      const listId = object.metadata?.listId;
      if (listId === undefined) {
        continue;
      }
      if (object.type === SITE_OBJECT_TYPES.listItem && object.metadata?.listItemId !== undefined) {
        let items = byList.get(listId);
        if (!items) {
          items = new Map();
          byList.set(listId, items);
        }
        items.set(object.metadata.listItemId, object);
      } else if (object.type === SITE_OBJECT_TYPES.listSchema && !schemas.has(listId)) {
        schemas.set(listId, object);
      }
    }
    this.byList = byList;
    this.schemas = schemas;
  }
}

/**
 * The writer's paths below each library or list folder (`Libraries/<folder>`,
 * `Lists/<folder>`). Everything below those folders goes through `replaceBelow`, which keeps
 * this in step with the writer.
 */
export class WriterFolders {
  private readonly paths = new Map<string, Set<string>>();

  constructor(private readonly writer: SnapshotWriter) {
    // What a resumed run's checkpoint brought along.
    for (const object of writer.listObjects()) {
      const parts = object.path.split("/");
      if (parts.length > 2) {
        this.of(`${parts[0]}/${parts[1]}`).add(object.path);
      }
    }
  }

  /** The objects below `prefix`, relative to it, in path order. */
  below(prefix: string): ManifestObject[] {
    const head = `${prefix}/`;
    const result: ManifestObject[] = [];
    for (const path of [...this.of(prefix)].sort()) {
      const object = this.writer.get(path);
      if (object) {
        result.push({ ...object, path: path.slice(head.length) });
      }
    }
    return result;
  }

  /** Make the writer hold exactly `objects` (full paths, all below `prefix`) below `prefix`. */
  replace(prefix: string, objects: readonly ManifestObject[]): void {
    const wanted = new Map(objects.map((object) => [object.path, object]));
    const paths = this.of(prefix);
    for (const path of paths) {
      if (!wanted.has(path)) {
        this.writer.remove(path);
        paths.delete(path);
      }
    }
    for (const object of wanted.values()) {
      this.writer.add(object);
      paths.add(object.path);
    }
  }

  /** Forget a folder `sweep` removed from the writer. */
  forget(prefix: string): void {
    this.paths.delete(prefix);
  }

  private of(prefix: string): Set<string> {
    let paths = this.paths.get(prefix);
    if (!paths) {
      paths = new Set();
      this.paths.set(prefix, paths);
    }
    return paths;
  }
}
