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
