#!/usr/bin/env node
/**
 * Go dependency check (CI). The endpoint agent in agent/ uses the Go standard library
 * only (agent/README.md, "Dependencies"), so there are no Go module licenses to track.
 * This check keeps it that way: it fails as soon as agent/ depends on a module other
 * than its own, in the build or in the tests, for any of the four shipped targets
 * (the same list as agent/build.sh). A third-party Go module needs a license check
 * (allowlist as for npm, see scripts/ci/license-policy.json) before it can be added.
 *
 * It asks `go list`: `go list -m all` for the module graph and
 * `go list -deps -test ./...` for the packages that are really compiled.
 *
 * Usage: node scripts/ci/check-go-deps.mjs
 * With `go` on the PATH it runs that; otherwise it runs the pinned golang image of
 * agent/tools.env in Docker (as agent/build.sh does), so it works on a Mac without Go.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const AGENT_DIR = fileURLToPath(new URL("../../agent", import.meta.url));

/** The targets agent/build.sh ships. */
export const TARGETS = [
  { goos: "linux", goarch: "amd64" },
  { goos: "linux", goarch: "arm64" },
  { goos: "darwin", goarch: "amd64" },
  { goos: "darwin", goarch: "arm64" },
];

export const MODULE_FORMAT = "{{.Path}} {{.Main}}";
export const DEPS_FORMAT = "{{with .Module}}{{if not .Main}}{{.Path}}@{{.Version}}{{end}}{{end}}";

/** Pure: modules of `go list -m -f '{{.Path}} {{.Main}}' all` that are not the main module. */
export function foreignModules(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter(([, main]) => main !== "true")
    .map(([path]) => path);
}

/** Pure: modules named by `go list -deps -test -f DEPS_FORMAT ./...` (stdlib and own packages print nothing). */
export function foreignPackages(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Pure: GO_IMAGE from the text of agent/tools.env. */
export function goImage(toolsEnv) {
  const match = /^GO_IMAGE=(\S+)\s*$/m.exec(toolsEnv);
  return match ? match[1] : undefined;
}

function haveGo() {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function makeRunner() {
  if (haveGo()) {
    return (args, env = {}) =>
      execFileSync("go", args, {
        cwd: AGENT_DIR,
        env: { ...process.env, ...env },
        encoding: "utf8",
      });
  }
  const image = goImage(readFileSync(`${AGENT_DIR}/tools.env`, "utf8"));
  if (!image) {
    throw new Error("go is not on the PATH and agent/tools.env names no GO_IMAGE");
  }
  console.log(`check-go-deps: go is not on the PATH, using ${image} in Docker`);
  return (args, env = {}) =>
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${AGENT_DIR}:/src:ro`,
        "-w",
        "/src",
        "-e",
        "HOME=/tmp",
        "-e",
        "GOPATH=/tmp/go",
        "-e",
        "GOFLAGS=-buildvcs=false",
        ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        image,
        "go",
        ...args,
      ],
      { encoding: "utf8" },
    );
}

function main() {
  if (!existsSync(`${AGENT_DIR}/go.mod`)) {
    console.log("check-go-deps: agent/ does not exist in this tree, nothing to check");
    return;
  }
  const go = makeRunner();
  const found = new Set(foreignModules(go(["list", "-m", "-f", MODULE_FORMAT, "all"])));
  for (const { goos, goarch } of TARGETS) {
    const output = go(["list", "-deps", "-test", "-f", DEPS_FORMAT, "./..."], {
      GOOS: goos,
      GOARCH: goarch,
    });
    for (const name of foreignPackages(output)) {
      found.add(name);
    }
  }
  if (found.size > 0) {
    console.error(
      `::error::agent/ depends on third-party Go modules (${[...found].sort().join(", ")}). The agent is standard library only; a Go module needs a license check first (scripts/ci/check-go-deps.mjs).`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `check-go-deps: agent/ uses the Go standard library only (module graph and ${TARGETS.length} targets checked)`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
