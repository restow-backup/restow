import i18next, { type i18n } from "i18next";

import { normalizeProductName, productName } from "./branding.js";
import { PortableIcu } from "./icu.js";

import accountsDe from "../resources/de/accounts.json" with { type: "json" };
import archiveDe from "../resources/de/archive.json" with { type: "json" };
import auditDe from "../resources/de/audit.json" with { type: "json" };
import authDe from "../resources/de/auth.json" with { type: "json" };
import backupDe from "../resources/de/backup.json" with { type: "json" };
import backupjobsDe from "../resources/de/backupjobs.json" with { type: "json" };
import commonDe from "../resources/de/common.json" with { type: "json" };
import dashboardDe from "../resources/de/dashboard.json" with { type: "json" };
import directoryDe from "../resources/de/directory.json" with { type: "json" };
import endpointsDe from "../resources/de/endpoints.json" with { type: "json" };
import exportsDe from "../resources/de/exports.json" with { type: "json" };
import failuresDe from "../resources/de/failures.json" with { type: "json" };
import filesharesDe from "../resources/de/fileshares.json" with { type: "json" };
import historyDe from "../resources/de/history.json" with { type: "json" };
import importsDe from "../resources/de/imports.json" with { type: "json" };
import installationDe from "../resources/de/installation.json" with { type: "json" };
import integrationsDe from "../resources/de/integrations.json" with { type: "json" };
import notificationsDe from "../resources/de/notifications.json" with { type: "json" };
import pveDe from "../resources/de/pve.json" with { type: "json" };
import reportsDe from "../resources/de/reports.json" with { type: "json" };
import restoreDe from "../resources/de/restore.json" with { type: "json" };
import retentionDe from "../resources/de/retention.json" with { type: "json" };
import schedulesDe from "../resources/de/schedules.json" with { type: "json" };
import settingsDe from "../resources/de/settings.json" with { type: "json" };
import setupDe from "../resources/de/setup.json" with { type: "json" };
import sourcesDe from "../resources/de/sources.json" with { type: "json" };
import statsDe from "../resources/de/stats.json" with { type: "json" };
import storageDe from "../resources/de/storage.json" with { type: "json" };
import teamDe from "../resources/de/team.json" with { type: "json" };
import tenantpageDe from "../resources/de/tenantpage.json" with { type: "json" };
import tenantsDe from "../resources/de/tenants.json" with { type: "json" };
import uiDe from "../resources/de/ui.json" with { type: "json" };
import updatesDe from "../resources/de/updates.json" with { type: "json" };
import verifyDe from "../resources/de/verify.json" with { type: "json" };
import warningsDe from "../resources/de/warnings.json" with { type: "json" };

import accountsEn from "../resources/en/accounts.json" with { type: "json" };
import archiveEn from "../resources/en/archive.json" with { type: "json" };
import auditEn from "../resources/en/audit.json" with { type: "json" };
import authEn from "../resources/en/auth.json" with { type: "json" };
import backupEn from "../resources/en/backup.json" with { type: "json" };
import backupjobsEn from "../resources/en/backupjobs.json" with { type: "json" };
import commonEn from "../resources/en/common.json" with { type: "json" };
import dashboardEn from "../resources/en/dashboard.json" with { type: "json" };
import directoryEn from "../resources/en/directory.json" with { type: "json" };
import endpointsEn from "../resources/en/endpoints.json" with { type: "json" };
import exportsEn from "../resources/en/exports.json" with { type: "json" };
import failuresEn from "../resources/en/failures.json" with { type: "json" };
import filesharesEn from "../resources/en/fileshares.json" with { type: "json" };
import historyEn from "../resources/en/history.json" with { type: "json" };
import importsEn from "../resources/en/imports.json" with { type: "json" };
import installationEn from "../resources/en/installation.json" with { type: "json" };
import integrationsEn from "../resources/en/integrations.json" with { type: "json" };
import notificationsEn from "../resources/en/notifications.json" with { type: "json" };
import pveEn from "../resources/en/pve.json" with { type: "json" };
import reportsEn from "../resources/en/reports.json" with { type: "json" };
import restoreEn from "../resources/en/restore.json" with { type: "json" };
import retentionEn from "../resources/en/retention.json" with { type: "json" };
import schedulesEn from "../resources/en/schedules.json" with { type: "json" };
import settingsEn from "../resources/en/settings.json" with { type: "json" };
import setupEn from "../resources/en/setup.json" with { type: "json" };
import sourcesEn from "../resources/en/sources.json" with { type: "json" };
import statsEn from "../resources/en/stats.json" with { type: "json" };
import storageEn from "../resources/en/storage.json" with { type: "json" };
import teamEn from "../resources/en/team.json" with { type: "json" };
import tenantpageEn from "../resources/en/tenantpage.json" with { type: "json" };
import tenantsEn from "../resources/en/tenants.json" with { type: "json" };
import uiEn from "../resources/en/ui.json" with { type: "json" };
import updatesEn from "../resources/en/updates.json" with { type: "json" };
import verifyEn from "../resources/en/verify.json" with { type: "json" };
import warningsEn from "../resources/en/warnings.json" with { type: "json" };

/**
 * Translation namespaces. Each maps to one JSON file per language under
 * `resources/<lng>/<ns>.json`. Keys are "speaking" and dotted, e.g.
 * `auth:login.passkey` or `setup:mail.transport.smtp`.
 *
 * The shell namespaces come first (common, ui for the shared component kit,
 * auth, setup, dashboard), then one namespace per feature in navigation order,
 * then the server-rendered output: `notifications` for the mails the server
 * sends and `reports` for the PDF reports.
 */
