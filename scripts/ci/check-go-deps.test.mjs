import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEPS_FORMAT,
  MODULE_FORMAT,
  TARGETS,
  foreignModules,
  foreignPackages,
  goImage,
} from "./check-go-deps.mjs";

test("the module graph of a module without requirements has only the main module", () => {
  assert.deepEqual(foreignModules("github.com/restow-backup/restow/agent true\n"), []);
  assert.deepEqual(foreignModules(""), []);
});

test("every other module of the graph is foreign", () => {
  assert.deepEqual(
    foreignModules(
      [
        "github.com/restow-backup/restow/agent true",
        "golang.org/x/sys false",
        "github.com/example/thing false",
        "",
      ].join("\n"),
    ),
    ["golang.org/x/sys", "github.com/example/thing"],
  );
});

test("packages print a module only when it is not the main one", () => {
  assert.deepEqual(foreignPackages("\n\n"), []);
  assert.deepEqual(
    foreignPackages("golang.org/x/sys@v0.20.0\n\ngithub.com/example/thing@v1.2.3\n"),
    ["golang.org/x/sys@v0.20.0", "github.com/example/thing@v1.2.3"],
  );
});

test("reads the pinned Go image from tools.env", () => {
  assert.equal(goImage("# comment\nGO_IMAGE=golang:1.27\nRESTIC_VERSION=0.19.1\n"), "golang:1.27");
  assert.equal(goImage("RESTIC_VERSION=0.19.1\n"), undefined);
  const real = readFileSync(
    fileURLToPath(new URL("../../agent/tools.env", import.meta.url)),
    "utf8",
  );
  assert.match(goImage(real) ?? "", /^golang:/);
});

test("it checks the four shipped targets with the format strings it documents", () => {
  assert.deepEqual(
    TARGETS.map((target) => `${target.goos}-${target.goarch}`),
    ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"],
  );
  assert.match(MODULE_FORMAT, /\.Main/);
  assert.match(DEPS_FORMAT, /\.Module/);
});
