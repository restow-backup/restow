// Renders the restore script of one SQL Server backup for another machine (W2a,
// docs/BAREMETAL-WINDOWS.md 5.1.4 and 8.2) from the input the CI probe writes, without a build of
// the monorepo: node --experimental-strip-types scripts/ci/render-sql-restore-script.mts \
//   --in probe.json --out restore.ps1
// It imports only the generator (which has no imports itself) and node:fs.
import { readFileSync, writeFileSync } from "node:fs";
import {
  type RestoreScriptInput,
  renderSqlRestoreScript,
} from "../../packages/core/src/endpoints/sql/restore-script.ts";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    console.error(
      `usage: render-sql-restore-script.mts --in <probe.json> --out <restore.ps1> (missing ${name})`,
    );
    process.exit(2);
  }
  return value;
}

const parsed = JSON.parse(readFileSync(argument("--in"), "utf8")) as
  | RestoreScriptInput
  | { restoreScriptInput?: RestoreScriptInput };
// The probe writes the input as `restoreScriptInput` beside its reports; a bare input works too.
const input =
  "restoreScriptInput" in parsed && parsed.restoreScriptInput
    ? parsed.restoreScriptInput
    : (parsed as RestoreScriptInput);
if (typeof input.database !== "string" || typeof input.backup?.sha256 !== "string") {
  console.error("render-sql-restore-script: the input has no database or no backup");
  process.exit(1);
}
writeFileSync(argument("--out"), renderSqlRestoreScript(input));
