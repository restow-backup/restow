import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OWN_ORGANISATION,
  installationTenant,
  ownOrganisationOf,
  setupTokenFromLog,
} from "./restow.mjs";

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

test("ownOrganisationOf finds the tenant of kind internal and nothing else", () => {
  const own = { id: "1", slug: "own", kind: "internal" };
  const customer = { id: "2", slug: "customer", kind: "customer" };
  assert.equal(ownOrganisationOf([customer, own]), own);
  assert.equal(ownOrganisationOf([customer]), undefined);
  // A list from a release without the field has no own organisation.
  assert.equal(ownOrganisationOf([{ id: "3", slug: "old" }]), undefined);
});

test("the own organisation's slug is what the api derives from its name", () => {
  assert.equal(
    OWN_ORGANISATION.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, ""),
    OWN_ORGANISATION.slug,
  );
});

test("installationTenant is the own organisation the setup created, as a copy", async () => {
  const items = [
    { id: "2", slug: "customer", kind: "customer" },
    { id: "1", slug: OWN_ORGANISATION.slug, kind: "internal" },
  ];
  const ctx = { api: { get: async () => ({ items }) } };
  const tenant = await installationTenant(ctx);
  assert.equal(tenant.id, "1");
  tenant.note = "a check's own fact";
  assert.equal((await installationTenant(ctx)).note, undefined);
});

test("installationTenant fails when the setup created no own organisation", async () => {
  const ctx = { api: { get: async () => ({ items: [{ id: "9", slug: "old-tenant" }] }) } };
  await assert.rejects(() => installationTenant(ctx), /no own organisation/u);
  await assert.rejects(
    () => installationTenant({ api: { get: async () => ({ items: [] }) } }),
    /none/u,
  );
});
