/**
 * Self-test of the separate-works guard (check-separate-works.mjs):
 * `node --test scripts/ci/check-separate-works.test.mjs`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkWork } from "./check-separate-works.mjs";

const AGPL = "GNU AFFERO GENERAL PUBLIC LICENSE\n Version 3, 19 November 2007\n...";
const HEADER = "# SPDX-License-Identifier: AGPL-3.0-or-later\npackage X;\n1;\n";

function repo(files) {
  return {
    list: Object.keys(files),
    read: (path) => Buffer.from(files[path] ?? ""),
  };
}

const work = {
  path: "integrations/pve/plugin",
  license: "AGPL-3.0-or-later",
  allowedReferences: ["agent/build.sh"],
};

describe("checkWork", () => {
  it("passes a clean separate work", () => {
    const r = repo({
      "integrations/pve/plugin/LICENSE": AGPL,
      "integrations/pve/plugin/RestowPlugin.pm": HEADER,
      "agent/build.sh": "cp integrations/pve/plugin/RestowPlugin.pm dist/\n",
      "apps/api/src/x.ts": "export const x = 1;\n",
    });
    assert.deepEqual(checkWork(work, r.list, r.read), []);
  });

  it("flags a missing license, a missing or wrong header and core code", () => {
    const r = repo({
      "integrations/pve/plugin/A.pm": "package A;\n1;\n",
      "integrations/pve/plugin/B.pm": "# SPDX-License-Identifier: Apache-2.0\n",
      "integrations/pve/plugin/c.ts": "export {};\n",
      "integrations/pve/plugin/D.pm": `${HEADER}# use @restow/core\n`,
    });
    const findings = checkWork(work, r.list, r.read).join("\n");
    assert.match(findings, /LICENSE with the full/);
    assert.match(findings, /A\.pm: no SPDX/);
    assert.match(findings, /B\.pm: SPDX-License-Identifier Apache-2\.0/);
    assert.match(findings, /c\.ts: Restow core code/);
    assert.match(findings, /D\.pm: refers to a Restow core package/);
  });

  it("flags references and copies outside the folder", () => {
    const r = repo({
      "integrations/pve/plugin/LICENSE": AGPL,
      "integrations/pve/plugin/RestowPlugin.pm": HEADER,
      "apps/api/src/plugin.ts":
        'import x from "../../../integrations/pve/plugin/RestowPlugin.pm";\n',
      "packages/core/src/copy.pm": HEADER,
    });
    const findings = checkWork(work, r.list, r.read).join("\n");
    assert.match(findings, /apps\/api\/src\/plugin\.ts: refers to integrations\/pve\/plugin/);
    assert.match(findings, /packages\/core\/src\/copy\.pm: is a copy of/);
  });

  it("reports a missing folder", () => {
    assert.match(checkWork(work, [], () => Buffer.alloc(0))[0], /missing or empty/);
  });
});
