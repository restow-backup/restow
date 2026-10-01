import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  SHORT_TEXT_LIMIT,
  authorName,
  buildModel,
  collectPackageDirs,
  compareStrings,
  copyrightStatements,
  cutBundledDependencies,
  isPlatformPackage,
  licenseFilesOf,
  licenseIds,
  licenseOf,
  moduleSourceNote,
  normalizeText,
  readPackage,
  readResticModules,
  renderAgentNotices,
  renderDocument,
  splitLicenseText,
} from "../third-party-notices.mjs";

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.`;

const mit = (...holders) =>
  `MIT License\n\n${holders.map((h) => `Copyright (c) ${h}`).join("\n")}\n\n${MIT_BODY}\n`;

function withTempDir(fn) {
  const root = mkdtempSync(join(tmpdir(), "restow-notices-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writePackage(root, folder, manifest, files = {}) {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

test("strings compare by code unit, independent of the locale", () => {
  assert.deepEqual(["b", "a", "B", "@x/y", "Z", "_a"].sort(compareStrings), [
    "@x/y",
    "B",
    "Z",
    "_a",
    "a",
    "b",
  ]);
  assert.equal(compareStrings("a", "a"), 0);
});

test("normalizes a BOM, CRLF, trailing blanks and blank lines at both ends", () => {
  assert.equal(normalizeText("﻿\r\n\r\nMIT  \r\nlicense\t\r\n\r\n"), "MIT\nlicense");
  assert.equal(normalizeText("a\rb"), "a\nb");
});

test("finds copyright statements and ignores clauses and templates", () => {
  assert.deepEqual(copyrightStatements(mit("2015 Foo", "2018-2020 Bar and contributors")), [
    "Copyright (c) 2015 Foo",
    "Copyright (c) 2018-2020 Bar and contributors",
  ]);
  assert.deepEqual(
    copyrightStatements(
      [
        "Copyright 2018-2020 Amazon.com, Inc.",
        "  * Copyright (c) 2019 Listed",
        "(c) Copyright 2020 Reversed",
        "© 2021 Symbol",
        "(c) 2022 Plain",
      ].join("\n"),
    ),
    [
      "Copyright 2018-2020 Amazon.com, Inc.",
      "Copyright (c) 2019 Listed",
      "(c) Copyright 2020 Reversed",
      "© 2021 Symbol",
      "(c) 2022 Plain",
    ],
  );
  const apache = [
    "      copyright license to reproduce, prepare Derivative Works of,",
    "   Copyright [yyyy] [name of copyright owner]",
    "Copyright (c) <year> <copyright holders>",
    "(c) You must retain, in the Source form of any Derivative Works",
  ].join("\n");
  assert.deepEqual(copyrightStatements(apache), []);
});

test("a short license loses its copyright lines, so texts with different holders are one text", () => {
  const first = splitLicenseText(mit("2015 Foo"));
  const second = splitLicenseText(mit("2019 Bar", "2020 Baz"));
  assert.equal(first.body, second.body);
  assert.deepEqual(first.statements, ["Copyright (c) 2015 Foo"]);
  assert.deepEqual(second.statements, ["Copyright (c) 2019 Bar", "Copyright (c) 2020 Baz"]);
  assert.ok(!first.body.includes("Copyright"));
  assert.ok(first.body.includes("Permission is hereby granted"));
});

test("'All rights reserved.' goes with the copyright line it follows", () => {
  const bsd =
    "Copyright (c) 2011, Foo\nAll rights reserved.\n\nRedistribution and use is permitted.";
  const split = splitLicenseText(bsd);
  assert.equal(split.body, "Redistribution and use is permitted.");
  assert.deepEqual(split.statements, ["Copyright (c) 2011, Foo"]);
  // Elsewhere in a text the sentence stays.
  assert.ok(splitLicenseText("Some terms.\nAll rights reserved.").body.includes("All rights"));
});

test("a long text and a NOTICE file stay whole, with their statements read", () => {
  const long = `${"Terms of use. ".repeat(400)}\nCopyright 2023 Holepunch Inc\n`;
  assert.ok(long.length > SHORT_TEXT_LIMIT);
  const split = splitLicenseText(long);
  assert.ok(split.body.includes("Copyright 2023 Holepunch Inc"));
  assert.deepEqual(split.statements, ["Copyright 2023 Holepunch Inc"]);
  const notice = splitLicenseText(
    "Copyright 2023 Holepunch Inc\n\nLicensed under the Apache License.",
    {
      keepWhole: true,
    },
  );
  assert.equal(notice.body, "Copyright 2023 Holepunch Inc\n\nLicensed under the Apache License.");
  assert.deepEqual(notice.statements, ["Copyright 2023 Holepunch Inc"]);
});

test("cuts a license file before the licenses of the package's own bundled dependencies", () => {
  const text = "# Vite core license\nMIT\n\n# Licenses of bundled dependencies\nlots of text";
  assert.deepEqual(cutBundledDependencies(text), { text: "# Vite core license\nMIT", cut: true });
  assert.deepEqual(cutBundledDependencies("MIT"), { text: "MIT", cut: false });
});

test("picks LICENSE, COPYING and NOTICE files and skips code and folders' lookalikes", () => {
  const { licenses, notices } = licenseFilesOf([
    "index.js",
    "license.js",
    "LICENSE.md",
    "LICENSE-MIT",
    "LICENSE.APACHE",
    "COPYING",
    "UNLICENSE",
    "Licence.txt",
    "NOTICE",
    "CopyrightNotice.txt",
    "notice.json",
    "README.md",
    "licensee.txt",
  ]);
  assert.deepEqual(licenses, [
    "COPYING",
    "LICENSE-MIT",
    "LICENSE.APACHE",
    "LICENSE.md",
    "Licence.txt",
    "UNLICENSE",
  ]);
  assert.deepEqual(notices, ["CopyrightNotice.txt", "NOTICE"]);
});

test("reads license, ids, author", () => {
  assert.equal(licenseOf({ license: "MIT" }), "MIT");
  assert.equal(licenseOf({ license: { type: "ISC" } }), "ISC");
  assert.equal(
    licenseOf({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }),
    "MIT OR Apache-2.0",
  );
  assert.equal(licenseOf({}), "UNKNOWN");
  assert.deepEqual(licenseIds("(MIT OR EUPL-1.1+)"), ["MIT", "EUPL-1.1+"]);
  assert.deepEqual(licenseIds("MIT AND ISC"), ["MIT", "ISC"]);
  assert.equal(
    authorName({ author: "Jane Doe <jane@example.com> (https://example.com)" }),
    "Jane Doe",
  );
  assert.equal(authorName({ author: { name: "Drizzle Team", url: "https://x" } }), "Drizzle Team");
  assert.equal(authorName({ contributors: ["Zed <z@example.com>"] }), "Zed");
  assert.equal(authorName({}), "");
});

test("platform packages are recognised by os, cpu or name", () => {
  assert.equal(isPlatformPackage({ name: "x", os: ["linux"] }), true);
  assert.equal(isPlatformPackage({ name: "x", cpu: ["arm64"] }), true);
  assert.equal(isPlatformPackage({ name: "@esbuild/linux-x64" }), true);
  assert.equal(isPlatformPackage({ name: "@rollup/rollup-darwin-arm64" }), true);
  assert.equal(isPlatformPackage({ name: "lightningcss-linux-x64-gnu" }), true);
  assert.equal(isPlatformPackage({ name: "fsevents" }), true);
  assert.equal(isPlatformPackage({ name: "esbuild" }), false);
  assert.equal(isPlatformPackage({ name: "lightningcss" }), false);
});

test("collects installed packages from the dependency tree, through workspaces and optional packages", () => {
  withTempDir((root) => {
    const a = writePackage(root, "node_modules/.pnpm/a@1.0.0/node_modules/a", {
      name: "a",
      version: "1.0.0",
    });
    const b = writePackage(root, "node_modules/.pnpm/b@2.0.0/node_modules/b", {
      name: "b",
      version: "2.0.0",
    });
    const c = writePackage(root, "node_modules/.pnpm/c@3.0.0/node_modules/c", {
      name: "c",
      version: "3.0.0",
    });
    const seed = writePackage(root, "node_modules/.pnpm/seed-only@1.0.0/node_modules/seed-only", {
      name: "seed-only",
      version: "1.0.0",
    });
    const workspace = join(root, "packages/core");
    const missing = join(root, "node_modules/.pnpm/other-os@1.0.0/node_modules/other-os");
    const projects = [
      {
        name: "@restow/api",
        dependencies: {
          // a workspace package: not collected itself, its own dependencies are
          "@restow/core": {
            from: "@restow/core",
            version: "link:../core",
            path: workspace,
            dependencies: { b: { path: b } },
          },
          a: { path: a, dependencies: { a2: { path: a } } },
        },
        optionalDependencies: { c: { path: c }, "other-os": { path: missing } },
      },
      { name: "@restow/demo-seed", dependencies: { "seed-only": { path: seed } } },
    ];
    assert.deepEqual(collectPackageDirs(projects), [a, b, c].sort());
  });
});

test("reads a package: texts normalized, notices kept, folders and code files skipped", () => {
  withTempDir((root) => {
    const dir = writePackage(
      root,
      "node_modules/p",
      { name: "p", version: "1.2.3", license: "MIT", author: "Jane <j@example.com>" },
      {
        LICENSE: mit("2015 Foo").replace(/\n/g, "\r\n"),
        NOTICE: "Copyright 2023 Foo\nNotice text\n",
        "license.js": "module.exports = 1",
      },
    );
    mkdirSync(join(dir, "LICENSES"));
    const record = readPackage(dir);
    assert.equal(record.name, "p");
    assert.equal(record.version, "1.2.3");
    assert.equal(record.license, "MIT");
    assert.equal(record.author, "Jane");
    assert.deepEqual(
      record.texts.map((text) => [text.file, text.keepWhole]),
      [
        ["LICENSE", false],
        ["NOTICE", true],
      ],
    );
    assert.ok(!record.texts[0].raw.includes("\r"));
    assert.equal(
      readPackage(
        writePackage(root, "node_modules/native", {
          name: "native",
          version: "1.0.0",
          os: ["linux"],
        }),
      ),
      undefined,
    );
  });
});

const record = (name, version, license, texts, extra = {}) => ({
  name,
  version,
  license,
  author: "",
  texts: texts.map((raw) =>
    typeof raw === "string" ? { file: "LICENSE", raw, keepWhole: false } : raw,
  ),
  cut: false,
  description: "",
  component: false,
  ...extra,
});

test("the model numbers texts by use, lists statements per package and fills in missing license files", () => {
  const model = buildModel([
    record("zed", "1.0.0", "MIT", [mit("2020 Zed Inc")]),
    record("alpha", "2.0.0", "MIT", [mit("2015 Alpha", "2016 Alpha Two")]),
    record("alpha", "1.0.0", "MIT", [mit("2015 Alpha")]),
    record("odd", "1.0.0", "ISC", [
      "ISC License\n\nCopyright (c) 2014 Odd\n\nPermission to use is granted.",
    ]),
    record("bare", "0.1.0", "MIT", [], { author: "Bea" }),
    record("both", "1.0.0", "MIT AND ISC", [], { author: "Bo" }),
    record("none", "1.0.0", "WTFPL", []),
  ]);
  assert.deepEqual(
    model.packages.map((entry) => `${entry.name}@${entry.version}`),
    [
      "alpha@1.0.0",
      "alpha@2.0.0",
      "bare@0.1.0",
      "both@1.0.0",
      "none@1.0.0",
      "odd@1.0.0",
      "zed@1.0.0",
    ],
  );
  // Text 1 is the MIT text (used by alpha x2, zed, bare, both), text 2 the ISC text (odd, both).
  assert.equal(model.texts.length, 2);
  assert.equal(model.texts[0].id, 1);
  assert.ok(model.texts[0].body.includes("WITHOUT WARRANTY"));
  assert.equal(model.texts[0].uses, 5);
  assert.equal(model.texts[1].uses, 2);
  const byName = Object.fromEntries(
    model.packages.map((entry) => [`${entry.name}@${entry.version}`, entry]),
  );
  assert.deepEqual(byName["alpha@2.0.0"].statements, [
    "Copyright (c) 2015 Alpha",
    "Copyright (c) 2016 Alpha Two",
  ]);
  assert.deepEqual(byName["alpha@2.0.0"].textIds, [1]);
  assert.equal(byName["bare@0.1.0"].shipsNoLicenseFile, true);
  assert.deepEqual(byName["bare@0.1.0"].textIds, [1]);
  assert.deepEqual(byName["both@1.0.0"].textIds, [1, 2]);
  assert.deepEqual(byName["none@1.0.0"].textIds, []);
});

test("the document says what is missing and never invents a text", () => {
  const model = buildModel([
    record("bare", "0.1.0", "MIT", [], { author: "Bea" }),
    record("known", "1.0.0", "MIT", [mit("2015 Known")]),
    record("none", "1.0.0", "WTFPL", []),
    record("noticed", "1.0.0", "MIT", [
      mit("2016 Noticed"),
      { file: "NOTICE", raw: "Copyright (c) 2016 Noticed\nNotice.", keepWhole: true },
    ]),
  ]);
  const text = renderDocument(model);
  assert.match(
    text,
    /### bare 0\.1\.0\n\n- License: MIT\n- Copyright: no copyright line in the package; author in package\.json: Bea\n- License text: \[text 1\]\(#text-1\) \(the package ships no license file/,
  );
  assert.match(
    text,
    /### none 1\.0\.0\n\n- License: WTFPL\n- Copyright: no copyright line in the package; no author in package\.json\n- License text: the package ships no license file and no standard text is available/,
  );
  assert.match(
    text,
    /### noticed 1\.0\.0\n\n- License: MIT\n- Copyright: `Copyright \(c\) 2016 Noticed`\n- License text: \[text 1\]\(#text-1\)\n- Notice file: \[text 2\]\(#text-2\)/,
  );
});

test("the document is deterministic: input order, line endings and repeated runs change nothing", () => {
  const records = [
    record("b", "1.0.0", "MIT", [mit("2020 B")]),
    record("a", "1.0.0", "MIT", [mit("2019 A")]),
    record("c", "1.0.0", "ISC", [
      "ISC License\n\nCopyright (c) 2018 C\n\nPermission to use is granted.",
    ]),
    record("d", "1.0.0", "Apache-2.0", [`${"Long terms. ".repeat(400)}\nCopyright 2021 D\n`]),
  ];
  const first = renderDocument(buildModel(records));
  const shuffled = renderDocument(buildModel([...records].reverse()));
  const crlf = renderDocument(
    buildModel(
      records.map((entry) => ({
        ...entry,
        texts: entry.texts.map((text) => ({ ...text, raw: text.raw.replace(/\n/g, "\r\n") })),
      })),
    ),
  );
  assert.equal(shuffled, first);
  assert.equal(crlf, first);
  assert.equal(renderDocument(buildModel(records)), first);
  assert.ok(!first.includes("\r"));
  assert.ok(first.endsWith("\n") && !first.endsWith("\n\n"));
});

test("components come first, a text that contains backticks gets a longer fence, headings count entries", () => {
  const model = buildModel([
    record("pkg", "1.0.0", "MIT", [mit("2020 P")]),
    record("tool", "", "BSD-2-Clause", ["Copyright (c) 2014, T\n\nUse ```code``` freely."], {
      component: true,
      description: "A separate program.",
    }),
  ]);
  const text = renderDocument(model);
  assert.ok(
    text.indexOf("## Programs, runtimes and copied source") < text.indexOf("## Packages (1)"),
  );
  assert.ok(text.indexOf("## Packages (1)") < text.indexOf("## License texts (2)"));
  assert.match(text, /### tool\n\nA separate program\.\n\n- License: BSD-2-Clause/);
  assert.match(text, /````text\nUse ```code``` freely\.\n````/);
});

test("a copyright statement with backticks survives as a code span", () => {
  const text = renderDocument(buildModel([record("odd", "1.0.0", "MIT", [mit("2020 `Odd` Inc")])]));
  assert.match(
    text,
    /- Copyright: `` Copyright \(c\) 2020 `Odd` Inc ``|- Copyright: ``Copyright \(c\) 2020 `Odd` Inc``/,
  );
});

test("the committed THIRD_PARTY_NOTICES.md is consistent with itself", () => {
  const text = readFileSync(
    fileURLToPath(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url)),
    "utf8",
  );
  assert.ok(!text.includes("\r"), "LF line endings");
  assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"));
  assert.ok(!/\/Users\/|\/home\/|node_modules\/\.pnpm|\/private\//.test(text), "no host paths");
  const textsHeading = /^## License texts \((\d+)\)$/m.exec(text);
  const packagesHeading = /^## Packages \((\d+)\)$/m.exec(text);
  assert.ok(textsHeading && packagesHeading);
  const [beforeTexts, texts] = text.split(textsHeading[0]);
  const ids = [...texts.matchAll(/^### Text (\d+)$/gm)].map((match) => Number(match[1]));
  assert.equal(ids.length, Number(textsHeading[1]));
  assert.deepEqual(
    ids,
    ids.map((_, index) => index + 1),
  );
  const packagesSection = beforeTexts.split(packagesHeading[0])[1];
  assert.equal([...packagesSection.matchAll(/^### /gm)].length, Number(packagesHeading[1]));
  for (const match of beforeTexts.matchAll(/\[text (\d+)\]\(#text-(\d+)\)/g)) {
    assert.equal(match[1], match[2]);
    assert.ok(ids.includes(Number(match[1])), `text ${match[1]} exists`);
  }
  // Every entry names a license; every package entry points to a text or says why not.
  for (const block of packagesSection.split(/^### /m).slice(1)) {
    assert.match(block, /^- License: \S/m);
    assert.match(
      block,
      /^- License text: (\[text \d+\]|the package ships no license file and no standard text)/m,
    );
    assert.match(block, /^- Copyright:/m);
  }
});

const APACHE_FULL = `Apache License\nVersion 2.0, January 2004\n\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\n${"Long terms. ".repeat(300)}`;
const APACHE_SHORT =
  'Copyright 2016, the Blazer authors\n\nLicensed under the Apache License, Version 2.0 (the "License");\nyou may not use this file except in compliance with the License.';

function resticModules() {
  const files = {
    "a@v1/LICENSE": APACHE_FULL,
    "b@v1/LICENSE": APACHE_SHORT,
    "c@v1/LICENSE": mit("2014 HashiCorp"),
    "c@v1/NOTICE": "C\nThis product includes software developed at C.",
  };
  return readResticModules(
    {
      restic: "0.19.1",
      modules: [
        {
          path: "example.com/full",
          version: "v1.0.0",
          license: "Apache-2.0",
          source: "https://github.com/example/full",
          ref: "refs/tags/v1.0.0",
          subdir: "",
          licenseFiles: ["a@v1/LICENSE"],
          noticeFiles: [],
        },
        {
          path: "example.com/Short",
          version: "v0.7.2",
          license: "Apache-2.0",
          source: "https://github.com/example/short",
          ref: "refs/tags/sub/v0.7.2",
          subdir: "sub",
          licenseFiles: ["b@v1/LICENSE"],
          noticeFiles: [],
        },
        {
          path: "example.com/lru/v2",
          version: "v2.0.7",
          license: "MPL-2.0",
          source: "https://github.com/example/lru",
          ref: "refs/tags/v2.0.7",
          subdir: "",
          licenseFiles: ["c@v1/LICENSE"],
          noticeFiles: ["c@v1/NOTICE"],
        },
      ],
    },
    { readText: (file) => files[file] },
  );
}

test("the modules in restic: a short license notice also points to the full text, NOTICE files are kept whole", () => {
  const model = buildModel([
    ...resticModules(),
    record("pkg", "1.0.0", "Apache-2.0", [APACHE_FULL]),
  ]);
  const byName = Object.fromEntries(model.packages.map((entry) => [entry.name, entry]));
  const full = model.texts.find((text) => text.body.includes("TERMS AND CONDITIONS"));
  assert.ok(full);
  assert.deepEqual(byName["example.com/full"].textIds, [full.id]);
  // The short notice and the full text it points to.
  assert.equal(byName["example.com/Short"].textIds.length, 2);
  assert.ok(byName["example.com/Short"].textIds.includes(full.id));
  assert.deepEqual(byName["example.com/Short"].statements, ["Copyright 2016, the Blazer authors"]);
  assert.equal(byName["example.com/lru/v2"].noticeIds.length, 1);
  assert.equal(byName["example.com/full"].group, "restic-module");
  assert.equal(byName.pkg.group, "package");
});

test("an MPL-2.0 module says where its source code is; the others name their repository", () => {
  const note = moduleSourceNote({
    path: "github.com/Example/lru/v2",
    version: "v2.0.7",
    license: "MPL-2.0",
    source: "https://github.com/example/lru",
    ref: "refs/tags/v2.0.7",
    subdir: "",
  });
  assert.match(
    note,
    /^Covered by the Mozilla Public License 2\.0\. restic contains this module unmodified/,
  );
  assert.match(note, /https:\/\/github\.com\/example\/lru \(tag v2\.0\.7\)/);
  assert.match(
    note,
    /https:\/\/proxy\.golang\.org\/github\.com\/!example\/lru\/v2\/@v\/v2\.0\.7\.zip/,
  );
  assert.equal(
    moduleSourceNote({
      path: "example.com/sub",
      version: "v0.2.8",
      license: "Apache-2.0",
      source: "https://github.com/example/mono",
      ref: "refs/tags/sub/v0.2.8",
      subdir: "sub",
    }),
    "Source: https://github.com/example/mono (tag sub/v0.2.8, folder sub).",
  );
});

test("the modules in restic get a section between the components and the packages", () => {
  const model = buildModel([
    record("pkg", "1.0.0", "MIT", [mit("2020 P")]),
    record("restic", "0.19.1", "BSD-2-Clause", ["Copyright (c) 2014, A\n\nBSD terms."], {
      component: true,
      group: "component",
    }),
    ...resticModules(),
  ]);
  const text = renderDocument(model);
  const components = text.indexOf("## Programs, runtimes and copied source");
  const modules = text.indexOf("## Go modules compiled into the restic binary (3)");
  const packages = text.indexOf("## Packages (1)");
  assert.ok(components < modules && modules < packages, "components, modules, packages");
  assert.match(
    text,
    /### example\.com\/full v1\.0\.0\n\nSource: https:\/\/github\.com\/example\/full \(tag v1\.0\.0\)\.\n\n- License: Apache-2\.0\n- Copyright: no copyright line in the module's license or NOTICE files/,
  );
  // The package section counts only the packages.
  assert.equal(
    [...text.split("## Packages (1)")[1].split("## License texts")[0].matchAll(/^### /gm)].length,
    1,
  );
});

test("the agent's notices list the agent first, then the modules in restic, then each text once", () => {
  const model = buildModel([
    record("restic", "0.19.1", "BSD-2-Clause", ["Copyright (c) 2014, A\n\nBSD terms."], {
      component: true,
      group: "component",
    }),
    record("restow-agent", "", "Apache-2.0", [APACHE_FULL], {
      component: true,
      group: "component",
      statements: ["Copyright 2026 Example UG"],
    }),
    ...resticModules(),
  ]);
  const text = renderAgentNotices(model);
  assert.ok(text.startsWith("Restow agent: license and third-party notices\n"));
  assert.ok(text.indexOf("restow-agent\n") < text.indexOf("restic 0.19.1\n"));
  assert.match(
    text,
    /restow-agent\n-+\nLicense: Apache-2\.0\nCopyright:\n {2}Copyright 2026 Example UG\nLicense text: \[1\]/,
  );
  assert.match(text, /^Go modules compiled into the restic binary \(3\)$/m);
  assert.match(text, /^License texts \(\d+\)$/m);
  assert.match(text, /^\[1\] used by 3 entries$/m);
  assert.ok(!text.includes("\r") && text.endsWith("\n") && !text.endsWith("\n\n"));
});

test("the committed notices carry every module of restic, with the MPL source statement", () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(
    readFileSync(new URL("licenses/restic-deps/modules.json", root), "utf8"),
  );
  const markdown = readFileSync(new URL("THIRD_PARTY_NOTICES.md", root), "utf8");
  const agent = readFileSync(new URL("agent/THIRD_PARTY_NOTICES.txt", root), "utf8");
  assert.match(
    markdown,
    new RegExp(
      `^## Go modules compiled into the restic binary \\(${manifest.modules.length}\\)$`,
      "m",
    ),
  );
  for (const module of manifest.modules) {
    assert.ok(markdown.includes(`\n### ${module.path} ${module.version}\n`), module.path);
    assert.ok(agent.includes(`\n${module.path} ${module.version}\n`), module.path);
  }
  for (const text of [markdown, agent]) {
    assert.match(
      text,
      /Covered by the Mozilla Public License 2\.0\. restic contains this module\s+unmodified/,
    );
    assert.ok(!/\/Users\/|\/home\/|\/private\//.test(text), "no host paths");
  }
  assert.match(agent, /^restow-agent\n-+\nThe Restow endpoint agent/m);
  assert.match(agent, /^restic \d+\.\d+\.\d+\n/m);
  assert.match(agent, /^Go standard library and runtime\n/m);
  // Every text an entry points to exists.
  const count = Number(/^License texts \((\d+)\)$/m.exec(agent)?.[1]);
  for (const match of agent.matchAll(/^(?:License text|Notice file): (.*)$/gm)) {
    for (const id of match[1].matchAll(/\[(\d+)\]/g)) {
      assert.ok(Number(id[1]) >= 1 && Number(id[1]) <= count, match[0]);
    }
  }
});
