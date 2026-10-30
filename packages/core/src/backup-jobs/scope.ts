// Which protected objects a mail job covers right now. One rule for the scheduler (what to plan),
// the API (what a job shows as its scope) and the worker (whose retention a job names), so they
// can never disagree about what belongs to a job.

/** A protected object as the rule sees it. `eligible` says the job may act on it at all. */
export interface ScopeObject {
  readonly id: string;
  readonly eligible: boolean;
}

/** A member row: the object belongs to exactly this job. */
export interface ScopeMember {
  readonly jobId: string;
  readonly protectedObjectId: string;
}

export interface ScopedJob {
  readonly id: string;
  readonly scopeMode: "all" | "selected";
}

/**
 * The objects of a mail job. A `selected` job covers its members. An `all` job covers every
 * eligible object that is not a member of another job, the objects added later included; its own
 * member rows only carry overrides. Objects come out in the order they went in.
 */
export function mailJobObjectIds(
  job: ScopedJob,
  members: readonly ScopeMember[],
  objects: readonly ScopeObject[],
): string[] {
  if (job.scopeMode === "selected") {
    const own = new Set(
      members.filter((member) => member.jobId === job.id).map((member) => member.protectedObjectId),
    );
    return objects.filter((object) => object.eligible && own.has(object.id)).map((o) => o.id);
  }
  const elsewhere = new Set(
    members.filter((member) => member.jobId !== job.id).map((member) => member.protectedObjectId),
  );
  return objects.filter((object) => object.eligible && !elsewhere.has(object.id)).map((o) => o.id);
}

/** A mail job as the "in no job" rule sees it. */
export interface CoveringJob extends ScopedJob {
  readonly enabled: boolean;
}

/**
 * The source of an object is one the scheduler works against: consented/connected, or failing but
 * worth retrying; never the import source (apps/scheduler planning.ts `sourceUsable`).
 */
export function mailSourceUsable(kind: string, status: string): boolean {
  return kind !== "import" && (status === "active" || status === "error");
}

/** Whether the scheduler may plan an object at all: active, on a source that works. */
export function mailObjectEligible(
  object: { readonly status: string },
  source: { readonly kind: string; readonly status: string },
): boolean {
  return object.status === "active" && mailSourceUsable(source.kind, source.status);
}

/**
 * The objects that may be backed up (eligible) but that no ENABLED mail job covers: nothing backs
 * them up any more, whatever their old backups score. The recovery-readiness overview, the
 * protected objects, the dashboard, the integration API, the provider view and the overdue alert
 * all read it from here, as for Proxmox VE guests and file shares ("in no backup job").
 *
 * Coverage is {@link mailJobObjectIds}: a `selected` job covers its members, an `all` job every
 * eligible object that is no member of another job. The scope of a job is read against every
 * member row (a disabled job's members are held by that job), but only an enabled job counts as
 * covering. An object that may not be backed up at all (excluded, orphaned, a source that does
 * not work) is never "in no job": its own state says why nothing backs it up.
 */
export function mailObjectsInNoJob(
  jobs: readonly CoveringJob[],
  members: readonly ScopeMember[],
  objects: readonly ScopeObject[],
): Set<string> {
  const covered = new Set<string>();
  for (const job of jobs) {
    if (!job.enabled) {
      continue;
    }
    for (const id of mailJobObjectIds(job, members, objects)) {
      covered.add(id);
    }
  }
  return new Set(
    objects.filter((object) => object.eligible && !covered.has(object.id)).map((o) => o.id),
  );
}
