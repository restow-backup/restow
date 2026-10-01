#!/usr/bin/env node
/**
 * The licenses of the Go modules compiled into the restic release binary that Restow
 * redistributes: in every server image (/usr/local/bin/restic and /srv/agent/...) and
 * to every endpoint with the agent. restic itself is BSD-2-Clause; its binary is
 * statically linked and carries 79 third-party Go modules (restic 0.19.1) under
 * Apache-2.0, MIT, BSD and, for github.com/hashicorp/golang-lru/v2, MPL-2.0. Their
 * license texts and NOTICE files are vendored, reviewed, under licenses/restic-deps/
 * (one folder per module plus modules.json), so scripts/third-party-notices.mjs can
 * print them offline into THIRD_PARTY_NOTICES.md and agent/THIRD_PARTY_NOTICES.txt.
 *
 *   node scripts/restic-licenses.mjs vendor <restic binary>...
 *       Maintainer, once per restic pin (agent/tools.env). Reads the module list from the
 *       binaries' Go build information (every target must list the same modules), fetches
 *       each module at that exact version through the Go module proxy (`go mod download`,
 *       checked against the Go checksum database and against the hash in the binary) and
 *       copies its LICENSE, COPYING and NOTICE files to licenses/restic-deps/. Needs Go on
 *       the PATH or Docker (the pinned golang image of agent/tools.env) and network access.
 *       A license the classifier below does not recognise stops it: add the module to
 *       REVIEWED with the identifier you checked. Review the diff before committing it.
 *
 *   node scripts/restic-licenses.mjs check <restic binary>...
 *       CI. The modules in each binary's build information are exactly the vendored ones,
 *       at the same versions and hashes, and the vendored restic version is the pinned one.
 *       Reads the binaries directly; needs neither Go nor network.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const VENDOR_DIR = "licenses/restic-deps";
export const MANIFEST = `${VENDOR_DIR}/modules.json`;

/** The markers around the module information in a Go binary (cmd/go, modload: infoStart, infoEnd). */
const INFO_START = Buffer.from("3077af0c9274080241e1c107e6d618e6", "hex");
const INFO_END = Buffer.from("f932433186182072008242104116d8f2", "hex");

/**
 * Pure: the build information of a Go binary, as `go version -m` prints it: the main
 * module, every dependency with version and hash (a `=>` replacement takes the place
 * of the module it replaces) and the build settings (GOOS, GOARCH, ...).
 */
export function readBuildInfo(bytes) {
  const start = bytes.indexOf(INFO_START);
  const end = start === -1 ? -1 : bytes.indexOf(INFO_END, start + INFO_START.length);
  if (start === -1 || end === -1) {
    throw new Error("no Go module information in this file (not a Go binary built with modules?)");
  }
  const text = bytes.subarray(start + INFO_START.length, end).toString("utf8");
  const info = { path: "", main: "", deps: [], settings: {} };
  for (const line of text.split("\n")) {
    const [kind, ...fields] = line.split("\t");
    if (kind === "path") {
      info.path = fields[0] ?? "";
    } else if (kind === "mod") {
      info.main = fields[0] ?? "";
    } else if (kind === "dep") {
      info.deps.push({ path: fields[0], version: fields[1], sum: fields[2] ?? "" });
    } else if (kind === "=>" && info.deps.length > 0) {
      info.deps[info.deps.length - 1] = {
        path: fields[0],
        version: fields[1],
        sum: fields[2] ?? "",
        replaces: info.deps[info.deps.length - 1].path,
      };
    } else if (kind === "build") {
      const setting = fields.join("\t");
      const eq = setting.indexOf("=");
      if (eq > 0) {
        info.settings[setting.slice(0, eq)] = setting.slice(eq + 1);
      }
    }
  }
  return info;
}

/** Pure: the folder name of a module's texts below licenses/restic-deps/. */
export function moduleFolder(path, version) {
  return `${path.replaceAll("/", "_")}@${version}`;
}