export const namespaces = [
  "common",
  "ui",
  "auth",
  "setup",
  "dashboard",
  "stats",
  "tenants",
  "team",
  "accounts",
  "sources",
  "directory",
  "backup",
  "backupjobs",
  "history",
  "warnings",
  "failures",
  "schedules",
  "restore",
  "verify",
  "retention",
  "endpoints",
  "pve",
  "fileshares",
  "imports",
  "exports",
  "storage",
  "archive",
  "audit",
  "integrations",
  "settings",
  "installation",
  "tenantpage",
  "updates",
  "notifications",
  "reports",
] as const;

export type Namespace = (typeof namespaces)[number];

/** Default namespace resolved when a key is used without a namespace prefix. */
export const defaultNamespace = "common" satisfies Namespace;

/** Languages shipped from day one. */
export const supportedLanguages = ["de", "en"] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number];

/** German is the working default; English is the fallback for missing keys. */
export const defaultLanguage = "de" satisfies SupportedLanguage;
export const fallbackLanguage = "en" satisfies SupportedLanguage;

/**
 * All translation resources, grouped by language and namespace. Both languages
 * carry an identical key set (enforced by `src/keys.test.ts`).
 */
export const resources = {
  de: {
    common: commonDe,
    ui: uiDe,
    auth: authDe,
    setup: setupDe,
    dashboard: dashboardDe,
    stats: statsDe,
    tenants: tenantsDe,
    team: teamDe,
    accounts: accountsDe,
    sources: sourcesDe,
    directory: directoryDe,
    backup: backupDe,
    backupjobs: backupjobsDe,
    history: historyDe,
    warnings: warningsDe,
    failures: failuresDe,
    schedules: schedulesDe,
    restore: restoreDe,
    verify: verifyDe,
    retention: retentionDe,
    endpoints: endpointsDe,
    pve: pveDe,
    fileshares: filesharesDe,
    imports: importsDe,
    exports: exportsDe,
    storage: storageDe,
    archive: archiveDe,
    audit: auditDe,
    integrations: integrationsDe,
    settings: settingsDe,
    installation: installationDe,
    tenantpage: tenantpageDe,
    updates: updatesDe,
    notifications: notificationsDe,
    reports: reportsDe,
  },
  en: {
    common: commonEn,
    ui: uiEn,
    auth: authEn,
    setup: setupEn,
    dashboard: dashboardEn,
    stats: statsEn,
    tenants: tenantsEn,
    team: teamEn,
    accounts: accountsEn,
    sources: sourcesEn,
    directory: directoryEn,
    backup: backupEn,
    backupjobs: backupjobsEn,
    history: historyEn,
    warnings: warningsEn,
    failures: failuresEn,
    schedules: schedulesEn,
    restore: restoreEn,
    verify: verifyEn,
    retention: retentionEn,
    endpoints: endpointsEn,
    pve: pveEn,
    fileshares: filesharesEn,
    imports: importsEn,
    exports: exportsEn,
    storage: storageEn,
    archive: archiveEn,
    audit: auditEn,
    integrations: integrationsEn,
    settings: settingsEn,
    installation: installationEn,
    tenantpage: tenantpageEn,
    updates: updatesEn,
    notifications: notificationsEn,
    reports: reportsEn,
  },
} satisfies Record<SupportedLanguage, Record<Namespace, Record<string, unknown>>>;

/** Precise shape of {@link resources}, derived from the bundled JSON. */
export type Resources = typeof resources;

export interface CreateI18nOptions {
  /** Active language. Defaults to {@link defaultLanguage}. */
  lng?: SupportedLanguage;
  /** Fallback language for missing keys. Defaults to {@link fallbackLanguage}. */
  fallbackLng?: SupportedLanguage;
  /** Enable i18next debug logging. Defaults to `false`. */
  debug?: boolean;
  /**
   * The product name `{appName}` resolves to in every text. Defaults to the
   * name of this process ({@link productName}, set with `configureProductName`).
   */
  appName?: string;
}

/**
 * Build a framework-agnostic i18next instance wired up with the ICU
 * post-processor (plural, select, date/number formatting via
 * `intl-messageformat`) and the bundled {@link resources}.
 *
 * `{appName}` is a default variable of the instance: texts name the product
 * with it and no call site has to pass it (i18next hands the default variables
 * to the ICU formatter together with the call's own values).
 *
 * Resources are provided inline and no async backend is used, so the returned
 * instance initializes synchronously and is ready to translate immediately.
 */
export function createI18n(options: CreateI18nOptions = {}): i18n {
  const instance = i18next.createInstance();

  void instance.use(PortableIcu).init({
    resources,
    lng: options.lng ?? defaultLanguage,
    fallbackLng: options.fallbackLng ?? fallbackLanguage,
    supportedLngs: supportedLanguages,
    ns: namespaces,
    defaultNS: defaultNamespace,
    // React and other consumers escape on render; ICU output is plain text here.
    interpolation: {
      escapeValue: false,
      defaultVariables: { appName: normalizeProductName(options.appName ?? productName()) },
    },
    returnNull: false,
    debug: options.debug ?? false,
  });

  return instance;
}

export { FAILURE_TEXT_PARAMS, failureVariables } from "./failures.js";
export type { FailureTextParam, FailureTextValue } from "./failures.js";
export {
  DEFAULT_PRODUCT_NAME,
  MAX_PRODUCT_NAME_LENGTH,
  PRODUCT_NAME_ENV,
  applyProductNameToInstance,
  configureProductName,
  normalizeProductName,
  productName,
} from "./branding.js";
