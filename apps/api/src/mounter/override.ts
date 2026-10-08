import { createHash } from "node:crypto";
import {
  Document,
  type Pair,
  Scalar,
  YAMLMap,
  YAMLSeq,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
} from "yaml";
import {
  MANAGED_MOUNTS_KEY,
  MANAGED_VOLUME_LABEL,
  MANAGED_VOLUME_PREFIX,
  MOUNT_SERVICES,
  type MountSpec,
  mountPathOf,
  mountSpecSchema,
} from "./protocol.js";

/**
 * The compose override file the mounter writes (`docker-compose.override.yml` in the
 * project directory, or the override that is there already). Compose merges it into
 * the project's own compose file for every `docker compose` command run in that
 * directory, so the shares survive an update, a restart and a manual `up -d`.
 *
 * The file may hold the operator's own settings. They are kept exactly as they are,
 * comments included: the file is edited through the `yaml` package's Document API,
 * never re-serialized from plain data. The mounter owns only:
 *
 *   - the top-level list `x-restow-mounts` (the shares, the source of truth),
 *   - top-level volumes whose key starts with `restow-nfs-`,
 *   - entries of a service's `volumes` whose source starts with `restow-nfs-`.
 *
 * Rendering removes all of them and adds them again from the list of shares, so it is
 * idempotent and never touches anything else. Each share is a named volume of the
 * `local` driver with NFS options, mounted into the api and the worker at
 * `/mnt/restow/<name>`. The volume key carries a hash of the share's settings, so
 * changed settings make a new volume (Docker never changes the options of a volume
 * that exists) and the old one can be removed afterwards.
 */

export class OverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverrideError";
  }
}

/** The first 8 hex digits of a hash over everything that goes into the volume's options. */
export function settingsHash(spec: MountSpec): string {
  const canonical = JSON.stringify([
    spec.protocol,
    spec.server,
    spec.export,
    spec.nfsVersion,
    spec.readOnly,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 8);
}

/** The compose volume key of a share: `restow-nfs-<name>-<hash8>`. */
export function volumeKeyOf(spec: MountSpec): string {
  return `${MANAGED_VOLUME_PREFIX}${spec.name}-${settingsHash(spec)}`;
}

/**
 * The `o` option of the local driver. `mount` is what the api and the worker use (a hard
 * mount: a share that is away blocks writes until it is back instead of failing them
 * half-way); `probe` gives up quickly, for the test.
 */
export function nfsMountOptions(spec: MountSpec, mode: "mount" | "probe"): string {
  const options = [`addr=${spec.server}`, `nfsvers=${spec.nfsVersion}`];
  if (mode === "mount") {
    options.push("hard", "noatime");
  } else {
    options.push("soft", "timeo=50", "retrans=1");
  }
  if (spec.readOnly) {
    options.push("ro");
  }
  return options.join(",");
}

/** The `device` option: `:<export>`. */
export function nfsDevice(spec: MountSpec): string {
  return `:${spec.export}`;
}

/** The volume definition the override carries for a share. */
export function volumeDefinitionOf(spec: MountSpec): Record<string, unknown> {
  return {
    driver: "local",
    driver_opts: { type: "nfs", o: nfsMountOptions(spec, "mount"), device: nfsDevice(spec) },
    labels: { [MANAGED_VOLUME_LABEL]: spec.name },
  };
}

function serviceEntryOf(spec: MountSpec): string {
  return `${volumeKeyOf(spec)}:${mountPathOf(spec.name)}${spec.readOnly ? ":ro" : ""}`;
}

function keyText(key: unknown): string | null {
  if (isScalar(key)) {
    return typeof key.value === "string" ? key.value : String(key.value);
  }
  return typeof key === "string" ? key : null;
}

/** Parse the override; an empty or missing file is an empty document. */
function load(text: string | null): Document {
  if (text === null || text.trim() === "") {
    return new Document({});
  }
  const doc: Document = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new OverrideError(
      `The compose override is not valid YAML: ${doc.errors[0]?.message.split("\n")[0] ?? "unknown error"}`,
    );
  }
  if (doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null)) {
    doc.contents = new YAMLMap();
    return doc;
  }
  if (!isMap(doc.contents)) {
    throw new OverrideError("The compose override is not a mapping at the top level.");
  }
  return doc;
}

