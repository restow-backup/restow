#!/usr/bin/env node
/**
 * Writes THIRD_PARTY_NOTICES.md: for every third-party component that ships in a Restow
 * image or in the web bundle, its name, version, license, copyright notice(s) and license
 * text, read from the LICENSE and NOTICE files of the installed packages. Run it after
 * changing dependencies (CI fails when the file is out of date):
 *
 *   node scripts/third-party-notices.mjs
 *
 * Which packages: the production dependency graph of every workspace, from
 * `pnpm list -r --json --prod --depth Infinity` (not `pnpm licenses`, which leaves out
 * packages that are only reachable through npm: aliases). That graph covers the
 * api, worker, scheduler and cli trees of the image and everything apps/web and ee/web
 * can bundle. It also holds a few build and test tools that pnpm pulls in as optional
 * peers and that the image removes again; listing them is deliberate, so the file
 * never misses a package that ships. Three development dependencies of apps/web are
 * added because their code or CSS ends up in the web bundle (BUNDLED_BUILD_TOOLS).
 *
 * Programs that run unmodified as separate processes (restic), the Go standard library
 * (linked into the agent and into restic), source code copied into the repository
 * (shadcn/ui) and the msgreader test files (shipped inside @restow/core's src) are
 * listed by hand in COMPONENTS below, with their license texts in licenses/.
 *
 * The Go modules compiled into the restic binary come from licenses/restic-deps/
 * (modules.json and one folder of license and NOTICE files per module, vendored and
 * checked against the pinned binaries by scripts/restic-licenses.mjs); they get a
 * section of their own. The same run writes agent/THIRD_PARTY_NOTICES.txt, the notices
 * that ship with the agent to every endpoint (agent/build.sh puts the file next to the
 * binaries and into the signed SHA256SUMS): the agent's own license, Go's, restic's and
 * those of the modules in restic, as plain text.
 *
 * Output rules: the file must come out byte for byte the same on macOS and on the Linux
 * CI runner. So: no paths, no dates, an ordering that does not depend on the locale,
 * LF line endings, and no platform-specific native packages (anything that declares an
 * operating system or CPU, such as the esbuild, rollup and lightningcss binaries and
 * fsevents; which of them pnpm installs depends on the host).
 *
 * License texts: a short license (up to SHORT_TEXT_LIMIT characters) is printed without
 * its copyright lines, so that the MIT, ISC and BSD texts of hundreds of packages
 * collapse into a few distinct texts; the copyright lines are listed per package
 * instead. A long license (Apache-2.0, MPL-2.0, ...) and every NOTICE file is printed
 * as it is. Each distinct text appears once under "License texts"; every package
 * points to its texts.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = fileURLToPath(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url));
const AGENT_OUT = fileURLToPath(new URL("../agent/THIRD_PARTY_NOTICES.txt", import.meta.url));
const RESTIC_MODULES = "licenses/restic-deps/modules.json";

/** A license text up to this many characters is split into copyright lines and body. */
export const SHORT_TEXT_LIMIT = 3000;

/** Workspace projects whose dependencies do not ship in the product. */
const EXCLUDED_PROJECTS = new Set(["restow", "@restow/demo-seed"]);

/**
 * Development dependencies of apps/web whose code or CSS the build embeds in the web
 * bundle: vite (its module preload helper), tailwindcss (the preflight and theme CSS)
 * and tw-animate-css (its animation CSS). Checked against the module list of a real
 * `vite build`: every other package in the bundle comes from `dependencies`.
 */
const BUNDLED_BUILD_TOOLS = ["tailwindcss", "tw-animate-css", "vite"];

/**
 * Components that are not installed npm packages: separate processes, the Go runtime,
 * source copied into the repository and test files that travel inside a package.
 */
function resticVersion() {
  const version = /^RESTIC_VERSION=(\S+)$/m.exec(
    readFileSync(join(ROOT, "agent/tools.env"), "utf8"),
  )?.[1];
  if (!version) {
    throw new Error("agent/tools.env names no RESTIC_VERSION");
  }
  return version;
}

