import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  MANIFEST,
  VENDOR_DIR,
  classifyLicense,
  compareWithBinaries,
  legalFiles,
  moduleFolder,
  moduleLicense,
  pinnedResticVersion,
  readBuildInfo,
} from "../restic-licenses.mjs";

const START = Buffer.from("3077af0c9274080241e1c107e6d618e6", "hex");
const END = Buffer.from("f932433186182072008242104116d8f2", "hex");

/** A stand-in Go binary: some bytes, the module information between its markers, more bytes. */
function binary(lines) {
  return Buffer.concat([
    Buffer.from("\x7fELF padding \x00\x01"),
    START,
    Buffer.from(lines.join("\n")),
    END,
    Buffer.from("\x00trailer"),
  ]);
}

const RESTIC_INFO = [
  "path\tgithub.com/restic/restic/cmd/restic",
  "mod\tgithub.com/restic/restic\t(devel)\t",
  "dep\texample.com/a\tv1.0.0\th1:aaa=",
  "dep\texample.com/old\tv0.1.0\th1:old=",
  "=>\texample.com/new\tv0.2.0\th1:new=",
  'build\t-ldflags="-s -w"',
  "build\tGOOS=linux",
  "build\tGOARCH=arm64",
  "",
];

test("reads the module information of a Go binary, with replacements and build settings", () => {
  const info = readBuildInfo(binary(RESTIC_INFO));
  assert.equal(info.path, "github.com/restic/restic/cmd/restic");
  assert.equal(info.main, "github.com/restic/restic");
  assert.deepEqual(info.deps, [
    { path: "example.com/a", version: "v1.0.0", sum: "h1:aaa=" },
    { path: "example.com/new", version: "v0.2.0", sum: "h1:new=", replaces: "example.com/old" },
  ]);
  assert.equal(info.settings.GOOS, "linux");
  assert.equal(info.settings.GOARCH, "arm64");
  assert.equal(info.settings["-ldflags"], '"-s -w"');
  assert.throws(() => readBuildInfo(Buffer.from("not a go binary")), /no Go module information/);
});

test("names the license texts and NOTICE files of a module folder", () => {
  assert.deepEqual(
    legalFiles([
      "go.mod",
      "LICENSE",
      "NOTICE.txt",
      "LICENSE.Golang",
      "COPYING",
      "license.go",
      "README.md",
      "notice_test.go",
    ]),
    { licenses: ["COPYING", "LICENSE", "LICENSE.Golang"], notices: ["NOTICE.txt"] },
  );
  assert.equal(
    moduleFolder("github.com/hashicorp/golang-lru/v2", "v2.0.7"),
    "github.com_hashicorp_golang-lru_v2@v2.0.7",
  );
});

const MIT =
  "Copyright (c) 2015 A\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software ...";
const BSD3 =
  "Copyright (c) 2009 The Go Authors.\n\nRedistribution and use in source and binary forms, with or without\nmodification, are permitted ...\n   * Neither the name of Google Inc. nor the names of its\ncontributors may be used ...";
const BSD2 =
  "> Copyright © 2011 Russ Ross\n>\n> Redistribution and use in source and binary forms, with or without\n> modification, are permitted provided that the following conditions\n> are met:\n> 1. ...\n> 2. ...";
const APACHE_NOTICE =
  'Copyright 2016, the Blazer authors\n\nLicensed under the Apache License, Version 2.0 (the "License");\nyou may not use this file except in compliance with the License.';

test("tells the licenses of a text apart, also several in one file and quoted ones", () => {
  assert.deepEqual(classifyLicense(MIT), ["MIT"]);
  assert.deepEqual(classifyLicense(BSD3), ["BSD-3-Clause"]);
  assert.deepEqual(classifyLicense(BSD2), ["BSD-2-Clause"]);
  assert.deepEqual(classifyLicense(APACHE_NOTICE), ["Apache-2.0"]);
  assert.deepEqual(classifyLicense("Mozilla Public License Version 2.0\n=================="), [
    "MPL-2.0",
  ]);
  assert.deepEqual(classifyLicense(`${APACHE_NOTICE}\n\n---\n\n${BSD3}\n\n${MIT}`), [
    "Apache-2.0",
    "MIT",
    "BSD-3-Clause",
  ]);
  assert.deepEqual(classifyLicense(`${BSD3}\n\nFile x.go:\n\n${BSD2}`), [
    "BSD-3-Clause",
    "BSD-2-Clause",
  ]);
  assert.deepEqual(classifyLicense("All rights reserved. Do what you want."), []);
});

