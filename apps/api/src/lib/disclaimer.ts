import { type Settings, settings } from "@restow/db";
import { sql } from "drizzle-orm";
import { ProblemError } from "../problem.js";
import { audit } from "./audit.js";
import type { DbExecutor } from "./tenant-context.js";

/**
 * The operator responsibility notice ("disclaimer"): a first-run step that must
 * be accepted before anything else of the installation can be set up, and that
 * an installation which predates it shows once to its provider admin.
 *
 * The text lives in the translation files (packages/i18n/resources/<lng>/setup.json,
 * key `disclaimer`), so the web renders it in the operator's language. What the
 * server owns is the version of that text: {@link DISCLAIMER_VERSION}. Bump it
 * whenever the wording changes in a way an operator must acknowledge; every
 * installation is then asked again (the acceptance of an older version does
 * not count). `disclaimer.test.ts` pins a digest of the text so a change
 * without a bump fails the build.
 *
 * The acceptance is stored in the single `settings` row (version, time, client
 * address) and written to the installation audit chain with the person who
 * accepted. In the setup wizard that person does not exist before the setup
 * completes, so the wizard sends the acceptance with its setup request and
 * routes/setup.ts records it in the setup transaction, with the new
 * administrator as actor; nothing is written for an anonymous caller.
 *
 * Demo mode (RESTOW_DEMO) is treated as accepted: the public demo is a
 * read-only showcase without an operator, and its visitors cannot write.
 */

/** Version of the notice text; bump together with any change of the wording. */
export const DISCLAIMER_VERSION = "2026-10-01";

/** Problem type of a setup request made before the notice was accepted. */
export const DISCLAIMER_REQUIRED_PROBLEM = "urn:restow:problem:disclaimer-required";
/** Problem type of an acceptance for a version other than the current one. */
export const DISCLAIMER_VERSION_PROBLEM = "urn:restow:problem:disclaimer-version-mismatch";

export const DISCLAIMER_AUDIT_ACTIONS = {
  accepted: "settings.disclaimer_accepted",
} as const;

type AcceptanceColumns = Pick<
  Settings,
  "disclaimerVersion" | "disclaimerAcceptedAt" | "disclaimerAcceptedIp"
>;

/** What the public setup state says about the notice. */
export interface DisclaimerState {
  /** The current version of the text; the web sends it back when accepting. */
  version: string;
  /** The current version is accepted (or demo mode makes it moot). */
  accepted: boolean;
}

/** What an acceptance answers with. */
export interface DisclaimerAcceptance {
  version: string;
  accepted: true;
  acceptedAt: string;
}

/**
 * Whether the notice is settled for this installation: the stored version is
 * the current one, or demo mode is on. An older version, or none, is not.
 */
export function isDisclaimerAccepted(
  row: Pick<AcceptanceColumns, "disclaimerVersion"> | null,
  demo: { enabled: boolean },
): boolean {
  return demo.enabled || row?.disclaimerVersion === DISCLAIMER_VERSION;
}

export function disclaimerState(
  row: Pick<AcceptanceColumns, "disclaimerVersion"> | null,
  demo: { enabled: boolean },
): DisclaimerState {
  return { version: DISCLAIMER_VERSION, accepted: isDisclaimerAccepted(row, demo) };
}

/** 428: the request needs the notice accepted first. */
export function disclaimerRequired(): ProblemError {
  return new ProblemError(428, "Operator notice not accepted", {
    type: DISCLAIMER_REQUIRED_PROBLEM,
    detail:
      "Read and accept the operator responsibility notice first. Nothing else of the setup can proceed until it is accepted.",
    extensions: { version: DISCLAIMER_VERSION },
  });
}

export function versionMismatch(): ProblemError {
  return new ProblemError(409, "Operator notice changed", {
    type: DISCLAIMER_VERSION_PROBLEM,
    detail:
      "The notice was updated. Reload the page and read the current version before accepting.",
    extensions: { version: DISCLAIMER_VERSION },
  });
}

/** The person accepting; null before an account exists (the first-run wizard). */
export interface DisclaimerActor {
  id: string;
  email: string;
}

export interface AcceptDisclaimerInput {
  /** The version the operator was shown; must be the current one. */
  version: string;
  actor: DisclaimerActor | null;
  ip: string | null;
  /** Where the acceptance happened, for the audit entry. */
  via: "setup" | "sign_in";
  /**
   * Record it even when the current version is already stored. The setup
   * wizard sets this: an installation of 0.1.0 may hold an anonymous
   * acceptance from before its setup, and the one that counts is the new
   * administrator's.
   */
  evenIfStored?: boolean;
}

/**
 * Record the acceptance of the current notice, inside the caller's
 * transaction on the installation pool. Creates the settings row when the
 * wizard has not written it yet. Accepting a version that is already stored
 * changes nothing and writes no second audit entry (a reload, a retry),
 * unless `evenIfStored` is set.
 */
export async function acceptDisclaimer(
  tx: DbExecutor,
  input: AcceptDisclaimerInput,
): Promise<DisclaimerAcceptance> {
  if (input.version !== DISCLAIMER_VERSION) {
    throw versionMismatch();
  }
  const [current] = await tx.select().from(settings).limit(1).for("update");
  if (
    !input.evenIfStored &&
    current?.disclaimerVersion === DISCLAIMER_VERSION &&
    current.disclaimerAcceptedAt
  ) {
    return {
      version: DISCLAIMER_VERSION,
      accepted: true,
      acceptedAt: current.disclaimerAcceptedAt.toISOString(),
    };
  }

  const acceptedAt = new Date();
  const columns = {
    disclaimerVersion: DISCLAIMER_VERSION,
    disclaimerAcceptedAt: acceptedAt,
    disclaimerAcceptedIp: input.ip,
  };
  const [row] = await tx
    .insert(settings)
    .values({ singleton: true, ...columns })
    .onConflictDoUpdate({
      target: settings.singleton,
      set: { ...columns, updatedAt: sql`now()` },
    })
    .returning({ id: settings.id });
  if (!row) {
    throw new Error("settings upsert returned no row");
  }

  await audit(tx, {
    actor: input.actor?.email ?? "system",
    actorUserId: input.actor?.id ?? null,
    action: DISCLAIMER_AUDIT_ACTIONS.accepted,
    target: row.id,
    targetType: "installation",
    ip: input.ip,
    details: {
      version: DISCLAIMER_VERSION,
      previousVersion: current?.disclaimerVersion ?? null,
      via: input.via,
    },
  });

  return { version: DISCLAIMER_VERSION, accepted: true, acceptedAt: acceptedAt.toISOString() };
}
