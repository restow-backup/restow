/** Small file helpers for the checks that compare restored files with what was written. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every file below `directory` as `{ path (relative, "/"-separated), sha256, size }`, sorted by path. */
export function hashTree(directory) {
  const files = [];
  const walk = (current, prefix) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) {
        walk(full, relative);
      } else {
        const bytes = readFileSync(full);
        files.push({
          path: relative,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
        });
      }
    }
  };
  walk(directory, "");
  return files;
}
