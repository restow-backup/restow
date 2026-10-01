/**
 * Mail exports as the smoke uses them: request one, wait for the worker, fetch
 * the file, and check an EML ZIP against its own checksum list.
 */
import { createHash } from "node:crypto";
import { waitFor } from "./exec.mjs";
import { parseSha256Sums, readZip } from "./zip.mjs";

/** Ask for an export and return the finished ZIP as entries (`{ name, data }`). */
export async function exportToEntries(api, tenantId, body) {
  const queued = await api.post("/api/v1/exports", body, { tenantId });
  const finished = await waitFor(
    "the export to finish",
    async () => {
      const export_ = await api.get(`/api/v1/exports/${queued.id}`, { tenantId });
      if (export_.status === "failed" || export_.status === "cancelled") {
        throw new Error(`the export ${export_.status}`);
      }
      return export_.status === "completed" ? export_ : null;
    },
    { timeoutMs: 180_000, intervalMs: 2000 },
  );
  const bytes = await api.download(`/api/v1/exports/${queued.id}/download`, { tenantId });
  if (finished.sha256 && createHash("sha256").update(bytes).digest("hex") !== finished.sha256) {
    throw new Error("the downloaded file does not match the checksum the export reports");
  }
  return { export: finished, entries: readZip(bytes), bytes };
}

/**
 * Check the checksum list of an export ZIP against the files in it and return
 * the message files as `{ name, sha256, data }`. Throws on the first problem:
 * no MANIFEST.csv or SHA256SUMS, a listed file that is missing or different,
 * or a message file the list does not name.
 */
export function checkChecksummedZip(entries, { extension = ".eml" } = {}) {
  const byName = new Map(
    entries.filter((entry) => !entry.name.endsWith("/")).map((entry) => [entry.name, entry.data]),
  );
  for (const required of ["MANIFEST.csv", "SHA256SUMS"]) {
    if (!byName.has(required)) {
      throw new Error(`the export has no ${required}`);
    }
  }
  const sums = parseSha256Sums(byName.get("SHA256SUMS").toString("utf8"));
  const files = [];
  for (const [name, data] of byName) {
    if (name === "MANIFEST.csv" || name === "SHA256SUMS") {
      continue;
    }
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (sums.get(name) !== sha256) {
      throw new Error(
        `${name}: SHA256SUMS lists ${sums.get(name) ?? "nothing"}, the file hashes to ${sha256}`,
      );
    }
    if (name.endsWith(extension)) {
      files.push({ name, sha256, data });
    }
  }
  for (const name of sums.keys()) {
    if (!byName.has(name)) {
      throw new Error(`SHA256SUMS lists ${name}, which is not in the export`);
    }
  }
  return files;
}
