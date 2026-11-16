/**
 * The recovery lab's image and compose service (docs/BAREMETAL.md 12.3, licenses/restow-lab-NOTICES.md):
 *
 *   - the lab stage builds from a Debian image pinned by digest and one snapshot.debian.org time,
 *     the ones lab-sources.sh takes, so its packages are the ones the source bundle lists;
 *   - every file it downloads is pinned by SHA-256, and the DBX pins are the ones the licence
 *     notices name;
 *   - it takes nothing of Restow but the lab's compiled files;
 *   - the compose service gets its token and nothing else: no env_file, no database, no key, no
 *     Docker socket; read-only, no capabilities, no new privileges, /dev/kvm.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(repo, path), "utf8");

/** The text of one stage of the Dockerfile, from its FROM to the next stage's banner. */
function stage(dockerfile, name) {
  const start = dockerfile.search(new RegExp(`^FROM \\S+ AS ${name}$`, "m"));
  assert.ok(start >= 0, `no stage ${name}`);
  const rest = dockerfile.slice(start);
  const end = rest.slice(1).search(/^#{20,}$/m);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/** The lines of one compose service (two-space indent), without comments. */
function service(compose, name) {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `no service ${name}`);
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break;
    out.push(line.replace(/\s+#.*$/, ""));
  }
  return out.join("\n");
}

describe("the recovery lab image [CRYPT-006]", () => {
  const dockerfile = read("Dockerfile");
  const lab = stage(dockerfile, "lab");

  it("builds from a pinned Debian image and one snapshot time, which the source bundle reads", () => {
    assert.match(
      /^ARG LAB_DEBIAN_IMAGE=(\S+)$/m.exec(dockerfile)?.[1] ?? "",
      /^debian:trixie@sha256:[0-9a-f]{64}$/,
    );
    assert.match(/^ARG LAB_SNAPSHOT=(\S+)$/m.exec(lab)?.[1] ?? "", /^\d{8}T\d{6}Z$/);
    const sources = read("scripts/docker/lab-sources.sh");
    assert.match(sources, /\^ARG LAB_DEBIAN_IMAGE=/);
    assert.match(sources, /\^ARG LAB_SNAPSHOT=/);
    assert.match(lab, /^FROM \$\{LAB_DEBIAN_IMAGE\} AS lab$/m);
    assert.match(lab, /snapshot\.debian\.org\/archive\/debian\/%s\/ trixie main/);
  });

  it("pins every download, and the DBX pins are the licence notices'", () => {
    const adds = [...lab.matchAll(/^ADD (.*?)\\\n\s+(https:\/\/\S+) \\\n\s+(\S+)$/gm)];
    assert.equal(adds.length, 3);
    const notices = read("licenses/restow-lab-NOTICES.md");
    for (const [, flags, url, target] of adds) {
      const sha = /--checksum=sha256:([0-9a-f]{64})/.exec(flags)?.[1];
      assert.ok(sha, `${url} has no checksum`);
      assert.match(
        url,
        /^https:\/\/raw\.githubusercontent\.com\/microsoft\/secureboot_objects\/[0-9a-f]{40}\//,
      );
      assert.ok(
        notices.includes(`| ${target} |`) && notices.includes(sha),
        `${target} ${sha} not in the notices`,
      );
    }
    assert.doesNotMatch(lab.replace(/^ADD [\s\S]*?\n(?=\S)/gm, ""), /curl|wget/);
  });

  it("takes nothing of Restow but the lab's own files", () => {
    const copies = [...lab.matchAll(/^COPY (--from=\S+ )?(.+)$/gm)].map(
      (m) => `${m[1] ?? ""}${m[2]}`,
    );
    assert.deepEqual(
      copies.filter((line) => line.startsWith("--from=build")),
      ["--from=build-community /app/apps/worker/dist/apps/worker/src/lab/ /opt/restow-lab/"],
    );
    assert.match(lab, /^USER 10001:10001$/m);
    assert.match(lab, /^ENTRYPOINT \["node", "\/opt\/restow-lab\/main\.js"\]$/m);
  });

  for (const file of ["docker-compose.yml", "deploy/release/docker-compose.yml"]) {
    it(`gets its token and nothing else in ${file}`, () => {
      const text = service(read(file), "recovery-lab");
      assert.match(text, /profiles: \["recovery-lab"\]/);
      assert.doesNotMatch(
        text,
        /env_file|DATABASE|MASTER_KEY|docker\.sock|BETTER_AUTH|POSTGRES|privileged/,
      );
      const env = [...text.matchAll(/^ {6}([A-Z_]+):/gm)].map((m) => m[1]);
      assert.ok(
        env.length > 0 && env.every((name) => name.startsWith("RESTOW_LAB_")),
        env.join(" "),
      );
      assert.match(text, /- \/dev\/kvm:\/dev\/kvm/);
      assert.match(text, /read_only: true/);
      assert.match(text, /cap_drop:\n\s+- ALL/);
      assert.match(text, /no-new-privileges:true/);
      assert.deepEqual(
        [...text.matchAll(/^ {6}- (\S+:\S+)$/gm)]
          .map((m) => m[1])
          .filter((v) => v.includes("restow")),
        ["restow-lab:/var/lib/restow-lab"],
      );
    });
  }
});
