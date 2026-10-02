/**
 * Release smoke check 3, the browser half: passkey sign-in end to end with a
 * virtual authenticator, creating a tenant through the interface, and every
 * screen in German and English without a missing translation key.
 *
 * Runs inside the Playwright container that scripts/smoke/run.mjs starts (see
 * scripts/smoke/lib/e2e.mjs). Everything comes in through the environment:
 *
 *   BASE_URL         https origin of the stack under test (the passkey origin)
 *   ADMIN_EMAIL, ADMIN_PASSWORD, TOTP_SECRET
 *                    the account the smoke set up; the emergency sign-in
 *                    (password plus authenticator code) is what registers the
 *                    first passkey
 *   TENANT_NAME, TENANT_SLUG
 *                    the tenant the wizard creates
 *   TENANT_WIZARD    "skip" leaves the wizard out (the Community build has its one
 *                    tenant, the own organisation the setup created); default "run"
 *   RESULT_FILE      where the step list is written as JSON
 *   SCREENSHOT_DIR   where failure screenshots go
 *
 * Exit code 0 when every step passed, 1 otherwise. The steps are listed in the
 * result file either way.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { loadTranslations, untranslatedIssue } from "/smoke/lib/i18n-scan.mjs";
import { totp } from "/smoke/lib/totp.mjs";

const env = (name, fallback) => process.env[name] ?? fallback;
const BASE_URL = env("BASE_URL");
const RESULT_FILE = env("RESULT_FILE", "/out/e2e-result.json");
const SCREENSHOT_DIR = env("SCREENSHOT_DIR", "/out");
const I18N_DIR = env("I18N_DIR", "/i18n");
const TENANT_NAME = env("TENANT_NAME", "Smoke E2E Tenant");
const TENANT_SLUG = env("TENANT_SLUG", "smoke-e2e");

const steps = [];
let page;

async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    steps.push({
      name,
      ok: true,
      detail: typeof detail === "string" ? detail : "",
      ms: Date.now() - started,
    });
    console.log(`ok    ${name}${typeof detail === "string" && detail ? `: ${detail}` : ""}`);
    return true;
  } catch (error) {
    const message =
      error instanceof Error ? error.message.split("\n").slice(0, 6).join(" ") : String(error);
    steps.push({ name, ok: false, detail: message, ms: Date.now() - started });
    console.log(`FAIL  ${name}: ${message}`);
    try {
      const file = join(SCREENSHOT_DIR, `e2e-failed-${steps.length}.png`);
      await page.screenshot({ path: file, fullPage: true });
    } catch {
      // No page to photograph.
    }
    return false;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * The leaf texts of the current screen that look like a missing translation
 * (rules in lib/i18n-scan.mjs).
 */
async function untranslatedText(translations) {
  const texts = await page.evaluate(() => {
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      const element = /** @type {HTMLElement} */ (node);
      if (
        ["SCRIPT", "STYLE", "NOSCRIPT"].includes(element.tagName) ||
        element.children.length > 0
      ) {
        continue;
      }
      // Identifiers shown on purpose (the audit log prints the raw action code
      // next to its label) sit in code elements or a monospace font.
      if (element.closest("code, kbd, pre, samp, [class*='font-mono']")) {
        continue;
      }
      const text = (element.textContent ?? "").trim();
      if (text.length > 0 && text.length < 200) {
        found.push(text);
      }
    }
    return found;
  });
  return [...new Set(texts.map((text) => untranslatedIssue(text, translations)).filter(Boolean))];
}