test("a module's license joins every license of its texts, and an unknown one stops the vendoring", () => {
  assert.equal(
    moduleLicense("m@v1", [
      { file: "LICENSE", text: APACHE_NOTICE },
      { file: "LICENSE.Golang", text: BSD3 },
    ]),
    "Apache-2.0 AND BSD-3-Clause",
  );
  assert.throws(
    () => moduleLicense("m@v1", [{ file: "LICENSE", text: "Custom terms." }]),
    /not recognised; check it and add it to REVIEWED/,
  );
  assert.throws(() => moduleLicense("m@v1", []), /ships no license file/);
  assert.equal(
    moduleLicense("m@v1", [{ file: "LICENSE", text: "Custom terms." }], { "m@v1": "Zlib" }),
    "Zlib",
  );
});

test("the vendored list must be exactly the modules of every binary, at the same versions and hashes", () => {
  const manifest = {
    restic: "0.19.1",
    modules: [
      { path: "example.com/a", version: "v1.0.0", sum: "h1:aaa=" },
      { path: "example.com/new", version: "v0.2.0", sum: "h1:new=" },
    ],
  };
  const info = readBuildInfo(binary(RESTIC_INFO));
  assert.deepEqual(compareWithBinaries(manifest, [{ file: "restic", info }], "0.19.1"), []);
  const newer = { ...info, deps: [{ ...info.deps[0], version: "v1.1.0" }, info.deps[1]] };
  const extra = {
    ...info,
    deps: [...info.deps, { path: "example.com/b", version: "v1", sum: "" }],
  };
  const fewer = { ...info, deps: [info.deps[0]] };
  const problems = compareWithBinaries(
    manifest,
    [
      { file: "newer", info: newer },
      { file: "extra", info: extra },
      { file: "fewer", info: fewer },
      { file: "agent", info: { ...info, path: "github.com/restow-backup/restow/agent" } },
    ],
    "0.20.0",
  );
  assert.equal(problems.length, 5);
  assert.match(problems[0], /restic 0\.19\.1, agent\/tools\.env pins 0\.20\.0/);
  assert.match(problems[1], /newer \(linux-arm64\) contains example\.com\/a v1\.1\.0/);
  assert.match(
    problems[2],
    /extra \(linux-arm64\) contains example\.com\/b v1, which is not vendored/,
  );
  assert.match(problems[3], /example\.com\/new is vendored but not in fewer/);
  assert.match(problems[4], /agent is not a restic binary/);
});

test("the committed list is complete: the pinned restic, a license for each module, every file present", () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL(MANIFEST, root), "utf8"));
  assert.equal(manifest.restic, pinnedResticVersion());
  assert.ok(manifest.modules.length > 50);
  const paths = manifest.modules.map((module) => module.path);
  assert.deepEqual(paths, [...paths].sort());
  for (const module of manifest.modules) {
    assert.match(module.version, /^v\d/, module.path);
    assert.match(module.sum, /^h1:/, module.path);
    assert.ok(module.license.length > 0, module.path);
    assert.ok(module.licenseFiles.length > 0, `${module.path} has a license text`);
    for (const file of [...module.licenseFiles, ...module.noticeFiles]) {
      assert.ok(
        existsSync(fileURLToPath(new URL(`${VENDOR_DIR}/${file}`, root))),
        `${VENDOR_DIR}/${file}`,
      );
    }
  }
  // The NOTICE files the Apache-2.0 license asks to pass on.
  const noticed = manifest.modules.filter((module) => module.noticeFiles.length > 0);
  assert.deepEqual(
    noticed.map((module) => module.path),
    ["github.com/minio/minio-go/v7", "go.yaml.in/yaml/v3", "google.golang.org/grpc"],
  );
  assert.equal(
    manifest.modules.find((module) => module.path === "github.com/hashicorp/golang-lru/v2")
      ?.license,
    "MPL-2.0",
  );
});
