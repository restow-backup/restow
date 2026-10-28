// `source.app_secret_expiring` against a real Postgres:
//
//   - a source's own app secret is reminded of 30 days before, 7 days before and once it has
//     expired, each once (a repeated pass is silent), through the bell and a rule with a day's
//     throttle (the stage is part of the subject key, so the closer reminder is not swallowed);
//   - the expired reminder is an error, the others warnings;
//   - a new date starts over; a certificate's `notAfter` counts like a secret's date;
//   - sources without a date, disabled sources and suspended tenants are left alone;
//   - the mark is written with `jsonb_set`: config keys the API wrote meanwhile survive.
//
// Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database named
// `restow_worker_source_app_expiry_test` is recreated there); skipped otherwise.

import { createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EndpointJobDeps } from "./endpoints/common.js";
import { alertSourceAppSecrets } from "./source-app-expiry.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_source_app_expiry_test";
const DAY = 86_400_000;
const EXPIRES = "2026-12-01T00:00:00.000Z";
const at = (daysBefore: number, expires = EXPIRES) =>
  new Date(Date.parse(expires) - daysBefore * DAY);

describe.skipIf(!adminUrl)("source.app_secret_expiring against Postgres", () => {
  let db: ReturnType<typeof createDb>;
  let deps: EndpointJobDeps;
  let contoso: string;
  let secretSource: string;
  let certificateSource: string;
  let rule: string;

  const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    db.$client.query<T>(text, values).then((result) => result.rows);

  const ownApp = (extra: Record<string, unknown>) =>
    JSON.stringify({
      ownApp: {
        clientId: "11111111-2222-4333-8444-555555555555",
        credentialKind: "secret",
        authorityHost: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        updatedBy: "admin@contoso.example",
        ...extra,
      },
    });

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    deps = { db, providerDb: db, runtime: {} as never };

    const [provider] = await q<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const created = await q<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug, status) VALUES ($1, 'Contoso', 'contoso', 'active'), ($1, 'Fabrikam', 'fabrikam', 'suspended') RETURNING id",
      [provider?.id],
    );
    contoso = created[0]?.id ?? "";
    const fabrikam = created[1]?.id ?? "";

    const source = async (tenantId: string, name: string, config: string, status = "active") => {
      const [row] = await q<{ id: string }>(
        "INSERT INTO sources (tenant_id, kind, name, status, config) VALUES ($1, 'm365', $2, $3, $4::jsonb) RETURNING id",
        [tenantId, name, status, config],
      );
      return row?.id ?? "";
    };
    secretSource = await source(contoso, "Contoso 365", ownApp({ secretExpiresAt: EXPIRES }));
    // Its certificate ends a month later than the secret above.
    certificateSource = await source(
      contoso,
      "Contoso Archive",
      ownApp({ credentialKind: "certificate", certificateNotAfter: "2027-01-01T12:00:00.000Z" }),
    );
    // No date noted, the consent mode, a disabled source and a suspended tenant: never reminded.
    await source(contoso, "No date", ownApp({ secretExpiresAt: null }));
    await source(contoso, "Consent", JSON.stringify({}));
    await source(contoso, "Disabled", ownApp({ secretExpiresAt: EXPIRES }), "disabled");
    await source(fabrikam, "Fabrikam 365", ownApp({ secretExpiresAt: EXPIRES }));

    const [row] = await q<{ id: string }>(
      `INSERT INTO report_rules (tenant_id, name, trigger, events, throttle_minutes, email_recipients)
       VALUES ($1, 'Credentials', 'event', ARRAY['source.app_secret_expiring'], 1440, ARRAY['ops@contoso.example'])
       RETURNING id`,
      [contoso],
    );
    rule = row?.id ?? "";
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropTestDatabase(adminUrl as string, TEST_DB);
  });

  const deliveries = () =>
    q<{ subject_key: string; payload: { details: Record<string, unknown> } }>(
      "SELECT subject_key, payload FROM report_deliveries WHERE rule_id = $1 ORDER BY created_at, subject_key",
      [rule],
    );
  const bell = (sourceId: string) =>
    q<{ tenant_id: string; level: string; message: string; details: Record<string, unknown> }>(
      "SELECT tenant_id, level, message, details FROM notifications WHERE event = 'source.app_secret_expiring' AND details->>'sourceId' = $1 ORDER BY created_at",
      [sourceId],
    );
  const configOf = async (sourceId: string) =>
    (
      await q<{ config: Record<string, Record<string, unknown>> }>(
        "SELECT config FROM sources WHERE id = $1",
        [sourceId],
      )
    )[0]?.config;

  it("stays silent while the end is further than 30 days away", async () => {
    expect(await alertSourceAppSecrets(deps, at(40))).toBe(0);
    expect(await q("SELECT 1 FROM notifications")).toHaveLength(0);
  });

  it("reminds 30 days before, once, and keeps the API's config keys", async () => {
    expect(await alertSourceAppSecrets(deps, at(30))).toBe(1);
    const [first] = await bell(secretSource);
    expect(first).toMatchObject({
      tenant_id: contoso,
      level: "warning",
      details: {
        sourceId: secretSource,
        objectName: "Contoso 365",
        clientId: "11111111-2222-4333-8444-555555555555",
        credentialKind: "secret",
        expiresAt: EXPIRES,
        days: 30,
        stage: "soon30",
      },
    });
    expect(first?.message).toContain("expires on 2026-12-01 (in 30 days)");
    expect((await deliveries()).map((row) => row.subject_key)).toEqual([
      `source_app:${secretSource}:${EXPIRES}:soon30`,
    ]);
    const config = await configOf(secretSource);
    expect(config?.ownApp?.expiryAlert).toEqual({
      expiresAt: EXPIRES,
      stage: "soon30",
      at: at(30).toISOString(),
    });
    expect(config?.ownApp?.clientId).toBe("11111111-2222-4333-8444-555555555555");

    // The API writes another key meanwhile; the next passes are silent and keep it.
    await q(
      `UPDATE sources SET config = config || '{"lastVerification":{"ok":true}}'::jsonb WHERE id = $1`,
      [secretSource],
    );
    expect(await alertSourceAppSecrets(deps, at(29))).toBe(0);
    expect(await alertSourceAppSecrets(deps, at(8))).toBe(0);
    expect((await configOf(secretSource))?.lastVerification).toEqual({ ok: true });
    expect(await bell(secretSource)).toHaveLength(1);
  });

  it("reminds again 7 days before and once it has expired, the last time as an error", async () => {
    expect(await alertSourceAppSecrets(deps, at(7))).toBe(1);
    expect(await alertSourceAppSecrets(deps, at(3))).toBe(0);
    expect(await alertSourceAppSecrets(deps, at(0))).toBe(1);
    // Five days later only the certificate (ends 2027-01-01 12:00) has entered its 30 days.
    expect(await alertSourceAppSecrets(deps, at(-5))).toBe(1);
    const raised = await bell(secretSource);
    expect(raised.map((row) => [row.details.stage, row.level])).toEqual([
      ["soon30", "warning"],
      ["soon7", "warning"],
      ["expired", "error"],
    ]);
    expect(raised[2]?.message).toContain("expired on 2026-12-01");
    // Each stage reached the rule despite its day's throttle: the stage is in the subject.
    expect((await deliveries()).map((row) => row.subject_key)).toEqual([
      `source_app:${secretSource}:${EXPIRES}:soon30`,
      `source_app:${secretSource}:${EXPIRES}:soon7`,
      `source_app:${secretSource}:${EXPIRES}:expired`,
      `source_app:${certificateSource}:2027-01-01T12:00:00.000Z:soon30`,
    ]);
    // The certificate, by its `notAfter`.
    const certificate = await bell(certificateSource);
    expect(certificate.map((row) => row.details.stage)).toEqual(["soon30"]);
    expect(certificate[0]?.details).toMatchObject({
      credentialKind: "certificate",
      expiresAt: "2027-01-01T12:00:00.000Z",
    });
    expect(certificate[0]?.message).toContain("The certificate of the Microsoft 365 app");
    // Nothing for the sources without a date, the disabled one or the suspended tenant.
    expect(
      await q(
        "SELECT 1 FROM notifications WHERE details->>'sourceId' NOT IN ($1, $2) OR tenant_id <> $3",
        [secretSource, certificateSource, contoso],
      ),
    ).toHaveLength(0);
  });

  it("starts over with a new date and names only the stage it is in", async () => {
    const renewed = "2027-03-01T00:00:00.000Z";
    // The certificate's source is disabled meanwhile: its expiry is no longer told.
    await q("UPDATE sources SET status = 'disabled' WHERE id = $1", [certificateSource]);
    // A rotation that keeps the stale mark (the API drops it; the date alone must be enough).
    await q(
      `UPDATE sources SET config = jsonb_set(config, '{ownApp,secretExpiresAt}', to_jsonb($2::text)) WHERE id = $1`,
      [secretSource, renewed],
    );
    expect(await alertSourceAppSecrets(deps, at(40, renewed))).toBe(0);
    // First seen 5 days before the end: only the 7-day reminder, no catch-up of the 30 days.
    const late = at(5, renewed);
    expect(await alertSourceAppSecrets(deps, late)).toBe(1);
    const raised = await bell(secretSource);
    expect(raised.at(-1)?.details).toMatchObject({ expiresAt: renewed, stage: "soon7", days: 5 });
    expect((await configOf(secretSource))?.ownApp?.expiryAlert).toEqual({
      expiresAt: renewed,
      stage: "soon7",
      at: late.toISOString(),
    });
    expect((await deliveries()).at(-1)?.subject_key).toBe(
      `source_app:${secretSource}:${renewed}:soon7`,
    );
  });

  it("limits candidates only: far dates and finished reminders do not crowd out a due one", async () => {
    const renewed = "2027-03-01T00:00:00.000Z";
    const insert = (name: string, config: string) =>
      q(
        "INSERT INTO sources (tenant_id, kind, name, status, config) VALUES ($1, 'm365', $2, 'active', $3::jsonb)",
        [contoso, name, config],
      );
    for (const n of [1, 2, 3]) {
      await insert(`A far ${n}`, ownApp({ secretExpiresAt: "2028-01-01T00:00:00.000Z" }));
      await insert(
        `A done ${n}`,
        ownApp({
          secretExpiresAt: "2026-06-01T00:00:00.000Z",
          expiryAlert: {
            expiresAt: "2026-06-01T00:00:00.000Z",
            stage: "expired",
            at: "2026-06-01T00:05:00.000Z",
          },
        }),
      );
    }
    // Lay the table out by name, so an unordered scan reads the six above before the due one
    // ("Contoso 365"): without the SQL window and the order, the limit cuts it off.
    await q("CREATE INDEX sources_by_name_test ON sources (name)");
    await q("CLUSTER sources USING sources_by_name_test");
    await q("DROP INDEX sources_by_name_test");
    const before = (await q("SELECT 1 FROM notifications")).length;
    expect(await alertSourceAppSecrets(deps, at(-1, renewed), { limit: 6 })).toBe(1);
    expect((await bell(secretSource)).at(-1)?.details).toMatchObject({
      expiresAt: renewed,
      stage: "expired",
    });
    expect(await q("SELECT 1 FROM notifications")).toHaveLength(before + 1);
  });
});
