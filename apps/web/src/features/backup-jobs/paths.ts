import type { LinkProps } from "@tanstack/react-router";

import { JOB_KINDS, type JobKind } from "./api.js";

/**
 * Addresses of the backup jobs (the job definitions, release 0.2.0). Feature
 * routes are registered at runtime, so the static route typing cannot know
 * them (same approach as the other features).
 *
 *   /jobs?type=mail|endpoint              the jobs of one kind (menu: Jobs under Mail & SaaS and
 *                                         under Servers & endpoints). Without a valid type the
 *                                         address is the old one of the run list and leads to History.
 *   /jobs?type=…&new=1[&select=a,b,c]     the same list with the job editor open on a new job. `select`
 *                                         is a comma separated list of ids of objects or machines the
 *                                         new job starts with. This is the hook for "New job from
 *                                         selection" in the context menus of the inventory and of the
 *                                         protected objects.
 *   /jobs/definitions/<id>?type=…&tab=…   one job. `type` keeps the right menu entry active (the page
 *                                         adds it once the job is loaded when the address came without
 *                                         one); `tab` is overview (default), scope, settings or runs.
 *   /jobs/<run id>                        the old address of one run: leads to /history/<run id>
 *                                         (features/redirects).
 */
export const JOBS_PATH = "/jobs";
export const JOB_DEFINITIONS_PATH = "/jobs/definitions";
export const JOB_DEFINITION_PATTERN = `${JOB_DEFINITIONS_PATH}/$jobId`;

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === "string" && (JOB_KINDS as readonly string[]).includes(value);
}

export const JOB_TABS = ["overview", "scope", "settings", "runs"] as const;
export type JobTab = (typeof JOB_TABS)[number];

export function parseJobTab(value: unknown): JobTab {
  return (JOB_TABS as readonly unknown[]).includes(value) ? (value as JobTab) : "overview";
}

/** The most ids one address may preselect: the API takes 5000 members; an address stays short. */
export const MAX_SELECTED_IDS = 500;

const ID_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

/** `a,b,c` (or a list) as distinct, plausible ids; anything else is dropped. */
export function parseSelectedIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)];
  const ids = raw
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter((part) => ID_TOKEN.test(part));
  return [...new Set(ids)].slice(0, MAX_SELECTED_IDS);
}

function isTruthy(value: unknown): boolean {
  return value === 1 || value === "1" || value === true || value === "true";
}

export interface JobsListSearch {
  /** The kind of job; null when the address names none (or an unknown one). */
  type: JobKind | null;
  /** The editor is open on a new job. */
  create: boolean;
  /** Objects or machines the new job starts with. */
  select: string[];
}

/** Reads `?type=`, `?new=` and `?select=` of the list address. */
export function parseJobsSearch(search: Record<string, unknown>): JobsListSearch {
  return {
    type: isJobKind(search.type) ? search.type : null,
    create: isTruthy(search.new),
    select: parseSelectedIds(search.select),
  };
}

export interface JobDetailSearch {
  type: JobKind | null;
  tab: JobTab;
}

export function parseJobDetailSearch(search: Record<string, unknown>): JobDetailSearch {
  return { type: isJobKind(search.type) ? search.type : null, tab: parseJobTab(search.tab) };
}

/** The list of one kind. */
export function jobsListTo(kind: JobKind): { to: LinkProps["to"]; search: { type: JobKind } } {
  return { to: JOBS_PATH as LinkProps["to"], search: { type: kind } };
}

/** The list of one kind with the editor open on a new job, optionally with objects or machines selected. */
export function newJobTo(
  kind: JobKind,
  selected: readonly string[] = [],
): { to: LinkProps["to"]; search: { type: JobKind; new: 1; select?: string } } {
  const ids = parseSelectedIds([...selected]);
  return {
    to: JOBS_PATH as LinkProps["to"],
    search: { type: kind, new: 1, ...(ids.length > 0 ? { select: ids.join(",") } : {}) },
  };
}

export function jobDefinitionPath(jobId: string): string {
  return `${JOB_DEFINITIONS_PATH}/${encodeURIComponent(jobId)}`;
}

/** One job's page; the tab is the overview unless given. */
export function jobDefinitionTo(
  jobId: string,
  kind: JobKind,
  tab: JobTab = "overview",
): { to: LinkProps["to"]; search: { type: JobKind; tab?: JobTab } } {
  return {
    to: jobDefinitionPath(jobId) as LinkProps["to"],
    search: { type: kind, ...(tab === "overview" ? {} : { tab }) },
  };
}

/**
 * A target as `<Link>` takes it. The route tree does not know the feature routes
 * statically, so the search is handed over untyped; the builders above keep their
 * exact shapes for everything else.
 */
export function linkProps<S>(target: { to: LinkProps["to"]; search: S }): {
  to: LinkProps["to"];
  search: never;
} {
  return { to: target.to, search: target.search as never };
}