function components() {
  const version = resticVersion();
  return [
    {
      name: "restic",
      version,
      license: "BSD-2-Clause",
      file: "licenses/restic-LICENSE",
      description:
        "https://github.com/restic/restic. The backup engine of the endpoint agent and of the server. The unmodified release binary, verified against a pinned SHA-256 (agent/tools.env), runs as a separate process from /usr/local/bin/restic and is served to agents from /srv/agent/<version>/<os>-<arch>/restic. Its license text is also in the image at /usr/share/doc/restow/restic-LICENSE. The Go modules compiled into the binary are listed in the next section.",
    },
    {
      name: "Go standard library and runtime",
      version: "",
      license: "BSD-3-Clause",
      file: "licenses/go-LICENSE",
      description:
        "https://go.dev/LICENSE. Linked into restow-agent, the endpoint agent that is built from agent/ and served to endpoints, and into the restic release binary.",
    },
    {
      name: "shadcn/ui",
      version: "",
      license: "MIT",
      file: "licenses/shadcn-ui-LICENSE",
      description:
        "https://github.com/shadcn-ui/ui. The primitives in apps/web/src/components/ui/ were generated from the shadcn/ui registry with the shadcn CLI and changed for Restow (apps/web/src/components/ui/README.md lists the changes); they are compiled into the web bundle.",
    },
    {
      name: "msgreader test files",
      version: "",
      license: "Apache-2.0",
      file: "licenses/msgreader-LICENSE",
      description:
        "https://github.com/HiraokaHyperTools/msgreader. The Outlook .msg files in packages/core/src/mailfiles/testdata/ are copies from the test folder of the msgreader project (one is derived from another by damaging a few bytes). They are test data only, but they travel inside the src folder of @restow/core into the image; packages/core/src/mailfiles/testdata/README.md lists them.",
    },
  ];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for scripts/ci/third-party-notices.test.mjs)
// ---------------------------------------------------------------------------

