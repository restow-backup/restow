/**
 * DriveTree: the drive as the snapshot will record it, tracked by Graph item id.
 *
 * Graph's delta feed talks in ids and promises no order: a rename or move
 * yields only the moved item (never its descendants), a deletion yields only
 * an id, and a child may arrive before its parent or after its parent's
 * deletion. Graph's guidance is to track items by id and derive paths. So the
 * tree keeps one node per item (parent id plus name) and computes paths only
 * when a manifest is written:
 *
 *   move      one node update; everything below follows implicitly
 *   delete    the node goes; whatever still hangs below it at commit time goes
 *             with it, so an item moved out of a folder that is deleted in the
 *             same feed survives whichever order Graph reports the two in
 *   versions  children of their file: they move and disappear with it
 *
 * Every node keeps the path it was last known under (from Graph, from the
 * manifest it was loaded from, or from the last materialization). That path is
 * used only when the parent chain cannot be followed, e.g. while a deleted
 * parent's dangling children are checkpointed mid-run.
 */
import type { ManifestObject } from "../../manifest.js";
import { ONEDRIVE_OBJECT_TYPES, VERSION_PATH_MARKER, joinPath } from "./items.js";

/** Where an item hangs: its parent's Graph id (null when unknown) and its own name. */
export interface Placement {
  readonly parentId: string | null;
  /** The item name, or the version id for a file version. */
  readonly name: string;
}

interface DriveNode extends Placement {
  readonly id: string;
  object: ManifestObject;
  /** Order of recording; the later of two nodes claiming one path wins. */
  readonly sequence: number;
}

export interface MaterializedTree {
  /** Every object with its derived path. */
  readonly objects: ManifestObject[];
  /** Objects dropped because an ancestor was deleted (only when cascading). */
  readonly cascaded: number;
  /** Paths claimed by more than one item; the most recently recorded item was kept. */
  readonly collisions: readonly string[];
}

/** Synthetic id for objects without a source id (never written by this engine; tolerated on load). */
function syntheticId(object: ManifestObject): string {
  return `path:${object.path}`;
}

function isVersion(object: ManifestObject): boolean {
  return object.type === ONEDRIVE_OBJECT_TYPES.version;
}

export class DriveTree {
  /** Graph id of the drive's root item; its children are the top level. */
  rootId: string | null;
  private readonly nodes = new Map<string, DriveNode>();
  private readonly versionIdsByItem = new Map<string, Set<string>>();
  private readonly deleted = new Set<string>();
  private sequence = 0;

  constructor(rootId: string | null = null) {
    this.rootId = rootId;
  }

  /**
   * Rebuild a tree from manifest objects (the previous snapshot, or the
   * partial manifest of a checkpoint), plus the deletions a checkpointed run
   * had seen but not yet cascaded.
   */
  static fromObjects(
    objects: Iterable<ManifestObject>,
    options: { rootId: string | null; deleted?: Iterable<string> },
  ): DriveTree {
    const tree = new DriveTree(options.rootId);
    const list = [...objects];
    const idAtPath = new Map<string, string>();
    for (const object of list) {
      idAtPath.set(object.path, object.id ?? syntheticId(object));
    }
    for (const object of list) {
      tree.insert(object.id ?? syntheticId(object), object, tree.placementOf(object, idAtPath), 0);
    }
    for (const id of options.deleted ?? []) {
      tree.deleted.add(id);
    }
    return tree;
  }

  /** Placement of a stored object: from its recorded parent, or from its path when that is missing. */
  private placementOf(object: ManifestObject, idAtPath: ReadonlyMap<string, string>): Placement {
    if (isVersion(object)) {
      const marker = object.path.lastIndexOf(VERSION_PATH_MARKER);
      const filePath = marker === -1 ? "" : object.path.slice(0, marker);
      return {
        parentId: object.metadata?.itemId ?? idAtPath.get(filePath) ?? null,
        name: object.metadata?.versionId ?? object.path.slice(marker + VERSION_PATH_MARKER.length),
      };
    }
    const slash = object.path.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : object.path.slice(0, slash);
    const fallbackParent = parentPath === "" ? this.rootId : (idAtPath.get(parentPath) ?? null);
    return {
      parentId: object.metadata?.parentId ?? fallbackParent,
      name: object.path.slice(slash + 1),
    };
  }

  get size(): number {
    return this.nodes.size;
  }

  get(id: string): ManifestObject | undefined {
    return this.nodes.get(id)?.object;
  }

  /** Stored versions of a file. */
  versionsOf(itemId: string): ManifestObject[] {
    const ids = this.versionIdsByItem.get(itemId) ?? new Set<string>();
    return [...ids].flatMap((id) => {
      const object = this.nodes.get(id)?.object;
      return object ? [object] : [];
    });
  }