async function signInWithPassword() {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
  await page.locator("input[name=email]").fill(env("ADMIN_EMAIL"));
  await page.locator("input[name=password]").fill(env("ADMIN_PASSWORD"));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .locator("input[autocomplete=one-time-code], input[name=code], input[inputmode=numeric]")
    .first()
    .fill(totp(env("TOTP_SECRET")));
  await page.getByRole("button", { name: "Verify code" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
  await page.waitForLoadState("networkidle");
}

/**
 * Open a page and let it settle. The app keeps an event stream open on some
 * screens, so "networkidle" is not a usable signal there: wait for the shell
 * and a short pause for the data to render instead.
 */
async function visit(path) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded" });
  await page.locator("h1, h2").first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(700);
}

async function apiGet(path) {
  return page.evaluate(async (target) => {
    const response = await fetch(target, { headers: { accept: "application/json" } });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, path);
}

async function setLanguage(language) {
  await page.evaluate((lng) => localStorage.setItem("restow.language", lng), language);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("h1, h2").first().waitFor({ timeout: 15_000 });
  const lang = await page.evaluate(() => document.documentElement.lang);
  assert(lang === language, `the page language is "${lang}", not "${language}"`);
}

const browser = await chromium.launch({ args: ["--ignore-certificate-errors"] });
try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
  });
  page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 200)));

  // The virtual authenticator: a platform authenticator with a resident key
  // that always passes user verification, so no prompt is needed.
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const credentialCount = async () =>
    (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.length;

  await step("the login page is a secure context and offers passkey sign-in", async () => {
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
    assert(await page.evaluate(() => window.isSecureContext), "the page is not a secure context");
    await page.getByRole("button", { name: "Sign in with passkey" }).waitFor({ timeout: 10_000 });
  });

  const signedIn = await step("emergency sign-in: password and authenticator code", async () => {
    await signInWithPassword();
    const me = await apiGet("/api/v1/me");
    assert(me.status === 200, `GET /api/v1/me answered ${me.status}`);
    return `signed in as ${me.body?.user?.email}`;
  });

  let passkeyAdded = false;
  if (signedIn) {
    passkeyAdded = await step("register a passkey with the virtual authenticator", async () => {
      await page.goto(`${BASE_URL}/account`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Add passkey" }).first().click();
      await page.getByRole("dialog").getByRole("button", { name: "Create passkey" }).click();
      await page.getByText("Passkey added.").first().waitFor({ timeout: 15_000 });
      const count = await credentialCount();
      assert(count === 1, `the authenticator holds ${count} credentials, expected 1`);
      return "1 credential on the authenticator";
    });
  }

  if (passkeyAdded) {
    await step("sign out", async () => {
      await page
        .getByRole("button", { name: /account menu|user menu|SA$/iu })
        .last()
        .click();
      await page.getByRole("menuitem", { name: "Sign out" }).click();
      await page.waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 });
      const me = await apiGet("/api/v1/me");
      assert(
        me.status === 401,
        `after sign-out GET /api/v1/me answered ${me.status}, expected 401`,
      );
    });

    await step("sign in with the passkey, no password", async () => {
      await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Sign in with passkey" }).click();
      await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 20_000 });
      await page.waitForLoadState("networkidle");
      const me = await apiGet("/api/v1/me");
      assert(me.status === 200, `GET /api/v1/me answered ${me.status}`);
      assert(me.body?.user?.email === env("ADMIN_EMAIL"), "the session belongs to another account");
      return "session established by the passkey";
    });
  }

  if (passkeyAdded && env("TENANT_WIZARD", "run") !== "skip") {
    await step("create a tenant through the wizard", async () => {
      await page.goto(`${BASE_URL}/tenants`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "New tenant" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.locator("input[name=name]").fill(TENANT_NAME);
      await dialog.locator("input[name=slug]").fill(TENANT_SLUG);
      await dialog.getByRole("button", { name: "Next" }).click();
      // Contact persons: one primary contact is required.
      const contact = dialog.locator("input:not([type=radio]):not([type=checkbox])");
      await contact.nth(0).fill("Smoke Contact");
      await contact.nth(2).fill("it@smoke.test");
      const created = page.getByRole("heading", { name: `${TENANT_NAME} was created` });
      for (let stepNumber = 0; stepNumber < 8 && !(await created.isVisible()); stepNumber += 1) {
        const create = dialog.getByRole("button", { name: "Create tenant" });
        if ((await create.count()) && (await create.isEnabled())) {
          await create.click();
          break;
        }
        const next = dialog.getByRole("button", { name: "Next" });
        if (await next.count()) {
          await next.click();
        }
        await page.waitForTimeout(300);
      }
      await created.waitFor({ timeout: 30_000 });
      const tenants = await apiGet("/api/v1/tenants");
      const list = tenants.body?.items ?? tenants.body ?? [];
      assert(
        list.some((tenant) => tenant.slug === TENANT_SLUG),
        `the tenant ${TENANT_SLUG} is not in the tenant list`,
      );
      return `tenant ${TENANT_SLUG} created`;
    });
  }

  if (signedIn) {
    const translations = loadTranslations(I18N_DIR);
    for (const language of ["en", "de"]) {
      await step(
        `every screen in ${language === "en" ? "English" : "German"} without a missing translation key`,
        async () => {
          await visit("/");
          await setLanguage(language);
          const links = await page
            .locator("aside a[href^='/'], nav a[href^='/']")
            .evaluateAll((anchors) => [...new Set(anchors.map((a) => a.getAttribute("href")))]);
          assert(links.length >= 8, `only ${links.length} navigation links found`);
          const problems = [];
          // Pages without a menu entry of their own: account security (user
          // menu) and the sections of the active tenant's page, which the menu
          // reaches through the one link to the tenant's settings.
          const settings = links.find((href) => /^\/tenants\/[^/]+\/overview$/.test(href ?? ""));
          const tenantPage = settings ? settings.replace(/\/overview$/, "") : null;
          const sections = [
            "connections",
            "protection",
            "jobs",
            "retention",
            "storage",
            "agents",
            "archive",
            "notifications",
            "integrations",
            "members",
            "audit",
            "master-data",
          ];
          const extra = [
            "/account",
            ...(tenantPage
              ? [
                  ...sections.map((section) => `${tenantPage}/${section}`),
                  `${tenantPage}/connections?tab=imap`,
                  `${tenantPage}/connections?tab=google`,
                  `${tenantPage}/connections?tab=imports`,
                ]
              : []),
          ];
          const pages = [...new Set([...links, ...extra])];
          for (const href of pages) {
            await visit(href);
            for (const issue of await untranslatedText(translations)) {
              problems.push(`${href}: ${issue}`);
            }
          }
          assert(problems.length === 0, problems.slice(0, 8).join("; "));
          return `${pages.length} screens`;
        },
      );
    }
    await page.evaluate(() => localStorage.removeItem("restow.language"));
  }

  await step("no uncaught error in the page", async () => {
    assert(pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  });
} finally {
  await browser.close();
  writeFileSync(RESULT_FILE, JSON.stringify({ steps }, null, 2));
}
process.exit(steps.every((entry) => entry.ok) ? 0 : 1);