/** The source of an entry of a service's `volumes` (short or long syntax); null when there is none. */
function serviceVolumeSource(item: unknown): string | null {
  if (isScalar(item) && typeof item.value === "string") {
    return item.value.split(":")[0] ?? null;
  }
  if (isMap(item)) {
    const source = item.get("source");
    return typeof source === "string" ? source : null;
  }
  return null;
}

/** The target of an entry of a service's `volumes`; null when it cannot be read. */
function serviceVolumeTarget(item: unknown): string | null {
  if (isScalar(item) && typeof item.value === "string") {
    const parts = item.value.split(":");
    return parts.length >= 2 ? (parts[1] ?? null) : (parts[0] ?? null);
  }
  if (isMap(item)) {
    const target = item.get("target");
    return typeof target === "string" ? target : null;
  }
  return null;
}

function isManagedSource(source: string | null): boolean {
  return source?.startsWith(MANAGED_VOLUME_PREFIX) === true;
}

/** The shares the override lists (`x-restow-mounts`); entries that do not parse are an error. */
function managedMountsOfDocument(doc: Document): MountSpec[] {
  const root = doc.contents as YAMLMap;
  const node = root.get(MANAGED_MOUNTS_KEY, true);
  if (node === undefined || (isScalar(node) && node.value === null)) {
    return [];
  }
  if (!isSeq(node)) {
    throw new OverrideError(`${MANAGED_MOUNTS_KEY} in the compose override is not a list.`);
  }
  const mounts: MountSpec[] = [];
  for (const item of node.items) {
    const raw = isMap(item) ? (item.toJSON() as Record<string, unknown>) : null;
    if (!raw) {
      throw new OverrideError(`An entry of ${MANAGED_MOUNTS_KEY} is not a mapping.`);
    }
    // `volume` is derived; everything else must still be a valid share.
    const { volume: _volume, ...spec } = raw;
    const parsed = mountSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new OverrideError(
        `An entry of ${MANAGED_MOUNTS_KEY} is not valid: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      );
    }
    mounts.push(parsed.data);
  }
  return mounts;
}

/** The shares the override lists. Throws OverrideError for a file that cannot be read. */
export function managedMountsOf(text: string | null): MountSpec[] {
  return managedMountsOfDocument(load(text));
}

/**
 * Entries of the operator's own (unmanaged) settings that clash with a share: a
 * volume of the api or the worker already mounted at the share's path.
 */
export function conflictsOf(text: string | null, spec: MountSpec): string[] {
  const doc = load(text);
  const root = doc.contents as YAMLMap;
  const services = root.get("services", true);
  const path = mountPathOf(spec.name);
  const conflicts: string[] = [];
  if (!isMap(services)) {
    return conflicts;
  }
  for (const service of MOUNT_SERVICES) {
    const node = services.get(service, true);
    const volumes = isMap(node) ? node.get("volumes", true) : undefined;
    if (!isSeq(volumes)) {
      continue;
    }
    for (const item of volumes.items) {
      if (isManagedSource(serviceVolumeSource(item))) {
        continue;
      }
      const target = serviceVolumeTarget(item);
      if (target !== null && (target === path || target.startsWith(`${path}/`))) {
        conflicts.push(`services.${service}.volumes: ${target}`);
      }
    }
  }
  return conflicts;
}

/** Remove everything the mounter manages. Returns the root mapping. */
function removeManaged(doc: Document): YAMLMap {
  const root = doc.contents as YAMLMap;
  root.delete(MANAGED_MOUNTS_KEY);

  const volumes = root.get("volumes", true);
  if (isMap(volumes)) {
    const managed = volumes.items
      .map((pair) => keyText(pair.key))
      .filter((key): key is string => key?.startsWith(MANAGED_VOLUME_PREFIX) === true);
    for (const key of managed) {
      volumes.delete(key);
    }
    if (managed.length > 0 && volumes.items.length === 0) {
      root.delete("volumes");
    }
  }

  const services = root.get("services", true);
  if (isMap(services)) {
    let touchedServices = false;
    for (const pair of [...services.items] as Pair<unknown, unknown>[]) {
      const service = pair.value;
      if (!isMap(service)) {
        continue;
      }
      const list = service.get("volumes", true);
      if (!isSeq(list)) {
        continue;
      }
      const before = list.items.length;
      list.items = list.items.filter((item) => !isManagedSource(serviceVolumeSource(item)));
      if (list.items.length === before) {
        continue;
      }
      touchedServices = true;
      if (list.items.length === 0) {
        service.delete("volumes");
      }
      if (service.items.length === 0) {
        services.delete(keyText(pair.key));
      }
    }
    if (touchedServices && services.items.length === 0) {
      root.delete("services");
    }
  }
  return root;
}

function mappingAt(doc: Document, parent: YAMLMap, key: string, where: string): YAMLMap {
  const node = parent.get(key, true);
  if (node === undefined || (isScalar(node) && node.value === null)) {
    const created = new YAMLMap();
    parent.set(doc.createNode(key), created);
    return created;
  }
  if (!isMap(node)) {
    throw new OverrideError(`${where} in the compose override is not a mapping.`);
  }
  return node;
}

function sequenceAt(doc: Document, parent: YAMLMap, key: string, where: string): YAMLSeq {
  const node = parent.get(key, true);
  if (node === undefined || (isScalar(node) && node.value === null)) {
    const created = new YAMLSeq();
    parent.set(doc.createNode(key), created);
    return created;
  }
  if (!isSeq(node)) {
    throw new OverrideError(`${where} in the compose override is not a list.`);
  }
  return node;
}

const HEADER_COMMENT =
  " Network shares, managed by the mounter (Installation > Mounts, docs/MOUNTS.md).\n" +
  " Change them in the web interface; edits by hand to this list and to the\n" +
  " restow-nfs-* volumes are replaced. Everything else in this file is yours.";

/**
 * The override with exactly `mounts` as the managed shares, and everything else as it
 * was. null: the file would be empty (it is then removed, or not created).
 */
export function renderOverride(text: string | null, mounts: readonly MountSpec[]): string | null {
  const doc = load(text);
  const root = removeManaged(doc);
  const sorted = [...mounts].sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set<string>();
  for (const spec of sorted) {
    if (names.has(spec.name)) {
      throw new OverrideError(`The share ${spec.name} is listed twice.`);
    }
    names.add(spec.name);
  }

  if (sorted.length > 0) {
    const list = doc.createNode(
      sorted.map((spec) => ({ ...spec, volume: volumeKeyOf(spec) })),
    ) as YAMLSeq;
    const key = doc.createNode(MANAGED_MOUNTS_KEY) as Scalar;
    key.commentBefore = HEADER_COMMENT;
    root.add(doc.createPair(key, list));

    const volumes = mappingAt(doc, root, "volumes", "volumes");
    for (const spec of sorted) {
      const definition = doc.createNode(volumeDefinitionOf(spec)) as YAMLMap;
      // `:/export` is a valid plain scalar, but quoted no YAML reader can take it for a key.
      const device = definition.getIn(["driver_opts", "device"], true);
      if (isScalar(device)) {
        device.type = Scalar.QUOTE_DOUBLE;
      }
      volumes.set(doc.createNode(volumeKeyOf(spec)), definition);
    }

    const services = mappingAt(doc, root, "services", "services");
    for (const service of MOUNT_SERVICES) {
      const node = mappingAt(doc, services, service, `services.${service}`);
      const entries = sequenceAt(doc, node, "volumes", `services.${service}.volumes`);
      for (const spec of sorted) {
        entries.add(doc.createNode(serviceEntryOf(spec)));
      }
    }
  }

  if (root.items.length === 0 && !doc.commentBefore && !doc.comment) {
    return null;
  }
  return doc.toString({ lineWidth: 0 });
}