  /** Ids deleted in this run whose descendants are cascaded at commit. */
  deletedIds(): string[] {
    return [...this.deleted];
  }

  /**
   * The current path of an item that others can be placed under: "" for the
   * drive root, undefined when the item is not in the tree.
   */
  pathOf(id: string): string | undefined {
    if (id === this.rootId) {
      return "";
    }
    const node = this.nodes.get(id);
    if (!node) {
      return undefined;
    }
    return this.resolver(false)(node) ?? undefined;
  }

  /** Record an item (new, changed, renamed or moved). */
  put(object: ManifestObject, placement: Placement): void {
    this.sequence += 1;
    this.insert(object.id ?? syntheticId(object), object, placement, this.sequence);
    this.deleted.delete(object.id ?? syntheticId(object));
  }

  /** The item is gone from the source; its descendants follow at commit. */
  remove(id: string): void {
    const node = this.nodes.get(id);
    if (node) {
      this.nodes.delete(id);
      this.unindexVersion(node);
    }
    this.deleted.add(id);
  }

  /** Forget everything (a 410 mid-run restarts the enumeration). Returns what was dropped. */
  clear(): ManifestObject[] {
    const dropped = [...this.nodes.values()].map((node) => node.object);
    this.nodes.clear();
    this.versionIdsByItem.clear();
    this.deleted.clear();
    return dropped;
  }

  /**
   * Derive every object's path. With `cascadeDeletions` (the commit), objects
   * below a deleted item are dropped; without it (a checkpoint), they are kept
   * under their last known path so a resumed run can still decide their fate.
   * Each node's recorded path is refreshed to the derived one.
   */
  materialize(options: { cascadeDeletions: boolean }): MaterializedTree {
    const resolve = this.resolver(options.cascadeDeletions);
    const byPath = new Map<string, DriveNode>();
    const collisions: string[] = [];
    let cascaded = 0;

    for (const node of this.nodes.values()) {
      const path = resolve(node);
      if (path === null) {
        cascaded++;
        continue;
      }
      if (node.object.path !== path) {
        node.object = { ...node.object, path };
      }
      const rival = byPath.get(path);
      if (rival) {
        collisions.push(path);
        if (rival.sequence > node.sequence) {
          continue;
        }
      }
      byPath.set(path, node);
    }
    return {
      objects: [...byPath.values()].map((node) => node.object),
      cascaded,
      collisions,
    };
  }

  /**
   * A memoising path resolver. Returns null for a node that hangs below a
   * deleted item when cascading. A cycle (inconsistent data) falls back to the
   * node's last known path instead of recursing forever.
   */
  private resolver(cascadeDeletions: boolean): (node: DriveNode) => string | null {
    const memo = new Map<string, string | null>();
    const inProgress = new Set<string>();
    const resolve = (node: DriveNode): string | null => {
      const known = memo.get(node.id);
      if (known !== undefined) {
        return known;
      }
      if (inProgress.has(node.id)) {
        return node.object.path;
      }
      inProgress.add(node.id);
      const path = this.derivePath(node, resolve, cascadeDeletions);
      inProgress.delete(node.id);
      memo.set(node.id, path);
      return path;
    };
    return resolve;
  }

  private derivePath(
    node: DriveNode,
    resolve: (node: DriveNode) => string | null,
    cascadeDeletions: boolean,
  ): string | null {
    const { parentId } = node;
    if (parentId === null) {
      return node.object.path;
    }
    if (parentId === this.rootId) {
      return node.name;
    }
    const parent = this.nodes.get(parentId);
    if (parent) {
      const parentPath = resolve(parent);
      if (parentPath === null) {
        return null;
      }
      return isVersion(node.object)
        ? `${parentPath}${VERSION_PATH_MARKER}${node.name}`
        : joinPath(parentPath, node.name);
    }
    if (cascadeDeletions && this.deleted.has(parentId)) {
      return null;
    }
    return node.object.path;
  }

  private insert(id: string, object: ManifestObject, placement: Placement, sequence: number): void {
    const previous = this.nodes.get(id);
    if (previous) {
      this.unindexVersion(previous);
    }
    const node: DriveNode = {
      id,
      parentId: placement.parentId,
      name: placement.name,
      object,
      sequence,
    };
    this.nodes.set(id, node);
    if (isVersion(object) && node.parentId !== null) {
      const ids = this.versionIdsByItem.get(node.parentId) ?? new Set<string>();
      ids.add(id);
      this.versionIdsByItem.set(node.parentId, ids);
    }
  }

  private unindexVersion(node: DriveNode): void {
    if (!isVersion(node.object) || node.parentId === null) {
      return;
    }
    const ids = this.versionIdsByItem.get(node.parentId);
    ids?.delete(node.id);
    if (ids?.size === 0) {
      this.versionIdsByItem.delete(node.parentId);
    }
  }
}
