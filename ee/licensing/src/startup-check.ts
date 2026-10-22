import { isKeyedEdition } from "./editions.js";
import {
  endOfUpdatePeriod,
  type ReleaseBuild,
  runningBuildOf,
  type UpdateEntitlement,
  updateEntitlement,
} from "./entitlement.js";
import { RUN_AS_COMMUNITY_ENV, runAsCommunityRequested } from "./store.js";

/**
 * The start check of a release against the installed licence key
 * (docs/LICENSING.md, "Updates"). The api container runs it before it applies
 * the database migrations (Dockerfile `restow-entrypoint`, through
 * ee/api/src/license/startup-check.ts), so a release the installed Business or
 * Service Provider key does not cover never touches the database: the operator
 * goes back to the previous release (the updater does so on its own) and
 * nothing needs to be restored.
 *
 * It can only ever stop a release that carries a release date and a version
 * (development builds never), only with a Business or Service Provider key
 * installed (Community and the demo never), and never for a key without update
 * period on a release of its series (every beta licence on every 0.x and 1.x
 * release). With RESTOW_RUN_AS_COMMUNITY=1 the release starts as Community
 * instead (./store.ts), the data untouched.
 */

/** What the start check reads of the active `license` row. Any column may be missing. */
export interface InstalledKeyRow {
  edition?: unknown;
  series?: unknown;
  updates_until?: unknown;
  licensee?: unknown;
}

export type StartupDecision =
  | { action: "start"; entitlement: UpdateEntitlement }
  | { action: "refuse"; entitlement: UpdateEntitlement; message: string }
  | { action: "community"; entitlement: UpdateEntitlement; message: string };

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** `updates_until` as stored: a date column reads back as `YYYY-MM-DD` (to_jsonb). */
function dateText(value: unknown): string | null {
  const raw = text(value);
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function editionName(edition: string): string {
  return edition === "service_provider" ? "Service Provider" : "Business";
}

function describe(entitlement: UpdateEntitlement, build: ReleaseBuild, edition: string): string {
  const version = build.version ?? "unknown";
  const released =
    build.releasedAt === null ? "" : ` (released ${new Date(build.releasedAt).toISOString()})`;
  const covers =
    entitlement.coveredUntil !== null
      ? `its update period ended on ${entitlement.coveredUntil}: releases made up to ${endOfUpdatePeriod(entitlement.coveredUntil).toISOString()} are covered`
      : `it covers the ${entitlement.series}.x releases`;
  return `Version ${version}${released} is not covered by the installed ${editionName(edition)} licence key; ${covers}.`;
}

/** Decide whether the api of this release may start (pure; the row is the active `license` row). */
export function decideStartup(
  row: InstalledKeyRow | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): StartupDecision {
  const build = runningBuildOf(env);
  if (!row || !isKeyedEdition(row.edition)) {
    return { action: "start", entitlement: updateEntitlement(null, build) };
  }
  const entitlement = updateEntitlement(
    { series: text(row.series), updatesUntil: dateText(row.updates_until) },
    build,
  );
  if (entitlement.entitled) {
    return { action: "start", entitlement };
  }
  const what = describe(entitlement, build, row.edition);
  if (runAsCommunityRequested(env)) {
    return {
      action: "community",
      entitlement,
      message: `${what} ${RUN_AS_COMMUNITY_ENV} is set: starting as Community. The Business and Service Provider modules stay off; no data is changed or deleted. Install a licence key that covers this release to turn them on again.`,
    };
  }
  return {
    action: "refuse",
    entitlement,
    message: `${what} The api does not start and has not touched the database (no migration ran). Either go back to the version you ran before (or any release the key covers) and install a renewed licence key there, or start this version as Community with ${RUN_AS_COMMUNITY_ENV}=1 in .env (the Business and Service Provider modules stay off, no data is changed). See docs/LICENSING.md.`,
  };
}

/** Anything that runs a query (a node-postgres pool or client). */
export interface QueryRunner {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * The active `license` row as JSON, whatever columns the schema has yet (the
 * check runs before the migrations, so a release that adds columns reads the
 * previous release's table); null without a row or without the table (a new
 * installation).
 */
export async function readInstalledKeyRow(db: QueryRunner): Promise<InstalledKeyRow | null> {
  try {
    const { rows } = await db.query(
      "select to_jsonb(l) as row from license l where l.active order by l.created_at desc limit 1",
    );
    const row = rows[0]?.row;
    return row && typeof row === "object" ? (row as InstalledKeyRow) : null;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "42P01") {
      return null;
    }
    throw error;
  }
}
