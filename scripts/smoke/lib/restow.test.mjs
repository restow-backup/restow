import assert from "node:assert/strict";
import { test } from "node:test";
import { setupTokenFromLog } from "./restow.mjs";

test("setupTokenFromLog takes the token the api printed last", () => {
  const log = [
    "api-1  | restow: applying database migrations",
    "api-1  | ================================================================",
    "api-1  |     SETUP TOKEN: K7PQX-3MZRA-T9WHE-2BNCV",
    "api-1  | restow: starting role 'api'",
    "api-1  |     SETUP TOKEN: 7QKMZ-RT4VX-9HBNP-2WCAE",
  ].join("\n");
  assert.equal(setupTokenFromLog(log), "7QKMZ-RT4VX-9HBNP-2WCAE");
});

test("setupTokenFromLog is null without a token line", () => {
  assert.equal(setupTokenFromLog("api-1  | Restow API (production) listening"), null);
  assert.equal(setupTokenFromLog("use the value of RESTOW_SETUP_TOKEN"), null);
});
