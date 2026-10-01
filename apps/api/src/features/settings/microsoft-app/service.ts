import {
  type AppTestResult,
  ENTRA_APP_SECRET_KIND,
  ENTRA_APP_TEST_SECRET_KIND,
  type EntraAppDocument,
  type EntraAppResolution,
  environmentConfiguresEntraApp,
  environmentPartiallyConfigured,
  parseEntraAppDocument,
  serializeEntraAppDocument,
  testAppRegistration,
} from "@restow/core";
import { sql } from "drizzle-orm";
import { config } from "../../../config.js";
import { audit } from "../../../lib/audit.js";
import {
  type SecretRef,
  deleteProviderSecrets,
  findProviderSecret,
  readSecret,
  replaceSecret,
  storeSecret,
  upsertProviderSecret,
} from "../../../lib/secrets.js";
import type { DbExecutor } from "../../../lib/tenant-context.js";
import { ProblemError } from "../../../problem.js";
import { entraEnvironmentOf, invalidateEntraApp, resolveEntraApp } from "../../sources/entra.js";
import { resolvePublicOrigin } from "../../sources/service.js";
import { validationProblem } from "../logic.js";
import type { Actor, RequestContext } from "../service.js";
import { type MicrosoftAppView, planMicrosoftAppSave, toMicrosoftAppView } from "./logic.js";
import type { SaveMicrosoftAppInput, TestMicrosoftAppInput } from "./schemas.js";

/**
 * The Microsoft 365 app registration of the installation (docs/ENTRA-SETUP.md,
 * part 1 to 3), entered by a provider admin instead of the server environment.
 *
 * The registration is one JSON document sealed in the secret store
 * (installation level, kind `entra_app`); the last connection test is sealed
 * next to it (kind `entra_app_test`). ENTRA_CLIENT_* in the environment take
 * precedence: then the registration is shown read-only and saving is refused.
 * Every save, removal and test is audited on the installation chain with what
 * changed, never with the secret or the private key. After a change this
 * process forgets its cached registration; the worker follows within the
 * resolver's TTL (@restow/core entra/app-registration.ts).
 */

export const MICROSOFT_APP_AUDIT_ACTIONS = {
  saved: "settings.microsoft_app.saved",
  removed: "settings.microsoft_app.removed",
  tested: "settings.microsoft_app.tested",
} as const;

/** Serializes concurrent saves of the single registration (transaction-scoped). */
const LOCK_KEY = "restow.settings.microsoft_app";

function managedByEnvironment(): ProblemError {
  return new ProblemError(409, "Managed by the server environment", {
    type: "urn:restow:problem:microsoft-app-managed-by-environment",
    detail:
      "The Microsoft 365 app registration is set in the server environment (ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET or ENTRA_CLIENT_CERT_PATH). Change it there, or remove those variables to manage it here.",
  });
}

function notConfigured(): ProblemError {
  return new ProblemError(409, "No app registration", {
    type: "urn:restow:problem:microsoft-app-not-configured",
    detail: "Save the Microsoft 365 app registration before testing it.",
  });
}

function environmentManaged(): boolean {
  return environmentConfiguresEntraApp(entraEnvironmentOf(config));
}