const LICENSE_NAME = /^(licen[cs]e|copying)([-._ ].*)?$/i;
const NOTICE_NAME = /^notice([-._ ].*)?$/i;

/** Pure: which files of a module's root folder are license texts and which are NOTICE files. */
export function legalFiles(names) {
  const sorted = [...names].sort();
  return {
    licenses: sorted.filter((name) => LICENSE_NAME.test(name) && !/\.(go|json|ya?ml)$/i.test(name)),
    notices: sorted.filter((name) => NOTICE_NAME.test(name) && !/\.(go|json|ya?ml)$/i.test(name)),
  };
}

/** The wording only these licenses have, in the order they are reported. */
const LICENSE_MARKERS = [
  // The full text, or the short notice that points to it ("Licensed under the Apache License, ...").
  ["Apache-2.0", /Apache License,? Version 2\.0/i],
  ["MPL-2.0", /Mozilla Public License,? (?:Version|v\.) ?2\.0/i],
  ["MIT", /Permission is hereby granted, free of charge, to any person obtaining a copy/i],
  [
    "ISC",
    /Permission to use, copy, modify, and\/or distribute this software for any purpose with or without fee is hereby granted/i,
  ],
];
const BSD = /Redistribution and use in source and binary forms, with or without modification/gi;
const BSD_3 = /Neither the name|names of its contributors may be used/i;

/**
 * Pure: the SPDX identifiers of the licenses one text contains (a file may hold
 * several, for code it took from elsewhere), in a fixed order; empty when it holds
 * none of the licenses known here (the module then needs a REVIEWED entry).
 */
export function classifyLicense(text) {
  // One line per paragraph, without the "> " of a quoted license.
  const t = text
    .split("\n")
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
  const found = LICENSE_MARKERS.filter(([, pattern]) => pattern.test(t)).map(([id]) => id);
  // Each BSD text is the start of one license; the third clause makes it BSD-3-Clause.
  const starts = [...t.matchAll(BSD)].map((match) => match.index);
  starts.forEach((at, index) => {
    const section = t.slice(at, starts[index + 1] ?? t.length).slice(0, 1200);
    const id = BSD_3.test(section) ? "BSD-3-Clause" : "BSD-2-Clause";
    if (!found.includes(id)) {
      found.push(id);
    }
  });
  return found;
}

/**
 * Modules whose license the classifier cannot tell from the text (or tells wrongly),
 * checked by hand: "path@version" -> SPDX expression. Empty for restic 0.19.1.
 */
const REVIEWED = {};