/** Compare strings by UTF-16 code unit, which no locale or ICU build can change. */
export function compareStrings(a, b) {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** Strip a BOM, use LF line endings, drop trailing blanks and blank lines at both ends. */
export function normalizeText(raw) {
  return raw
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/** A line that starts a copyright statement: "Copyright ...", "(c) Copyright ...", "© ...", "(c) 2019 ...". */
const COPYRIGHT_LINE = /^\s*(?:[*#>-]\s*)?(?:(?:\(c\)|©)\s*)?Copyright\b|^\s*(?:©|\(c\)\s*\d{4})/;

/** Template placeholders of license texts, which are not a statement of anyone. */
const PLACEHOLDER =
  /\[yyyy\]|\[year\]|\{yyyy\}|<year>|\[name of copyright owner\]|\{name of copyright owner\}|<copyright holders?>|<name of author>|\[fullname\]|<owner>|yyyy/i;

/** The copyright statements of a text (placeholders of license templates left out). */
export function copyrightStatements(text) {
  const found = [];
  for (const line of text.split("\n")) {
    if (COPYRIGHT_LINE.test(line) && !PLACEHOLDER.test(line)) {
      found.push(line.replace(/^\s*(?:[*#>-]\s*)/, "").trim());
    }
  }
  return found;
}

/**
 * Split a license text into its copyright statements and the body that is the same for
 * every package with that license. A long text (and a NOTICE file) stays whole.
 */
export function splitLicenseText(rawText, { keepWhole = false } = {}) {
  const text = normalizeText(rawText);
  const statements = copyrightStatements(text);
  if (keepWhole || text.length > SHORT_TEXT_LIMIT) {
    return { body: text, statements };
  }
  const kept = [];
  let afterStatement = false;
  for (const line of text.split("\n")) {
    if (COPYRIGHT_LINE.test(line)) {
      afterStatement = true;
      continue;
    }
    if (afterStatement && /^\s*All rights reserved\.?\s*$/i.test(line)) {
      continue;
    }
    afterStatement = false;
    kept.push(line);
  }
  return {
    body: kept
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, ""),
    statements,
  };
}

/** Cut a license file before the section that reprints the licenses of the package's own bundled dependencies. */
export function cutBundledDependencies(text) {
  const match = /^#{1,3}\s*Licenses? of bundled dependencies\b/im.exec(text);
  if (!match) {
    return { text, cut: false };
  }
  return { text: text.slice(0, match.index).replace(/\n+$/, ""), cut: true };
}

/** The license files of a package folder: LICENSE*, COPYING*, UNLICENSE, NOTICE*, CopyrightNotice*. */
const LICENSE_FILE = /^(licen[cs]e|licen[cs]es|copying|unlicen[cs]e)([-._ ].*)?$/i;
const NOTICE_FILE = /^(notice|copyrightnotice)([-._ ].*)?$/i;
const CODE_FILE = /\.(m?js|cjs|ts|tsx|json|map|css|html|ya?ml|sh|py|h|c|cc|node)$/i;

export function licenseFilesOf(names) {
  const licenses = [];
  const notices = [];
  for (const name of [...names].sort(compareStrings)) {
    if (CODE_FILE.test(name)) {
      continue;
    }
    if (LICENSE_FILE.test(name)) {
      licenses.push(name);
    } else if (NOTICE_FILE.test(name)) {
      notices.push(name);
    }
  }
  return { licenses, notices };
}

/** The license identifier of a package.json ("MIT", "(MIT OR EUPL-1.1+)"), or "UNKNOWN". */
export function licenseOf(manifest) {
  if (typeof manifest.license === "string" && manifest.license.trim()) {
    return manifest.license.trim();
  }
  if (manifest.license && typeof manifest.license === "object" && manifest.license.type) {
    return String(manifest.license.type);
  }
  if (Array.isArray(manifest.licenses) && manifest.licenses.length > 0) {
    return manifest.licenses.map((entry) => entry.type ?? entry).join(" OR ");
  }
  return "UNKNOWN";
}

/** The single license identifiers inside an SPDX expression. */
export function licenseIds(expression) {
  return (expression.match(/[A-Za-z0-9.+:_-]+/g) ?? []).filter(
    (token) => !/^(AND|OR|WITH)$/i.test(token),
  );
}

/** The author's name from package.json (string or object), without e-mail address and URL. */
export function authorName(manifest) {
  const author = manifest.author ?? manifest.contributors?.[0] ?? manifest.maintainers?.[0];
  const raw = typeof author === "string" ? author : author?.name;
  if (!raw) {
    return "";
  }
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A package that declares an operating system or CPU, or is a known native binary of one. */
const PLATFORM_PACKAGE =
  /^(?:@esbuild\/|@rollup\/rollup-|lightningcss-)(?:aix|android|darwin|freebsd|linux|netbsd|openbsd|openharmony|sunos|win32)|^fsevents$/;

export function isPlatformPackage(manifest) {
  return Boolean(manifest.os || manifest.cpu || PLATFORM_PACKAGE.test(manifest.name ?? ""));
}

/**
 * The folders of the installed packages in a `pnpm list -r --json --depth Infinity`
 * result: every node with a path inside a node_modules folder that exists on this
 * host. Workspace projects (no node_modules in the path) are passed through; so are
 * optional packages of other platforms, which are not installed.
 */
export function collectPackageDirs(projects, { exclude = EXCLUDED_PROJECTS } = {}) {
  const dirs = new Set();
  const visit = (dependencies) => {
    for (const node of Object.values(dependencies ?? {})) {
      if (
        node.path?.split(sep).includes("node_modules") &&
        existsSync(join(node.path, "package.json"))
      ) {
        dirs.add(node.path);
      }
      visit(node.dependencies);
      visit(node.optionalDependencies);
    }
  };
  for (const project of projects) {
    if (!exclude.has(project.name)) {
      visit(project.dependencies);
      visit(project.optionalDependencies);
    }
  }
  return [...dirs].sort(compareStrings);
}

/**
 * Read one package folder: its manifest data and license texts. Returns undefined for a
 * platform-specific package.
 */
export function readPackage(dir, { readText = (file) => readFileSync(file, "utf8") } = {}) {
  const manifest = JSON.parse(readText(join(dir, "package.json")));
  if (!manifest.name || !manifest.version || isPlatformPackage(manifest)) {
    return undefined;
  }
  const files = readdirSync(dir).filter((name) => {
    try {
      return statSync(join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
  const { licenses, notices } = licenseFilesOf(files);
  const texts = [];
  let cut = false;
  for (const name of licenses) {
    const trimmed = cutBundledDependencies(normalizeText(readText(join(dir, name))));
    cut = cut || trimmed.cut;
    texts.push({ file: name, raw: trimmed.text, keepWhole: false });
  }
  for (const name of notices) {
    texts.push({ file: name, raw: readText(join(dir, name)), keepWhole: true });
  }
  return {
    name: manifest.name,
    version: manifest.version,
    license: licenseOf(manifest),
    author: authorName(manifest),
    texts,
    cut,
    description: "",
    component: false,
    group: "package",
  };
}

/** Read a component from licenses/ (restic, Go, shadcn/ui, msgreader). */
function readComponent(component) {
  return {
    name: component.name,
    version: component.version,
    license: component.license,
    author: "",
    texts: [
      {
        file: component.file,
        raw: readFileSync(join(ROOT, component.file), "utf8"),
        keepWhole: false,
      },
    ],
    cut: false,
    description: component.description,
    component: true,
    group: "component",
  };
}

/** The tag of a module version in its repository ("refs/tags/auth/v0.20.0" -> "auth/v0.20.0"). */
function tagOf(module) {
  return module.ref?.startsWith("refs/tags/") ? module.ref.slice("refs/tags/".length) : "";
}

/**
 * Pure: the sentence that says where the source of a module is. For an MPL-2.0 module
 * it is the statement the license asks for (MPL 2.0, section 3.2): restic ships it
 * unmodified in executable form, and this is where its source code is.
 */
export function moduleSourceNote(module) {
  const tag = tagOf(module);
  const repository = module.source
    ? `${module.source}${tag ? ` (tag ${tag}${module.subdir ? `, folder ${module.subdir}` : ""})` : ""}`
    : "";
  const proxy = `https://proxy.golang.org/${module.path.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)}/@v/${module.version}.zip`;
  if (/\bMPL-2\.0\b/.test(module.license)) {
    return `Covered by the Mozilla Public License 2.0. restic contains this module unmodified, in executable form. Its source code, including the files covered by the MPL, is available from ${repository || "its repository"} and as the Go module ${module.path} ${module.version} from ${proxy}.`;
  }
  return repository
    ? `Source: ${repository}.`
    : `Source: the Go module ${module.path} ${module.version}.`;
}

/** Licenses that also come as a short notice that points to the full text ("Licensed under ..."). */
const FULL_TEXT = { "Apache-2.0": /TERMS AND CONDITIONS FOR USE, REPRODUCTION/i };

/**
 * Read the Go modules compiled into restic from licenses/restic-deps/. The vendored list
 * must be the one of the pinned restic (scripts/restic-licenses.mjs vendor makes it).
 */
export function readResticModules(
  manifest,
  { readText = (file) => readFileSync(join(ROOT, "licenses/restic-deps", file), "utf8") } = {},
) {
  return manifest.modules.map((module) => {
    const texts = [
      ...module.licenseFiles.map((file) => ({ file, raw: readText(file), keepWhole: false })),
      ...module.noticeFiles.map((file) => ({ file, raw: readText(file), keepWhole: true })),
    ];
    // A module that ships only the short notice of a license also gets that license's full text.
    const standardFor = Object.entries(FULL_TEXT)
      .filter(
        ([id, full]) =>
          licenseIds(module.license).includes(id) &&
          !texts.some((text) => !text.keepWhole && full.test(text.raw)),
      )
      .map(([id]) => id);
    return {
      name: module.path,
      version: module.version,
      license: module.license,
      author: "",
      texts,
      cut: false,
      description: moduleSourceNote(module),
      component: false,
      group: "restic-module",
      standardFor,
    };
  });
}

/**
 * Build the document model from package records: one text id per distinct text, ordered
 * by use (most used first), and for every package its statements and text ids. A package
 * without any license file points to the most common text of its declared license.
 */
export function buildModel(records) {
  const entries = records
    .map((record) => {
      const parts = record.texts.map((text) => {
        const split = splitLicenseText(text.raw, { keepWhole: text.keepWhole });
        return { ...split, file: text.file, isNotice: text.keepWhole };
      });
      return { ...record, parts };
    })
    .sort(
      (a, b) =>
        compareStrings(a.name, b.name) ||
        compareStrings(a.version, b.version) ||
        compareStrings(a.license, b.license),
    );

  const usage = new Map();
  const tally = new Map(); // declared license -> body -> count, from packages with one license text
  for (const entry of entries) {
    for (const body of new Set(entry.parts.map((part) => part.body))) {
      usage.set(body, (usage.get(body) ?? 0) + 1);
    }
    const licenseParts = entry.parts.filter((part) => !part.isNotice);
    if (licenseParts.length === 1) {
      const counts = tally.get(entry.license) ?? new Map();
      counts.set(licenseParts[0].body, (counts.get(licenseParts[0].body) ?? 0) + 1);
      tally.set(entry.license, counts);
    }
  }
  const standard = (id) => {
    const counts = tally.get(id);
    if (!counts) {
      return undefined;
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))[0][0];
  };

  // A package without a license file points to the standard text of each license in its
  // expression; one that has only the short notice of a license, to that license's text too.
  const fallback = new Map();
  const added = new Map();
  for (const entry of entries) {
    const bodies = [];
    for (const id of entry.standardFor ?? []) {
      const body = standard(id);
      if (body && !entry.parts.some((part) => part.body === body) && !bodies.includes(body)) {
        bodies.push(body);
      }
    }
    if (bodies.length > 0) {
      added.set(entry, bodies);
      for (const body of bodies) {
        usage.set(body, (usage.get(body) ?? 0) + 1);
      }
    }
  }
  for (const entry of entries) {
    if (entry.parts.some((part) => !part.isNotice)) {
      continue;
    }
    const bodies = [];
    for (const id of licenseIds(entry.license)) {
      const body = standard(id);
      if (body && !bodies.includes(body)) {
        bodies.push(body);
      }
    }
    fallback.set(entry, bodies);
    for (const body of bodies) {
      usage.set(body, (usage.get(body) ?? 0) + 1);
    }
  }

  const bodies = [...usage.keys()].sort(
    (a, b) => usage.get(b) - usage.get(a) || compareStrings(a, b),
  );
  const ids = new Map(bodies.map((body, index) => [body, index + 1]));
  const idsOf = (parts) =>
    [...new Set(parts.map((part) => ids.get(part.body)))].sort((a, b) => a - b);
  return {
    texts: bodies.map((body) => ({ id: ids.get(body), body, uses: usage.get(body) })),
    packages: entries.map((entry) => {
      const missing = fallback.has(entry);
      const statements = [...(entry.statements ?? [])];
      for (const part of entry.parts) {
        for (const statement of part.statements) {
          if (!statements.includes(statement)) {
            statements.push(statement);
          }
        }
      }
      return {
        name: entry.name,
        version: entry.version,
        license: entry.license,
        description: entry.description,
        author: entry.author,
        component: entry.component,
        group: entry.group ?? (entry.component ? "component" : "package"),
        statements,
        cut: entry.cut,
        shipsNoLicenseFile: missing,
        textIds: missing
          ? fallback.get(entry).map((body) => ids.get(body))
          : [
              ...new Set([
                ...idsOf(entry.parts.filter((part) => !part.isNotice)),
                ...(added.get(entry) ?? []).map((body) => ids.get(body)),
              ]),
            ].sort((a, b) => a - b),
        noticeIds: idsOf(entry.parts.filter((part) => part.isNotice)),
      };
    }),
  };
}

/** A code span that survives backticks inside the text. */
function codeSpan(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text}${fence}`;
}

/** A fenced block whose fence is longer than any run of backticks in the text. */
function fencedBlock(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function textLinks(ids) {
  return ids.map((id) => `[text ${id}](#text-${id})`).join(", ");
}

/** What the section of the modules in restic says before the list (Markdown and text). */
const RESTIC_MODULES_INTRO = [
  "restic is a statically linked Go program: its release binary contains these Go modules,",
  "at these versions (the same for every target). restic and the modules are distributed",
  "unmodified. Each entry names the module's license, its copyright lines, its license",
  "texts and, where it has one, its NOTICE file, taken from the module at that version",
  "(vendored in licenses/restic-deps/ by scripts/restic-licenses.mjs). One module is",
  "covered by the Mozilla Public License 2.0; its entry says where its source code is.",
];

/** The Markdown of one package or component entry. */
function renderEntry(entry, heading) {
  const title = entry.version ? `${entry.name} ${entry.version}` : entry.name;
  const lines = [`${heading} ${title}`, ""];
  if (entry.description) {
    lines.push(entry.description, "");
  }
  lines.push(`- License: ${entry.license}`);
  if (entry.statements.length === 1) {
    lines.push(`- Copyright: ${codeSpan(entry.statements[0])}`);
  } else if (entry.statements.length > 1) {
    lines.push("- Copyright:");
    for (const statement of entry.statements) {
      lines.push(`  - ${codeSpan(statement)}`);
    }
  } else if (entry.group === "restic-module") {
    lines.push("- Copyright: no copyright line in the module's license or NOTICE files");
  } else {
    lines.push(
      `- Copyright: no copyright line in the package${entry.author ? `; author in package.json: ${entry.author}` : "; no author in package.json"}`,
    );
  }
  if (entry.shipsNoLicenseFile) {
    lines.push(
      entry.textIds.length > 0
        ? `- License text: ${textLinks(entry.textIds)} (the package ships no license file; this is the text most packages with this license use)`
        : "- License text: the package ships no license file and no standard text is available for this license",
    );
  } else if (entry.textIds.length > 0) {
    lines.push(
      `- License text: ${textLinks(entry.textIds)}${entry.cut ? " (the part of the file that reprints the licenses of the package's own bundled dependencies is left out)" : ""}`,
    );
  }
  if (entry.noticeIds.length > 0) {
    lines.push(`- Notice file: ${textLinks(entry.noticeIds)}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * The whole document: the hand-listed components first, then the Go modules compiled
 * into restic, then the packages, then the shared texts.
 */
export function renderDocument(model) {
  const components = model.packages.filter((entry) => entry.group === "component");
  const modules = model.packages.filter((entry) => entry.group === "restic-module");
  const packages = model.packages.filter((entry) => entry.group === "package");
  const lines = [
    "# Third-party notices",
    "",
    "This file lists the third-party components that ship in a Restow image or in the",
    "web bundle: for each its name, version, license, copyright notice(s) and license",
    "text, taken from the LICENSE and NOTICE files of the installed packages. Restow's",
    "own license is in `LICENSE` and `NOTICE`.",
    "",
    "A license text that is the same for many packages is printed once under",
    "[License texts](#license-texts); each entry links to its text. The copyright lines",
    "are not part of the shared text, they are listed with each package.",
    "",
    "The packages are the production dependencies of the workspaces `api`, `worker`,",
    "`scheduler`, `cli`, `web` and `ee/*` (pnpm's dependency graph, including optional",
    "peers). That is a little more than ships: a few build and test tools that pnpm pulls",
    "in as optional peers are removed from the image again, and are listed all the same.",
    "The code or CSS of `vite`, `tailwindcss` and `tw-animate-css` is embedded in the web",
    "bundle by the build, so those three are listed too. Native binary packages that exist",
    "once per operating system and CPU (the esbuild, rollup and lightningcss binaries,",
    "fsevents) are not listed one by one, because which of them is installed depends on",
    "the host; each is licensed like the package it belongs to, as its package.json says",
    "(MIT, or MPL-2.0 for the lightningcss binaries).",
    "",
    "This file is generated by `node scripts/third-party-notices.mjs`; do not edit it",
    "by hand.",
    "",
    "## Programs, runtimes and copied source",
    "",
  ];
  for (const entry of components) {
    lines.push(renderEntry(entry, "###"));
  }
  if (modules.length > 0) {
    lines.push(
      `## Go modules compiled into the restic binary (${modules.length})`,
      "",
      ...RESTIC_MODULES_INTRO,
      "",
    );
    for (const entry of modules) {
      lines.push(renderEntry(entry, "###"));
    }
  }
  lines.push(`## Packages (${packages.length})`, "");
  for (const entry of packages) {
    lines.push(renderEntry(entry, "###"));
  }
  lines.push(`## License texts (${model.texts.length})`, "");
  for (const text of model.texts) {
    lines.push(
      `### Text ${text.id}`,
      "",
      `Used by ${text.uses} ${text.uses === 1 ? "entry" : "entries"}.`,
      "",
      fencedBlock(text.body),
      "",
    );
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** Wrap a paragraph at 80 columns (words longer than that stay whole). */
function wrap(text, indent = "") {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && indent.length + line.length + 1 + word.length > 80) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) {
    lines.push(indent + line);
  }
  return lines;
}

/** One entry of the agent's notices as plain text. */
function renderTextEntry(entry) {
  const title = entry.version ? `${entry.name} ${entry.version}` : entry.name;
  const lines = [title, "-".repeat(Math.min(title.length, 80))];
  if (entry.description) {
    lines.push(...wrap(entry.description));
  }
  lines.push(`License: ${entry.license}`);
  if (entry.statements.length > 0) {
    lines.push("Copyright:");
    for (const statement of entry.statements) {
      lines.push(`  ${statement}`);
    }
  }
  if (entry.textIds.length > 0) {
    lines.push(`License text: ${entry.textIds.map((id) => `[${id}]`).join(", ")}`);
  }
  if (entry.noticeIds.length > 0) {
    lines.push(`Notice file: ${entry.noticeIds.map((id) => `[${id}]`).join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * agent/THIRD_PARTY_NOTICES.txt: the notices that travel with the agent to every
 * endpoint. Plain text, because it is read on a server's console as often as anywhere.
 */
export function renderAgentNotices(model) {
  // The agent itself first, then what it is built with and what it runs.
  const own = model.packages
    .filter((entry) => entry.group === "component")
    .sort((a, b) => Number(b.name === "restow-agent") - Number(a.name === "restow-agent"));
  const modules = model.packages.filter((entry) => entry.group === "restic-module");
  const lines = [
    "Restow agent: license and third-party notices",
    "=============================================",
    "",
    ...wrap(
      "This file is installed with the Restow endpoint agent (restow-agent) and the restic binary it runs. It names the license of the agent and the licenses, copyright notices and NOTICE files of the third-party software in both programs; each distinct license text is printed once at the end, and every entry points to its texts by number. It is generated by scripts/third-party-notices.mjs in the Restow repository.",
    ),
    "",
    "",
    "Programs and runtime",
    "====================",
    "",
  ];
  for (const entry of own) {
    lines.push(renderTextEntry(entry));
  }
  lines.push("", `Go modules compiled into the restic binary (${modules.length})`);
  lines.push("=".repeat(lines[lines.length - 1].length), "");
  lines.push(...wrap(RESTIC_MODULES_INTRO.join(" ")), "");
  for (const entry of modules) {
    lines.push(renderTextEntry(entry));
  }
  lines.push("", `License texts (${model.texts.length})`);
  lines.push("=".repeat(lines[lines.length - 1].length), "");
  for (const text of model.texts) {
    lines.push(
      `[${text.id}] used by ${text.uses} ${text.uses === 1 ? "entry" : "entries"}`,
      "-".repeat(40),
      text.body,
      "",
    );
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** The first two lines of NOTICE: the product's name and its copyright line. */
function ownCopyright() {
  const [name, copyright] = normalizeText(readFileSync(join(ROOT, "NOTICE"), "utf8")).split("\n");
  if (!copyright?.startsWith("Copyright")) {
    throw new Error("NOTICE does not start with the product name and its copyright line");
  }
  return { name, copyright };
}

/** The records of agent/THIRD_PARTY_NOTICES.txt: the agent, Go, restic and the modules in restic. */
function agentRecords(moduleRecords) {
  const { copyright } = ownCopyright();
  const all = components();
  const pick = (name) => readComponent(all.find((component) => component.name === name));
  const go = pick("Go standard library and runtime");
  const restic = pick("restic");
  return [
    {
      name: "restow-agent",
      version: "",
      license: "Apache-2.0",
      author: "",
      // LICENSE holds the text, NOTICE the copyright statement.
      texts: [
        { file: "LICENSE", raw: readFileSync(join(ROOT, "LICENSE"), "utf8"), keepWhole: false },
      ],
      statements: [copyright],
      cut: false,
      description:
        "The Restow endpoint agent, https://github.com/restow-backup/restow (folder agent/). It is built with the Go standard library only.",
      component: true,
      group: "component",
    },
    {
      ...go,
      description:
        "https://go.dev/LICENSE. Linked into restow-agent and into the restic release binary.",
    },
    {
      ...restic,
      description:
        "https://github.com/restic/restic. The unmodified release binary, installed next to restow-agent and run by it as a separate process. The Go modules compiled into it follow.",
    },
    ...moduleRecords,
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function pnpmJson(args) {
  return JSON.parse(
    execFileSync("pnpm", args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
    }),
  );
}

/** The folders of the build tools that end up in the web bundle (direct devDependencies of apps/web). */
function bundledBuildToolDirs() {
  const dirs = [];
  for (const project of pnpmJson(["list", "--json", "--depth", "0", "--filter", "@restow/web"])) {
    for (const [alias, node] of Object.entries(project.devDependencies ?? {})) {
      if (BUNDLED_BUILD_TOOLS.includes(node.from ?? alias) && node.path) {
        dirs.push(node.path);
      }
    }
  }
  if (dirs.length !== BUNDLED_BUILD_TOOLS.length) {
    throw new Error(
      `apps/web must have ${BUNDLED_BUILD_TOOLS.join(", ")} as devDependencies; found ${dirs.length} of ${BUNDLED_BUILD_TOOLS.length}`,
    );
  }
  return dirs;
}

function main() {
  const projects = pnpmJson(["list", "-r", "--json", "--prod", "--depth", "Infinity"]);
  const dirs = new Set([...collectPackageDirs(projects), ...bundledBuildToolDirs()]);
  const byLabel = new Map();
  for (const dir of [...dirs].sort(compareStrings)) {
    // The same package can sit in several folders (one per peer-dependency variant); the
    // first one in sorted order stands for it.
    const record = readPackage(realpathSync(dir));
    if (record && !byLabel.has(`${record.name}@${record.version}`)) {
      byLabel.set(`${record.name}@${record.version}`, record);
    }
  }
  const list = components();
  const manifest = JSON.parse(readFileSync(join(ROOT, RESTIC_MODULES), "utf8"));
  if (manifest.restic !== resticVersion()) {
    throw new Error(
      `${RESTIC_MODULES} lists the modules of restic ${manifest.restic}, agent/tools.env pins ${resticVersion()}: run node scripts/restic-licenses.mjs vendor agent/dist/*/restic first`,
    );
  }
  const moduleRecords = readResticModules(manifest);
  const records = [...byLabel.values(), ...list.map(readComponent), ...moduleRecords];
  const model = buildModel(records);
  writeFileSync(OUT, renderDocument(model));
  const size = readFileSync(OUT).length;
  console.log(
    `third-party-notices: ${byLabel.size} packages, ${list.length} other components, ${moduleRecords.length} Go modules in restic and ${model.texts.length} distinct texts written to THIRD_PARTY_NOTICES.md (${size} bytes)`,
  );
  const agentModel = buildModel(agentRecords(moduleRecords));
  writeFileSync(AGENT_OUT, renderAgentNotices(agentModel));
  console.log(
    `third-party-notices: ${agentModel.packages.length} entries and ${agentModel.texts.length} distinct texts written to agent/THIRD_PARTY_NOTICES.txt (${readFileSync(AGENT_OUT).length} bytes)`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
