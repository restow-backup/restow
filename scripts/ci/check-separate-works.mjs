#!/usr/bin/env node
/**
 * Separate works (CI): folders of this repository that are not part of the
 * Apache-2.0 core but separate works under their own license, listed under
 * "separateWorks" in scripts/ci/license-policy.json. Today that is the storage
 * plugin shim for Proxmox VE (integrations/pve/plugin), AGPL-3.0-or-later,
 * because it subclasses AGPL-3+ Perl classes of pve-storage. The exception is
 * narrow, and this check keeps it so:
 *
 *   - the folder carries the full license text (LICENSE) and every source file
 *     in it starts with an SPDX header naming exactly that license;
 *   - the folder holds no Restow core code: no TypeScript, JavaScript or Go
 *     files, and nothing that imports a Restow package (`@restow/`,
 *     `github.com/restow-backup/restow`);
 *   - nothing outside the folder references it, except the files listed in
 *     its `allowedReferences` (the build script that ships it, the image,
 *     docs, this check);
 *   - nothing outside the folder is a copy of one of its files (same content).
 *
 * Usage: node scripts/ci/check-separate-works.mjs
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const POLICY_PATH = fileURLToPath(new URL("./license-policy.json", import.meta.url));

/** Files whose first lines must carry the SPDX header (everything but these). */
const NO_HEADER = new Set(["LICENSE", "README.md"]);
const CORE_CODE = /\.(ts|tsx|js|mjs|cjs|go)$/;
const CORE_IMPORT = /@restow\/|github\.com\/restow-backup\/restow/;
const LICENSE_MARKERS = {
  "AGPL-3.0-or-later": ["GNU AFFERO GENERAL PUBLIC LICENSE", "Version 3, 19 November 2007"],
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Pure apart from reading files: the findings for one separate work.
 * `work` = { path, license, allowedReferences }, `repoFiles` = every tracked
 * file of the repository (relative paths), `read(path)` reads one of them.
 */
export function checkWork(work, repoFiles, read) {
  const findings = [];
  const prefix = `${work.path.replace(/\/$/, "")}/`;
  const inside = repoFiles.filter((f) => f.startsWith(prefix));
  if (inside.length === 0) {
    return [`${work.path}: the folder is missing or empty`];
  }
  const markers = LICENSE_MARKERS[work.license];
  if (!markers) {
    findings.push(`${work.path}: no license text markers known for ${work.license}`);
  }
  const licenseFile = `${prefix}LICENSE`;
  if (!inside.includes(licenseFile)) {
    findings.push(`${work.path}: LICENSE with the full ${work.license} text is missing`);
  } else if (markers) {
    const text = read(licenseFile).toString("utf8");
    for (const marker of markers) {
      if (!text.includes(marker)) {
        findings.push(`${licenseFile}: does not look like the full ${work.license} text`);
        break;
      }
    }
  }
  const hashes = new Map();
  for (const file of inside) {
    const name = file.slice(prefix.length);
    const bytes = read(file);
    hashes.set(sha256(bytes), file);
    if (CORE_CODE.test(name)) {
      findings.push(
        `${file}: Restow core code (${name.split(".").pop()}) does not belong in a separate work`,
      );
      continue;
    }
    if (NO_HEADER.has(name.split("/").pop())) {
      continue;
    }
    const text = bytes.toString("utf8");
    const head = text.split("\n").slice(0, 5).join("\n");
    const spdx = /SPDX-License-Identifier:\s*([^\s*]+)/.exec(head);
    if (!spdx) {
      findings.push(`${file}: no SPDX-License-Identifier in the first lines`);
    } else if (spdx[1] !== work.license) {
      findings.push(`${file}: SPDX-License-Identifier ${spdx[1]}, expected ${work.license}`);
    }
    if (CORE_IMPORT.test(text)) {
      findings.push(`${file}: refers to a Restow core package`);
    }
  }
  const allowed = new Set(work.allowedReferences ?? []);
  for (const file of repoFiles) {
    if (file.startsWith(prefix)) {
      continue;
    }
    const bytes = read(file);
    if (bytes === null) {
      continue;
    }
    const copyOf = hashes.get(sha256(bytes));
    if (copyOf && bytes.length > 0) {
      findings.push(`${file}: is a copy of ${copyOf}; code of a separate work stays in its folder`);
    }
    if (!allowed.has(file) && bytes.toString("utf8").includes(work.path)) {
      findings.push(
        `${file}: refers to ${work.path}; only ${[...allowed].join(", ")} may (scripts/ci/license-policy.json, separateWorks)`,
      );
    }
  }
  return findings;
}

function trackedFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  return out.split("\0").filter(Boolean);
}

function readRepo(path) {
  const full = join(ROOT, path);
  try {
    const st = statSync(full);
    if (!st.isFile() || st.size > 8 * 1024 * 1024) {
      return null;
    }
    return readFileSync(full);
  } catch {
    return null;
  }
}

function main() {
  const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  const works = Object.entries(policy.separateWorks ?? {}).filter(([key]) => !key.startsWith("$"));
  const files = trackedFiles();
  const findings = [];
  for (const [path, work] of works) {
    findings.push(...checkWork({ path, ...work }, files, (f) => readRepo(f) ?? Buffer.alloc(0)));
  }
  if (findings.length > 0) {
    console.error(`check-separate-works: ${findings.length} finding(s):`);
    for (const f of findings) {
      console.error(`  ${f}`);
    }
    process.exit(1);
  }
  console.log(`check-separate-works: OK (${works.map(([p]) => p).join(", ") || "none"})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
