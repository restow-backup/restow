/**
 * The source code of the MySQL and MariaDB client programs (GPL-2.0, docs/DATABASES.md 16 "D4"):
 *
 *   - the mysql-tools stage writes /opt/mysql/VERSION from the archive's folder name and strips
 *     the symbols on arm64 only; runtime-base checks the programs against that version;
 *   - db-client-sources.sh checks the source archives against the keys and fingerprints the
 *     Dockerfile checks the binaries and the MariaDB archive with;
 *   - the release attaches the sources of all four application images;
 *   - it reads the versions of the packages built from the source package mariadb from dpkg's
 *     status, installed ones only.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(repo, path), "utf8");
const script = join(repo, "scripts/docker/db-client-sources.sh");

/** The text of one stage of the Dockerfile, from its FROM to the next FROM. */
function stage(dockerfile, name) {
  const start = dockerfile.search(new RegExp(`^FROM \\S+ AS ${name}$`, "m"));
  assert.ok(start >= 0, `no stage ${name}`);
  const rest = dockerfile.slice(start);
  const end = rest.slice(1).search(/^FROM /m);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

describe("MySQL and MariaDB client sources", () => {
  const dockerfile = read("Dockerfile");
  const sources = read("scripts/docker/db-client-sources.sh");

  it("the image names its MySQL release and strips only on arm64", () => {
    const tools = stage(dockerfile, "mysql-tools");
    assert.match(tools, /^ARG TARGETARCH$/m);
    assert.match(tools, /> \/rootfs\/opt\/mysql\/VERSION;/);
    assert.match(tools, /if \[ "\$TARGETARCH" = arm64 \]; then \\\n\s+strip --strip-unneeded /);
    const runtime = stage(dockerfile, "runtime-base");
    assert.match(runtime, /mysqldump --version \| grep -q "Ver \$\(cat \/opt\/mysql\/VERSION\) "/);
  });

  it("checks the sources with the keys the Dockerfile pins", () => {
    for (const [arg, variable, key] of [
      ["MYSQL_FINGERPRINT", "MYSQL_FINGERPRINT", "mysql-A8D3785C.asc"],
      ["MARIADB_FINGERPRINT", "MARIADB_FINGERPRINT", "mariadb-C74CD1D8.asc"],
    ]) {
      const pinned = new RegExp(`^ARG ${arg}=([0-9A-F]{40})$`, "m").exec(dockerfile)?.[1];
      assert.ok(pinned, `the Dockerfile pins no ${arg}`);
      assert.match(sources, new RegExp(`^${variable}=${pinned}$`, "m"));
      assert.ok(dockerfile.includes(`scripts/docker/${key}`));
      assert.ok(sources.includes(`$HERE/${key}`));
    }
  });

  it("the release attaches the sources of all four application images", () => {
    const release = read(".github/workflows/release.yml");
    const call = /sh scripts\/docker\/db-client-sources\.sh(?:[^\n]*\\\n)*[^\n]*/.exec(
      release,
    )?.[0];
    assert.ok(call, "release.yml does not run db-client-sources.sh");
    for (const image of ["APP_AMD64", "APP_ARM64", "COMMUNITY_APP_AMD64", "COMMUNITY_APP_ARM64"]) {
      assert.match(call, new RegExp(`--image "\\$${image}"`));
    }
    assert.match(release, /restow-db-clients_\$\{VERSION\}_sources\.tar/);
  });

  it("reads the installed versions of the source package mariadb", () => {
    const dir = mkdtempSync(join(tmpdir(), "db-sources-"));
    try {
      const status = join(dir, "status");
      writeFileSync(
        status,
        [
          "Package: mariadb-client",
          "Status: install ok installed",
          "Source: mariadb",
          "Version: 1:11.8.6+maria~deb12",
          "",
          "Package: libmariadb3",
          "Status: install ok installed",
          "Source: mariadb (1:11.8.6+maria~deb12)",
          "Version: 1:3.4.8+maria~deb12",
          "",
          "Package: mariadb-common",
          "Status: deinstall ok config-files",
          "Source: mariadb",
          "Version: 1:10.11.6-0+deb12u1",
          "",
          "Package: libncurses6",
          "Status: install ok installed",
          "Source: ncurses",
          "Version: 6.4-4",
          "",
          "Package: mariadb",
          "Status: install ok installed",
          "Version: 1:11.8.7-0+deb13u1",
        ].join("\n"),
      );
      const out = execFileSync("sh", [script, "--mariadb-versions", status], { encoding: "utf8" });
      assert.deepEqual(out.trim().split("\n"), [
        "1:11.8.6+maria~deb12",
        "1:11.8.6+maria~deb12",
        "1:11.8.7-0+deb13u1",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
