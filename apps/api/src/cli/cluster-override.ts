import { readFile, rename, writeFile } from "node:fs/promises";
import { Document, isMap, isScalar, isSeq, parseDocument, YAMLMap, YAMLSeq } from "yaml";

/**
 * The part of `docker-compose.override.yml` that exposes PostgreSQL to worker nodes on other hosts
 * (`install.sh --allow-worker`, docs/SIZING.md "Several hosts: worker nodes"), run as
 * `restow cluster database-override --file <override> (--bind <address> --port <port> | --remove)`
 * in a container of the application image. The file may hold the operator's settings and the
 * mounter's shares (mounter/override.ts); like the mounter, this edits it through the `yaml`
 * Document API and owns only:
 *
 *   - the top-level `x-restow-cluster` (the bind address and port, the source of truth),
 *   - `services.postgres.command` and `services.postgres.ports` while `x-restow-cluster` is there,
 *   - entries of a service's `volumes` whose source starts with `./postgres-tls`.
 *
 * With TLS on, the server certificate and pg_hba.conf of `./postgres-tls` (install.sh writes
 * them) are used, and the port is published on the bind address given. `--remove` takes all of
 * it out again: PostgreSQL is then not published at all, as by default.
 */

export const TLS_DIR_IN_CONTAINER = "/etc/restow/postgres-tls";
const OWNED_SOURCE = "./postgres-tls";

export interface DatabaseExposure {
  /** The host address the port is published on (an address of the main host, never 0.0.0.0 by default). */
  readonly bind: string;
  readonly port: number;
}

function load(text: string): Document {
  if (text.trim() === "") {
    return new Document({});
  }
  const doc: Document = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new Error(
      `The compose override is not valid YAML: ${doc.errors[0]?.message.split("\n")[0]}`,
    );
  }
  if (doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null)) {
    doc.contents = new YAMLMap();
  }
  if (!isMap(doc.contents)) {
    throw new Error("The compose override is not a mapping at the top level.");
  }
  return doc;
}

function serviceMap(doc: Document, name: string, create: boolean): YAMLMap | null {
  let services = doc.get("services");
  if (!isMap(services)) {
    if (!create) {
      return null;
    }
    services = new YAMLMap();
    doc.set("services", services);
  }
  let service = (services as YAMLMap).get(name);
  if (!isMap(service)) {
    if (!create) {
      return null;
    }
    service = new YAMLMap();
    (services as YAMLMap).set(name, service);
  }
  return service as YAMLMap;
}

function sourceOf(item: unknown): string | null {
  if (isScalar(item) && typeof item.value === "string") {
    return item.value.split(":")[0] ?? null;
  }
  if (isMap(item)) {
    const source = item.get("source");
    return typeof source === "string" ? source : null;
  }
  return null;
}

function removeOwnedVolumes(service: YAMLMap): void {
  const volumes = service.get("volumes");
  if (!isSeq(volumes)) {
    return;
  }
  volumes.items = volumes.items.filter((item) => !sourceOf(item)?.startsWith(OWNED_SOURCE));
  if (volumes.items.length === 0) {
    service.delete("volumes");
  }
}

function addVolume(service: YAMLMap, entry: string): void {
  let volumes = service.get("volumes");
  if (!isSeq(volumes)) {
    volumes = new YAMLSeq();
    service.set("volumes", volumes);
  }
  (volumes as YAMLSeq).add(entry);
}

function pruneEmpty(doc: Document, name: string): void {
  const services = doc.get("services");
  if (!isMap(services)) {
    return;
  }
  const service = services.get(name);
  if (isMap(service) && service.items.length === 0) {
    services.delete(name);
  }
  if (services.items.length === 0) {
    doc.delete("services");
  }
}

/** The override with the database exposed (`exposure`) or not exposed (null). */
export function renderDatabaseOverride(text: string, exposure: DatabaseExposure | null): string {
  const doc = load(text);
  const owned = doc.has("x-restow-cluster");
  for (const name of ["postgres", "api"]) {
    const service = serviceMap(doc, name, false);
    if (service) {
      removeOwnedVolumes(service);
      if (name === "postgres" && owned) {
        service.delete("command");
        service.delete("ports");
      }
    }
  }
  doc.delete("x-restow-cluster");
  if (exposure) {
    if (
      !/^[0-9A-Fa-f.:]+$/.test(exposure.bind) ||
      !Number.isInteger(exposure.port) ||
      exposure.port < 1 ||
      exposure.port > 65535
    ) {
      throw new Error("The bind address must be an IP address and the port 1 to 65535.");
    }
    const postgres = serviceMap(doc, "postgres", true) as YAMLMap;
    if (postgres.has("command") || postgres.has("ports")) {
      throw new Error(
        "services.postgres of the override already sets command or ports; remove them by hand first.",
      );
    }
    doc.set("x-restow-cluster", { bind: exposure.bind, port: exposure.port });
    postgres.set("command", [
      "postgres",
      "-c",
      "ssl=on",
      "-c",
      `ssl_cert_file=${TLS_DIR_IN_CONTAINER}/server.crt`,
      "-c",
      `ssl_key_file=${TLS_DIR_IN_CONTAINER}/server.key`,
      "-c",
      "ssl_min_protocol_version=TLSv1.2",
      "-c",
      `hba_file=${TLS_DIR_IN_CONTAINER}/pg_hba.conf`,
    ]);
    const bind = exposure.bind.includes(":") ? `[${exposure.bind}]` : exposure.bind;
    postgres.set("ports", [`${bind}:${exposure.port}:5432`]);
    addVolume(postgres, `${OWNED_SOURCE}:${TLS_DIR_IN_CONTAINER}:ro`);
    // The api hands the CA to a joining node (features/cluster/service.ts).
    const api = serviceMap(doc, "api", true) as YAMLMap;
    addVolume(api, `${OWNED_SOURCE}/ca.crt:${TLS_DIR_IN_CONTAINER}/ca.crt:ro`);
  }
  pruneEmpty(doc, "postgres");
  pruneEmpty(doc, "api");
  const contents = doc.contents as YAMLMap | null;
  return contents && contents.items.length > 0 ? doc.toString() : "";
}

/** Rewrite the file in place (missing: an empty override). */
export async function applyDatabaseOverride(
  file: string,
  exposure: DatabaseExposure | null,
): Promise<string> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const next = renderDatabaseOverride(text, exposure);
  const temporary = `${file}.restow-cluster.tmp`;
  await writeFile(temporary, next, { mode: 0o644 });
  await rename(temporary, file);
  return next;
}