/** Pure: the license of a module from its texts (several licenses: all of them, joined with AND). */
export function moduleLicense(label, texts, reviewed = REVIEWED) {
  if (reviewed[label]) {
    return reviewed[label];
  }
  const ids = [];
  for (const { file, text } of texts) {
    const found = classifyLicense(text);
    if (found.length === 0) {
      throw new Error(
        `${label}: the license in ${file} is not recognised; check it and add it to REVIEWED in scripts/restic-licenses.mjs`,
      );
    }
    for (const id of found) {
      if (!ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  if (ids.length === 0) {
    throw new Error(`${label}: the module ships no license file; check its license by hand`);
  }
  return ids.join(" AND ");
}

/**
 * Pure: the problems between the vendored manifest and the build information of
 * restic binaries; empty when they agree.
 */
export function compareWithBinaries(manifest, infos, pinnedVersion) {
  const problems = [];
  if (pinnedVersion && manifest.restic !== pinnedVersion) {
    problems.push(
      `${MANIFEST} is for restic ${manifest.restic}, agent/tools.env pins ${pinnedVersion}: run node scripts/restic-licenses.mjs vendor with the new binaries`,
    );
  }
  const vendored = new Map(manifest.modules.map((module) => [module.path, module]));
  for (const { file, info } of infos) {
    const target = `${info.settings.GOOS ?? "?"}-${info.settings.GOARCH ?? "?"}`;
    if (info.path !== "github.com/restic/restic/cmd/restic") {
      problems.push(`${file} is not a restic binary (main package ${info.path || "unknown"})`);
      continue;
    }
    const seen = new Set();
    for (const dep of info.deps) {
      seen.add(dep.path);
      const entry = vendored.get(dep.path);
      if (!entry) {
        problems.push(
          `${file} (${target}) contains ${dep.path} ${dep.version}, which is not vendored`,
        );
      } else if (entry.version !== dep.version || (dep.sum && entry.sum !== dep.sum)) {
        problems.push(
          `${file} (${target}) contains ${dep.path} ${dep.version} ${dep.sum}, vendored is ${entry.version} ${entry.sum}`,
        );
      }
    }
    for (const path of vendored.keys()) {
      if (!seen.has(path)) {
        problems.push(`${path} is vendored but not in ${file} (${target})`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// vendor
// ---------------------------------------------------------------------------

function toolsEnv() {
  return readFileSync(join(ROOT, "agent/tools.env"), "utf8");
}

export function pinnedResticVersion(env = toolsEnv()) {
  return /^RESTIC_VERSION=(\S+)\s*$/m.exec(env)?.[1];
}

function haveGo() {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** `go mod download -json` of the given modules into cacheDir; returns {path@version: Dir on this host}. */
function downloadModules(specs, cacheDir) {
  let output;
  const args = ["mod", "download", "-json", ...specs];
  if (haveGo()) {
    output = execFileSync("go", args, {
      cwd: cacheDir,
      env: { ...process.env, GOMODCACHE: join(cacheDir, "mod"), GOFLAGS: "-modcacherw" },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } else {
    const image = /^GO_IMAGE=(\S+)\s*$/m.exec(toolsEnv())?.[1];
    if (!image) {
      throw new Error("go is not on the PATH and agent/tools.env names no GO_IMAGE");
    }
    console.log(`restic-licenses: go is not on the PATH, using ${image} in Docker`);
    output = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${cacheDir}:/cache`,
        "-w",
        "/tmp",
        "-e",
        "GOMODCACHE=/cache/mod",
        "-e",
        "GOFLAGS=-modcacherw",
        image,
        "go",
        ...args,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ).replaceAll('"/cache/mod/', `"${join(cacheDir, "mod")}/`);
  }
  const found = new Map();
  // The output is a stream of indented JSON objects, one per module.
  for (const chunk of output.split(/\n(?=\{)/)) {
    if (!chunk.trim()) {
      continue;
    }
    const module = JSON.parse(chunk);
    if (module.Error) {
      throw new Error(`${module.Path}@${module.Version}: ${module.Error}`);
    }
    found.set(`${module.Path}@${module.Version}`, module);
  }
  return found;
}

function vendor(binaries) {
  if (binaries.length === 0) {
    throw new Error("name the restic binaries of every target (agent/dist/*/restic)");
  }
  const infos = binaries.map((file) => ({ file, info: readBuildInfo(readFileSync(file)) }));
  const first = infos[0].info.deps.map((dep) => `${dep.path}@${dep.version}@${dep.sum}`).join("\n");
  for (const { file, info } of infos) {
    if (info.deps.map((dep) => `${dep.path}@${dep.version}@${dep.sum}`).join("\n") !== first) {
      throw new Error(
        `${file} lists other modules than ${infos[0].file}; the notices assume one list for every target`,
      );
    }
  }
  const deps = infos[0].info.deps;
  const cacheDir = join(ROOT, "agent/.cache/restic-licenses");
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  const downloaded = downloadModules(
    deps.map((dep) => `${dep.path}@${dep.version}`),
    cacheDir,
  );

  const outDir = join(ROOT, VENDOR_DIR);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const modules = [];
  for (const dep of deps) {
    const label = `${dep.path}@${dep.version}`;
    const module = downloaded.get(label);
    if (!module?.Dir) {
      throw new Error(`${label} was not downloaded`);
    }
    if (dep.sum && module.Sum !== dep.sum) {
      throw new Error(
        `${label}: the module proxy served ${module.Sum}, the binary was built with ${dep.sum}`,
      );
    }
    const names = readdirSync(module.Dir).filter((name) =>
      statSync(join(module.Dir, name)).isFile(),
    );
    const { licenses, notices } = legalFiles(names);
    const folder = moduleFolder(dep.path, dep.version);
    mkdirSync(join(outDir, folder));
    for (const name of [...licenses, ...notices]) {
      copyFileSync(join(module.Dir, name), join(outDir, folder, name));
    }
    const texts = licenses.map((name) => ({
      file: name,
      text: readFileSync(join(module.Dir, name), "utf8"),
    }));
    const origin = module.Origin ?? {};
    modules.push({
      path: dep.path,
      version: dep.version,
      sum: dep.sum,
      license: moduleLicense(label, texts),
      source: origin.URL ?? "",
      ref: origin.Ref ?? "",
      subdir: origin.Subdir ?? "",
      licenseFiles: licenses.map((name) => `${folder}/${name}`),
      noticeFiles: notices.map((name) => `${folder}/${name}`),
    });
  }
  const manifest = {
    $comment:
      "The Go modules compiled into the restic release binary (all four targets list the same), with the license texts and NOTICE files of each module at that exact version, fetched through the Go module proxy and checked against the hash in the binary. Written by `node scripts/restic-licenses.mjs vendor`, licenses reviewed by hand; scripts/third-party-notices.mjs prints them, scripts/ci/check-licenses.mjs checks them against license-policy.json.",
    restic: pinnedResticVersion(),
    modules,
  };
  writeFileSync(join(ROOT, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    // The repository's formatter has the last word on the layout (short arrays on one line).
    execFileSync("pnpm", ["exec", "biome", "format", "--write", MANIFEST], {
      cwd: ROOT,
      stdio: "ignore",
    });
  } catch {
    console.warn(`restic-licenses: could not format ${MANIFEST} with biome; run pnpm format`);
  }
  rmSync(cacheDir, { recursive: true, force: true });
  const counts = {};
  for (const module of modules) {
    counts[module.license] = (counts[module.license] ?? 0) + 1;
  }
  console.log(
    `restic-licenses: ${modules.length} modules vendored to ${relative(ROOT, outDir)} (${Object.entries(
      counts,
    )
      .map(([id, n]) => `${n} ${id}`)
      .join(
        ", ",
      )}; ${modules.filter((module) => module.noticeFiles.length > 0).length} with a NOTICE file)`,
  );
}

function check(binaries) {
  if (!existsSync(join(ROOT, MANIFEST))) {
    throw new Error(`${MANIFEST} is missing`);
  }
  if (binaries.length === 0) {
    throw new Error("name at least one restic binary to compare with");
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
  const infos = binaries.map((file) => ({ file, info: readBuildInfo(readFileSync(file)) }));
  const problems = compareWithBinaries(manifest, infos, pinnedResticVersion());
  for (const module of manifest.modules) {
    for (const file of [...module.licenseFiles, ...module.noticeFiles]) {
      if (!existsSync(join(ROOT, VENDOR_DIR, file))) {
        problems.push(`${VENDOR_DIR}/${file} is missing`);
      }
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`::error::${problem}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `restic-licenses: the ${manifest.modules.length} vendored modules match ${binaries.length} restic ${manifest.restic} binar${binaries.length === 1 ? "y" : "ies"}`,
  );
}

function main() {
  const [command, ...files] = process.argv.slice(2);
  if (command === "vendor") {
    vendor(files);
  } else if (command === "check") {
    check(files);
  } else {
    console.error("usage: node scripts/restic-licenses.mjs vendor|check <restic binary>...");
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
