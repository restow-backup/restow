/**
 * Postgres-backed tests of branding (0.5.0): the edition gates (provider branding from Business,
 * a tenant's own from Service Provider, the product name after a downgrade), the checks of a
 * branding (contrast, allowed senders, From locked for Graph), the logo store and the public image
 * route (headers, unknown tokens, a retired logo still served, the accent band), and that tenants
 * never reach the logos or another tenant's branding.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the database
 * `restow_api_branding_test` is recreated there and dropped after). Without it it is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import {
  auditLog,
  brandingImages,
  createDb,
  type Database,
  providers,
  settings,
  tenantBranding,
  tenants,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { testPng } from "./testing/images.js";

const DATABASE = "restow_api_branding_test";

describe.skipIf(!testDatabaseAdminUrl)("branding against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let contoso: string;
  let fabrikam: string;
  let edition: "community" | "business" | "service_provider" = "business";
  // biome-ignore lint/suspicious/noExplicitAny: imported once the environment is set
  let service: any;
  // biome-ignore lint/suspicious/noExplicitAny: imported once the environment is set
  let context: any;
  let publicApp: Hono;
  const actor = { id: randomUUID(), email: "olivia@msp.example", ip: null };

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    providerDb = createDb(roles.providerUrl);
    const { registerApiExtension } = await import("../../extensions.js");
    const businessFeatures = ["branding.provider", "reports.timed"];
    registerApiExtension({
      name: "test-edition",
      featureGate: {
        isEnabled: async (_db, feature) =>
          edition === "service_provider" ||
          (edition === "business" && businessFeatures.includes(feature)),
      },
    });
    service = await import("./service.js");
    context = await import("../../lib/tenant-context.js");
    const { buildPublicBrandingRoutes } = await import("./public.js");
    const { errorHandler } = await import("../../problem.js");
    publicApp = new Hono();
    publicApp.onError(errorHandler);
    publicApp.route("/public/branding", buildPublicBrandingRoutes({ providerDb }));

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    await owner.insert(settings).values({
      singleton: true,
      operatingMode: "public",
      publicUrl: "https://restow.example",
      mailTransport: "smtp",
      mailConfig: {
        transport: "smtp",
        host: "smtp.example",
        port: 587,
        security: "starttls",
        from: "noreply@restow.example",
        allowedSenders: ["@msp.example"],
      },
    });
    const made = await owner
      .insert(tenants)
      .values([
        { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" },
        { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
      ])
      .returning();
    contoso = made[0]?.id ?? "";
    fabrikam = made[1]?.id ?? "";
  }, 120_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await appDb?.$client.end();
    await providerDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  beforeEach(() => {
    edition = "business";
    service.invalidateBrandCache();
  });

  it("refuses provider branding in Community, with the edition it needs", async () => {
    edition = "community";
    await expect(
      service.putProviderBranding(providerDb, { senderName: "MSP" }, actor),
    ).rejects.toMatchObject({ status: 403 });
    // Reading answers in every edition, so the page can show the lock.
    const view = await service.getProviderBranding(providerDb);
    expect(view.available).toEqual({ provider: false, tenant: false, customerReport: false });
    expect(view.publicUrlHttps).toBe(true);
  });

  it("checks the accent's contrast and the sender against the allowed senders", async () => {
    await expect(
      service.putProviderBranding(providerDb, { accentColor: "#808080" }, actor),
    ).rejects.toMatchObject({
      status: 422,
      extensions: { field: "accentColor", code: "accent-contrast" },
    });
    await expect(
      service.putProviderBranding(providerDb, { fromAddress: "alerts@other.example" }, actor),
    ).rejects.toMatchObject({ status: 422, extensions: { code: "sender-not-allowed" } });
    await expect(
      service.putProviderBranding(providerDb, { replyTo: "not an address" }, actor),
    ).rejects.toMatchObject({ status: 422, extensions: { code: "invalid-email" } });
    const saved = await service.putProviderBranding(
      providerDb,
      {
        senderName: "MSP Backup",
        fromAddress: "Alerts@MSP.example",
        replyTo: "help@msp.example",
        accentColor: "#1D4ED8",
        footerText: "MSP GmbH\r\nMain St 1",
      },
      actor,
    );
    expect(saved).toMatchObject({
      senderName: "MSP Backup",
      fromAddress: "alerts@msp.example",
      accentColor: "#1d4ed8",
      onAccent: "light",
      footerText: "MSP GmbH\nMain St 1",
    });
    const [entry] = await owner
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "branding.updated"));
    // Which fields changed, never their values.
    expect(entry?.details).toMatchObject({ fields: expect.arrayContaining(["senderName"]) });
    expect(JSON.stringify(entry?.details)).not.toContain("MSP Backup");
  });

  it("locks the From address for Microsoft 365", async () => {
    await owner.update(settings).set({
      mailTransport: "graph",
      mailConfig: {
        transport: "graph",
        sender: "alerts@contoso.example",
        tenantId: "contoso.example",
      },
    });
    try {
      const view = await service.getProviderBranding(providerDb);
      expect(view.mail).toMatchObject({ transport: "graph", fromLocked: true });
      await expect(
        service.putProviderBranding(providerDb, { fromAddress: "alerts@msp.example" }, actor),
      ).rejects.toMatchObject({ status: 422, extensions: { code: "from-locked" } });
    } finally {
      await owner.update(settings).set({
        mailTransport: "smtp",
        mailConfig: {
          transport: "smtp",
          host: "smtp.example",
          port: 587,
          security: "starttls",
          from: "noreply@restow.example",
          allowedSenders: ["@msp.example"],
        },
      });
    }
  });

  it("checks the stored From against the mail settings at send time, not only on save", async () => {
    await service.putProviderBranding(
      providerDb,
      { senderName: "MSP Backup", fromAddress: "alerts@msp.example" },
      actor,
    );
    service.invalidateBrandCache();
    expect(service.mailBrandOf(await service.effectiveBrand(providerDb, null)).from).toEqual({
      name: "MSP Backup",
      address: "alerts@msp.example",
    });
    // The owner narrows the allowed senders afterwards: the cached brand keeps its name, the
    // mail goes out from the configured sender.
    await owner.update(settings).set({
      mailConfig: {
        transport: "smtp",
        host: "smtp.example",
        port: 587,
        security: "starttls",
        from: "noreply@restow.example",
        allowedSenders: [],
      },
    });
    try {
      const narrowed = await service.effectiveBrand(providerDb, null);
      expect(narrowed.brand).toMatchObject({ senderName: "MSP Backup", fromAddress: null });
      expect(service.mailBrandOf(narrowed).from).toEqual({ name: "MSP Backup", address: null });
      // The same for a switch to Microsoft 365, which only sends from its mailbox.
      await owner.update(settings).set({
        mailTransport: "graph",
        mailConfig: {
          transport: "graph",
          sender: "alerts@contoso.example",
          tenantId: "contoso.example",
        },
      });
      expect((await service.effectiveBrand(providerDb, null)).brand.fromAddress).toBeNull();
    } finally {
      await owner.update(settings).set({
        mailTransport: "smtp",
        mailConfig: {
          transport: "smtp",
          host: "smtp.example",
          port: 587,
          security: "starttls",
          from: "noreply@restow.example",
          allowedSenders: ["@msp.example"],
        },
      });
    }
    expect((await service.effectiveBrand(providerDb, null)).brand.fromAddress).toBe(
      "alerts@msp.example",
    );
  });

  it("stores a logo without its metadata and serves it by token only", async () => {
    const logo = await service.putProviderLogo(providerDb, testPng(400, 100), "image/png", actor);
    expect(logo).toMatchObject({ contentType: "image/png", width: 400, height: 100 });
    const response = await publicApp.request(logo.url.replace("/api/v1", ""));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    // The wrong extension, an unknown token and anything that is no token answer 404.
    expect(
      (await publicApp.request(logo.url.replace("/api/v1", "").replace(".png", ".jpg"))).status,
    ).toBe(404);
    expect((await publicApp.request(`/public/branding/${"x".repeat(43)}.png`)).status).toBe(404);
    expect((await publicApp.request("/public/branding/../settings.png")).status).toBe(404);

    // A replaced logo keeps answering (mails already sent show it) until it is pruned.
    const next = await service.putProviderLogo(providerDb, testPng(200, 50), "image/png", actor);
    expect(next.url).not.toBe(logo.url);
    expect((await publicApp.request(logo.url.replace("/api/v1", ""))).status).toBe(200);
    const [retired] = await owner
      .select({ retiredAt: brandingImages.retiredAt })
      .from(brandingImages)
      .where(eq(brandingImages.token, logo.url.split("/").pop()?.split(".")[0] ?? ""));
    expect(retired?.retiredAt).not.toBeNull();
    const pruned = await service.pruneRetiredImages(
      providerDb,
      new Date(Date.now() + 31 * 24 * 60 * 60_000),
    );
    expect(pruned).toBe(1);
    expect((await publicApp.request(logo.url.replace("/api/v1", ""))).status).toBe(404);
    expect((await publicApp.request(next.url.replace("/api/v1", ""))).status).toBe(200);
  });

  it("refuses an SVG logo", async () => {
    await expect(
      service.putProviderLogo(
        providerDb,
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        "image/png",
        actor,
      ),
    ).rejects.toMatchObject({ status: 415, extensions: { code: "svg-not-supported" } });
  });

  it("serves the accent band as a valid 1×1 PNG and 404 for anything but six hex digits", async () => {
    const response = await publicApp.request("/public/branding/accent/1d4ed8.png");
    expect(response.status).toBe(200);
    const png = Buffer.from(await response.arrayBuffer());
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    // The IDAT holds one row: filter byte and the three channels.
    const idatAt = png.indexOf("IDAT");
    const length = png.readUInt32BE(idatAt - 4);
    expect([...inflateSync(png.subarray(idatAt + 4, idatAt + 4 + length))]).toEqual([
      0, 0x1d, 0x4e, 0xd8,
    ]);
    expect((await publicApp.request("/public/branding/accent/1D4ED8.png")).status).toBe(404);
    expect((await publicApp.request("/public/branding/accent/1d4ed.png")).status).toBe(404);
  });

  it("applies the effective brand by edition, and the product name after a downgrade", async () => {
    await service.putProviderBranding(providerDb, { senderName: "MSP Backup" }, actor);
    edition = "service_provider";
    await service.putTenantBranding(
      appDb,
      providerDb,
      contoso,
      { senderName: "Contoso IT" },
      actor,
    );
    service.invalidateBrandCache();
    expect((await service.effectiveBrand(providerDb, contoso)).brand.senderName).toBe("Contoso IT");
    expect((await service.effectiveBrand(providerDb, fabrikam)).brand.senderName).toBe(
      "MSP Backup",
    );
    expect((await service.effectiveBrand(providerDb, null)).brand.senderName).toBe("MSP Backup");
    // Business: the tenant's override is ignored, the provider's applies.
    edition = "business";
    service.invalidateBrandCache();
    expect((await service.effectiveBrand(providerDb, contoso)).brand).toMatchObject({
      senderName: "MSP Backup",
      source: "provider",
    });
    await expect(
      service.putTenantBranding(appDb, providerDb, contoso, { senderName: "X" }, actor),
    ).rejects.toMatchObject({ status: 403 });
    // Community: the product name, whatever is stored.
    edition = "community";
    service.invalidateBrandCache();
    const community = (await service.effectiveBrand(providerDb, contoso)).brand;
    expect(community.branded).toBe(false);
    expect(community.logo).toBeNull();
  });

  it("keeps the logos and the other tenants' branding from a tenant session", async () => {
    edition = "service_provider";
    await service.putTenantBranding(
      appDb,
      providerDb,
      fabrikam,
      { senderName: "Fabrikam IT" },
      actor,
    );
    const seen = await context.withTenantTx(appDb, contoso, (tx: Database) =>
      tx.select().from(tenantBranding),
    );
    expect(seen.every((row: { tenantId: string }) => row.tenantId === contoso)).toBe(true);
    await expect(
      context.withTenantTx(appDb, contoso, (tx: Database) => tx.select().from(brandingImages)),
    ).rejects.toThrow();
    // Inheriting again removes the override.
    const view = await service.putTenantBranding(
      appDb,
      providerDb,
      fabrikam,
      { inherit: true },
      actor,
    );
    expect(view).toMatchObject({ inherits: true, override: null });
  });
});
