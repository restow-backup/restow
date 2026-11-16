/**
 * Self-test of the claims guard (check-claims.mjs):
 * `node --test scripts/ci/check-claims.test.mjs`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  checkClaims,
  findTags,
  isSearchedFile,
  parseRegister,
  REGISTER_PATH,
  testPathsOf,
  walkFiles,
} from "./check-claims.mjs";

let root;

function write(path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** One register entry; `overrides` replaces or adds fields, a null value drops one. */
function entry(id, overrides = {}) {
  const fields = {
    Aussage: "Grün gibt es nur nach einer bestandenen Prüfung.",
    Fundstelle: "README.md (Abschnitt „What it does“)",
    "Öffentliche Seite": "nicht abgeglichen",
    Tests: "packages/core/src/a.test.ts",
    "Belegt gegen": "Logik",
    Stand: "belegt",
    ...overrides,
  };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `- ${name}: ${value}`);
  return [`### ${id}`, ...lines, ""].join("\n");
}

function register(...entries) {
  write(REGISTER_PATH, ["# Aussagenregister", "", "## Bereich", "", ...entries].join("\n"));
}

function check() {
  return checkClaims(root, { files: walkFiles(root) });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "check-claims-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseRegister", () => {
  it("reads the entries with their fields, a value continued on indented lines", () => {
    const { claims, errors } = parseRegister(
      [
        "## Bereich",
        "",
        "### READY-001",
        "- Aussage: Grün gibt es nur nach einer",
        "  bestandenen Prüfung.",
        "- Stand: belegt",
        "",
        "Freier Text gehört zu keinem Feld.",
        "",
        "### READY-002",
        "- Stand: Abweichung",
      ].join("\n"),
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(
      claims.map((claim) => [claim.id, claim.area, claim.line]),
      [
        ["READY-001", "READY", 3],
        ["READY-002", "READY", 10],
      ],
    );
    assert.equal(
      claims[0].fields.get("Aussage"),
      "Grün gibt es nur nach einer bestandenen Prüfung.",
    );
    assert.equal(claims[1].fields.get("Stand"), "Abweichung");
  });

  it("reports an ID used twice, a field given twice and a heading that is no ID", () => {
    const { errors } = parseRegister(
      ["### READY-001", "- Stand: belegt", "- Stand: belegt", "### READY-001", "### Ready 2"].join(
        "\n",
      ),
    );
    assert.equal(errors.length, 3);
    assert.match(errors.join("\n"), /"Stand" is given twice/);
    assert.match(errors.join("\n"), /READY-001: the ID is used twice/);
    assert.match(errors.join("\n"), /"### Ready 2" is no claim ID/);
  });
});

describe("testPathsOf", () => {
  it("splits at commas, drops backticks and reads 'keine' as no test", () => {
    assert.deepEqual(testPathsOf("a/b.test.ts, `c/d_test.go`"), ["a/b.test.ts", "c/d_test.go"]);
    assert.deepEqual(testPathsOf("keine"), []);
    assert.deepEqual(testPathsOf(""), []);
    assert.deepEqual(testPathsOf(undefined), []);
  });
});

describe("findTags", () => {
  it("finds an ID in the title of a vitest test and of its describe", () => {
    const tags = findTags(
      "a.test.ts",
      [
        'describe("readiness [READY-001]", () => {',
        '  it("stays unverified [READY-002] [VERIFY-010]", () => {});',
        "});",
      ].join("\n"),
    );
    assert.deepEqual(
      tags.map((tag) => [tag.id, tag.line, tag.mode]),
      [
        ["READY-001", 1, "runs"],
        ["READY-002", 2, "runs"],
        ["VERIFY-010", 2, "runs"],
      ],
    );
  });

  it("tells a parked expectation and a skipped test from one that runs", () => {
    const tags = findTags(
      "a.test.ts",
      [
        'it.fails("turns red at once [FAULT-001]", () => {});',
        "it.fails(",
        '  "a wrapped title [FAULT-002]",',
        "  () => {},",
        ");",
        'it.skip("never runs [FAULT-003]", () => {});',
        'it.todo("later [FAULT-004]");',
        'describe.skipIf(!databaseUrl)("against Postgres [FAULT-005]", () => {});',
        'it("runs right after a parked one [FAULT-006]", () => {});',
      ].join("\n"),
    );
    assert.deepEqual(
      tags.map((tag) => [tag.id, tag.mode]),
      [
        ["FAULT-001", "fails"],
        ["FAULT-002", "fails"],
        ["FAULT-003", "skipped"],
        ["FAULT-004", "skipped"],
        ["FAULT-005", "runs"],
        ["FAULT-006", "runs"],
      ],
    );
  });

  it("reads a Go comment above a test function, several IDs separated by commas", () => {
    const tags = findTags(
      "agent/internal/x/x_test.go",
      [
        "// TestAppendOnly checks that the agent cannot delete.",
        "// claim: AGENT-001, AGENT-002",
        "func TestAppendOnly(t *testing.T) {",
        "}",
        "",
        "// claim: AGENT-003",
        "func helper() {}",
      ].join("\n"),
    );
    assert.deepEqual(
      tags.map((tag) => [tag.id, tag.line, tag.misplaced === true]),
      [
        ["AGENT-001", 2, false],
        ["AGENT-002", 2, false],
        ["AGENT-003", 6, true],
      ],
    );
  });

  it("reads a comment in a shell script, a smoke check and a workflow", () => {
    assert.deepEqual(
      findTags("agent/scripts/integration.sh", "# claim: AGENT-001\nrun_test\n").map((t) => t.id),
      ["AGENT-001"],
    );
    assert.deepEqual(
      findTags("scripts/smoke/checks/05-imap.mjs", "// claim: RESTORE-005\n").map((t) => t.id),
      ["RESTORE-005"],
    );
    assert.deepEqual(
      findTags(".github/workflows/sql-server.yml", "      # claim: SQL-001\n").map((t) => t.id),
      ["SQL-001"],
    );
  });

  it("takes no ID from a comment in a vitest file: there the title binds", () => {
    assert.deepEqual(findTags("a.test.ts", '// claim: READY-001\nit("x", () => {});\n'), []);
  });
});

describe("isSearchedFile", () => {
  it("searches tests, scripts, smoke checks and workflows, not product code or the guard", () => {
    for (const path of [
      "packages/core/src/a.test.ts",
      "apps/web/src/a.test.tsx",
      "scripts/ci/release-lib.test.mjs",
      "agent/internal/x/x_test.go",
      "agent/scripts/integration.sh",
      "agent/scripts/test-install-windows.ps1",
      "tools/t/provider.t",
      "scripts/smoke/checks/05-imap.mjs",
      ".github/workflows/sql-server.yml",
    ]) {
      assert.equal(isSearchedFile(path), true, path);
    }
    for (const path of [
      "packages/core/src/a.ts",
      "docs/CLAIMS.md",
      "agent/internal/x/x.go",
      "scripts/ci/check-claims.mjs",
      "scripts/ci/check-claims.test.mjs",
    ]) {
      assert.equal(isSearchedFile(path), false, path);
    }
  });
});

describe("checkClaims", () => {
  it("passes a register whose every claim is carried by the test it names", () => {
    register(
      entry("READY-001"),
      entry("AGENT-001", { Tests: "agent/internal/x/x_test.go, agent/scripts/integration.sh" }),
    );
    write("packages/core/src/a.test.ts", 'it("green only after a check [READY-001]", () => {});\n');
    write("agent/internal/x/x_test.go", "// claim: AGENT-001\nfunc TestX(t *testing.T) {}\n");
    write("agent/scripts/integration.sh", "# claim: AGENT-001\n");
    const result = check();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.summary.total, 2);
    assert.deepEqual(result.summary.byState, { belegt: 2 });
    assert.deepEqual(result.summary.byArea, {
      READY: { total: 1, belegt: 1 },
      AGENT: { total: 1, belegt: 1 },
    });
  });

  it("fails without a register, and with one that holds no claim", () => {
    assert.match(check().errors.join("\n"), /docs\/CLAIMS\.md does not exist/);
    write(REGISTER_PATH, "# Aussagenregister\n");
    assert.match(check().errors.join("\n"), /holds no claim/);
  });

  it("fails when a claim names no test", () => {
    register(entry("READY-001", { Tests: "keine" }));
    assert.match(check().errors.join("\n"), /READY-001: no test proves this claim/);
  });

  it("fails when a named test does not exist", () => {
    register(entry("READY-001"));
    assert.match(
      check().errors.join("\n"),
      /READY-001: the test packages\/core\/src\/a\.test\.ts does not exist/,
    );
  });

  it("fails when the named test does not carry the ID", () => {
    register(entry("READY-001"));
    write("packages/core/src/a.test.ts", 'it("green only after a check", () => {});\n');
    assert.match(check().errors.join("\n"), /a\.test\.ts does not carry the ID/);
  });

  it("fails when a test carries an ID the register does not know", () => {
    register(entry("READY-001"));
    write("packages/core/src/a.test.ts", 'it("a [READY-001]", () => {});\n');
    write("packages/core/src/b.test.ts", 'it("b [READY-099]", () => {});\n');
    assert.match(
      check().errors.join("\n"),
      /packages\/core\/src\/b\.test\.ts:1: carries READY-099, which docs\/CLAIMS\.md does not know/,
    );
  });

  it("fails when a test carries the ID and the entry does not name the file", () => {
    register(entry("READY-001"));
    write("packages/core/src/a.test.ts", 'it("a [READY-001]", () => {});\n');
    write("apps/api/src/c.test.ts", 'it("c [READY-001]", () => {});\n');
    assert.match(
      check().errors.join("\n"),
      /READY-001: apps\/api\/src\/c\.test\.ts carries the ID but the entry does not name it/,
    );
  });

  it("fails when the named file is no test file", () => {
    register(entry("READY-001", { Tests: "packages/core/src/a.ts" }));
    write("packages/core/src/a.ts", "// claim: READY-001\n");
    assert.match(check().errors.join("\n"), /a\.ts is no test file the guard searches/);
  });

  it("fails on a missing field, an unknown Stand and an unknown kind of evidence", () => {
    register(
      entry("READY-001", { "Öffentliche Seite": null }),
      entry("READY-002", { Stand: "vermutlich" }),
      entry("READY-003", { "Belegt gegen": "Hoffnung" }),
    );
    write(
      "packages/core/src/a.test.ts",
      'it("a [READY-001] [READY-002] [READY-003]", () => {});\n',
    );
    const errors = check().errors.join("\n");
    assert.match(errors, /READY-001: the field "Öffentliche Seite" is missing or empty/);
    assert.match(errors, /READY-002: Stand "vermutlich" is none of/);
    assert.match(errors, /READY-003: "Belegt gegen" must start with one of/);
  });

  it("fails when an ID sits on a skipped test", () => {
    register(entry("READY-001"));
    write("packages/core/src/a.test.ts", 'it.skip("a [READY-001]", () => {});\n');
    assert.match(check().errors.join("\n"), /READY-001 sits on a skipped test/);
  });

  it("fails when a Go claim comment is not directly above a test function", () => {
    register(entry("AGENT-001", { Tests: "agent/internal/x/x_test.go" }));
    write("agent/internal/x/x_test.go", "// claim: AGENT-001\n\nfunc TestX(t *testing.T) {}\n");
    assert.match(check().errors.join("\n"), /is not directly above a test function/);
  });

  describe("Stand: Abweichung", () => {
    const deviation = {
      Stand: "Abweichung",
      Erwartung: "Ein fehlendes Pack macht das Objekt innerhalb von 24 Stunden rot.",
      Abweichung: "Erst die monatliche vollständige Prüfung liest jedes Pack (scrub.ts:12).",
    };

    it("passes with the failing expectation parked, and counts it as a warning", () => {
      register(entry("FAULT-001", deviation));
      write("packages/core/src/a.test.ts", 'it.fails("red within a day [FAULT-001]", () => {});\n');
      const result = check();
      assert.deepEqual(result.errors, []);
      assert.equal(result.warnings.length, 1);
      assert.match(
        result.warnings[0],
        /FAULT-001: Abweichung, parked expectation in .*a\.test\.ts:1/,
      );
      assert.deepEqual(result.summary.byState, { Abweichung: 1 });
    });

    it("fails when no test of the claim is parked", () => {
      register(entry("FAULT-001", deviation));
      write("packages/core/src/a.test.ts", 'it("red within a day [FAULT-001]", () => {});\n');
      assert.match(check().errors.join("\n"), /no test with its ID is parked with it\.fails/);
    });

    it("fails without the expectation and what the product does instead", () => {
      register(entry("FAULT-001", { Stand: "Abweichung" }));
      write("packages/core/src/a.test.ts", 'it.fails("red within a day [FAULT-001]", () => {});\n');
      const errors = check().errors.join("\n");
      assert.match(errors, /needs the field "Erwartung"/);
      assert.match(errors, /needs the field "Abweichung"/);
    });

    it("fails when a claim called belegt rests on a parked test", () => {
      register(entry("FAULT-001"));
      write("packages/core/src/a.test.ts", 'it.fails("red within a day [FAULT-001]", () => {});\n');
      assert.match(check().errors.join("\n"), /is "belegt" but this test is parked with it\.fails/);
    });
  });

  describe("Stand: nur behauptet", () => {
    const unproven = {
      Stand: "nur behauptet",
      Tests: "keine",
      "Belegt gegen": "nichts",
      Grund: "Braucht einen echten Mandanten, den es in der Pipeline nicht gibt.",
    };

    it("passes with a reason and counts the claim as a warning", () => {
      register(entry("M365-001", unproven));
      const result = check();
      assert.deepEqual(result.errors, []);
      assert.equal(result.warnings.length, 1);
      assert.match(result.warnings[0], /M365-001: nur behauptet \(Braucht einen echten Mandanten/);
      assert.deepEqual(result.summary.byState, { "nur behauptet": 1 });
    });

    it("fails without a reason", () => {
      register(entry("M365-001", { ...unproven, Grund: null }));
      assert.match(check().errors.join("\n"), /needs the field "Grund"/);
    });

    it("fails when a test carries its ID or the entry names a test", () => {
      register(entry("M365-001", { ...unproven, Tests: "packages/core/src/a.test.ts" }));
      write("packages/core/src/a.test.ts", 'it("a [M365-001]", () => {});\n');
      const errors = check().errors.join("\n");
      assert.match(errors, /"nur behauptet" but "Tests" names a file/);
      assert.match(errors, /a\.test\.ts:1: carries M365-001, whose Stand is "nur behauptet"/);
    });

    it("fails when a proven claim says it is proven against nothing", () => {
      register(entry("READY-001", { "Belegt gegen": "nichts" }));
      write("packages/core/src/a.test.ts", 'it("a [READY-001]", () => {});\n');
      assert.match(check().errors.join("\n"), /"Belegt gegen: nichts" is only for/);
    });
  });

  it("does not search build output, dependencies or product code for IDs", () => {
    register(entry("READY-001"));
    write("packages/core/src/a.test.ts", 'it("a [READY-001]", () => {});\n');
    write("packages/core/dist/a.test.js", 'it("a [READY-777]", () => {});\n');
    write("node_modules/x/x.test.js", 'it("a [READY-778]", () => {});\n');
    write("packages/core/src/a.ts", "// claim: READY-779\n");
    assert.deepEqual(check().errors, []);
  });
});

describe("the real register", () => {
  it("passes on this repository", () => {
    const result = checkClaims();
    assert.deepEqual(result.errors, []);
    assert.ok(result.summary.total >= 60, `only ${result.summary.total} claims`);
  });
});