async function lock(tx: DbExecutor): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`);
}

/** The saved document, or null when there is none or it cannot be opened any more. */
async function openDocument(
  db: DbExecutor,
  ref: SecretRef | null,
): Promise<EntraAppDocument | null> {
  if (!ref) {
    return null;
  }
  try {
    const plaintext = await readSecret(db, ref);
    return plaintext === null ? null : parseEntraAppDocument(plaintext);
  } catch {
    return null;
  }
}

interface StoredTest {
  fingerprint: string;
  result: AppTestResult;
}

/** The last test, when it was run against the registration in use right now. */
async function lastTestFor(
  db: DbExecutor,
  resolution: EntraAppResolution,
): Promise<AppTestResult | null> {
  if (resolution.status !== "ready") {
    return null;
  }
  const ref = await findProviderSecret(db, ENTRA_APP_TEST_SECRET_KIND);
  if (!ref) {
    return null;
  }
  try {
    const stored = JSON.parse((await readSecret(db, ref)) ?? "null") as StoredTest | null;
    return stored?.fingerprint === resolution.app.fingerprint ? stored.result : null;
  } catch {
    return null;
  }
}

// --- Read -------------------------------------------------------------------------------

export async function getMicrosoftApp(
  db: DbExecutor,
  context: RequestContext,
): Promise<MicrosoftAppView> {
  const resolution = await resolveEntraApp();
  return toMicrosoftAppView({
    resolution,
    publicOrigin: await resolvePublicOrigin(db, context.observedOrigin),
    ssoConfigured: Boolean(config.entra.ssoClientId && config.entra.ssoClientSecret),
    environmentPartial: environmentPartiallyConfigured(entraEnvironmentOf(config)),
    lastTest: await lastTestFor(db, resolution),
  });
}

// --- Save -------------------------------------------------------------------------------

/**
 * Save the registration. Without a new secret or certificate the stored one is
 * kept (same app and authority only). A save that changes nothing writes nothing.
 */
export async function saveMicrosoftApp(
  db: DbExecutor,
  input: SaveMicrosoftAppInput,
  actor: Actor,
  context: RequestContext,
  now: () => Date = () => new Date(),
): Promise<MicrosoftAppView> {
  if (environmentManaged()) {
    throw managedByEnvironment();
  }
  await db.transaction(async (tx) => {
    await lock(tx);
    const ref = await findProviderSecret(tx, ENTRA_APP_SECRET_KIND);
    const current = await openDocument(tx, ref);
    const plan = planMicrosoftAppSave(current, input, actor.email, now());
    if (current && plan.changes.length === 0) {
      return;
    }
    const plaintext = serializeEntraAppDocument(plan.document);
    if (ref) {
      await replaceSecret(tx, ref, plaintext);
    } else {
      await storeSecret(tx, { kind: ENTRA_APP_SECRET_KIND, plaintext });
    }
    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: MICROSOFT_APP_AUDIT_ACTIONS.saved,
      target: plan.document.clientId,
      targetType: "app_registration",
      ip: actor.ip,
      details: {
        created: current === null,
        changes: plan.changes,
        clientId: plan.document.clientId,
        credentialKind: plan.document.credentialKind,
        credentialChanged: plan.credentialChanged,
        certificateThumbprint: plan.certificate?.thumbprint ?? null,
        secretExpiresAt: plan.document.secretExpiresAt,
        homeTenantId: plan.document.homeTenantId,
        authorityHost: plan.document.authorityHost,
      },
    });
  });
  invalidateEntraApp();
  return getMicrosoftApp(db, context);
}

// --- Remove -----------------------------------------------------------------------------

/** Remove the saved registration and its last test (the environment's cannot be removed here). */
export async function removeMicrosoftApp(
  db: DbExecutor,
  actor: Actor,
  context: RequestContext,
): Promise<MicrosoftAppView> {
  if (environmentManaged()) {
    throw managedByEnvironment();
  }
  await db.transaction(async (tx) => {
    await lock(tx);
    const ref = await findProviderSecret(tx, ENTRA_APP_SECRET_KIND);
    if (!ref) {
      return;
    }
    const current = await openDocument(tx, ref);
    await deleteProviderSecrets(tx, ENTRA_APP_SECRET_KIND);
    await deleteProviderSecrets(tx, ENTRA_APP_TEST_SECRET_KIND);
    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: MICROSOFT_APP_AUDIT_ACTIONS.removed,
      target: current?.clientId ?? null,
      targetType: "app_registration",
      ip: actor.ip,
      details: {
        clientId: current?.clientId ?? null,
        credentialKind: current?.credentialKind ?? null,
      },
    });
  });
  invalidateEntraApp();
  return getMicrosoftApp(db, context);
}

// --- Test -------------------------------------------------------------------------------

export interface MicrosoftAppTestOptions {
  /** The token endpoint's fetch (tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Acquire a Graph token in the app's own directory and compare its roles with
 * the required application permissions. Failures are a result, not an error:
 * the admin needs to see why. The result is kept for the settings page.
 */
export async function testMicrosoftApp(
  db: DbExecutor,
  input: TestMicrosoftAppInput,
  actor: Actor,
  options: MicrosoftAppTestOptions = {},
): Promise<AppTestResult> {
  const resolution = await resolveEntraApp();
  if (resolution.status !== "ready") {
    throw notConfigured();
  }
  const app = resolution.app;
  const tenantId = input.tenantId ?? app.homeTenantId;
  if (!tenantId) {
    throw validationProblem([{ path: ["tenantId"], message: "required" }]);
  }

  const result = await testAppRegistration({ app, tenantId, fetchImpl: options.fetchImpl });
  const stored: StoredTest = { fingerprint: app.fingerprint, result };
  await db.transaction(async (tx) => {
    await upsertProviderSecret(tx, ENTRA_APP_TEST_SECRET_KIND, JSON.stringify(stored));
    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: MICROSOFT_APP_AUDIT_ACTIONS.tested,
      target: result.clientId,
      targetType: "app_registration",
      ip: actor.ip,
      details: {
        ok: result.ok,
        reason: result.reason,
        aadsts: result.aadsts,
        tenantId: result.tenantId,
        source: result.source,
        credentialKind: result.credentialKind,
        missing: result.permissions?.missing ?? [],
        readOnlyInstead: result.permissions?.readOnlyInstead ?? [],
        unexpected: result.permissions?.unexpected ?? [],
      },
    });
  });
  return result;
}
