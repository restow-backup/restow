import { ChevronRight, Info } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { PersonMembership, SnapshotObject } from "@/features/restore/api";
import { ObjectIcon, objectLabel } from "@/features/restore/explorer/entry-icon";
import { usePersonMemberships } from "@/features/restore/use-restore-data";
import { cn } from "@/lib/utils";

/**
 * The "Teams & sites" area of a person's entry (#89): the Microsoft 365 group mailboxes and
 * SharePoint sites the person owns or belongs to, as the directory sync read them, owned ones
 * first, a page at a time from the API (`GET /snapshots/people/memberships`). Each leads to the
 * object's own entry in "SharePoint & Teams", with its restore points; a restore from there
 * follows the same rules as from that section. Only restore operators and administrators see
 * sites and group mailboxes, so the page shows this area to them alone. While the directory sync
 * has not read every group (never yet, the permission is missing, or Graph refused some), the
 * area says that the list may be incomplete: an empty list is no proof that there is nothing.
 */
export function PersonMemberships({
  personKey,
  onOpen,
}: {
  /** The person's entry (`user:<id>`). */
  personKey: string;
  onOpen: (object: SnapshotObject) => void;
}) {
  const { t } = useTranslation("restore");
  const memberships = usePersonMemberships(personKey);
  const items = memberships.data?.pages.flatMap((page) => page.items) ?? [];
  const total = memberships.data?.pages[0]?.total ?? 0;
  const complete = memberships.data?.pages[0]?.complete ?? true;
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className="mt-3 border-t pt-3 text-sm"
      data-slot="person-memberships"
    >
      <h3 id={titleId} className="px-2 pb-1 text-xs font-medium text-muted-foreground">
        {t("explorer.memberships.title")}
      </h3>
      {memberships.isPending ? (
        <div className="space-y-1 px-2">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      ) : memberships.isError ? (
        <div className="space-y-1 px-2" role="alert">
          <p className="text-xs text-muted-foreground">{t("explorer.memberships.loadError")}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void memberships.refetch()}
            loading={memberships.isFetching}
          >
            {t("explorer.memberships.retry")}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground" data-slot="person-memberships-empty">
          {t(complete ? "explorer.memberships.empty" : "explorer.memberships.emptyIncomplete")}
        </p>
      ) : (
        <>
          {complete ? null : (
            <p
              className="flex items-start gap-1.5 px-2 pb-1 text-xs text-muted-foreground"
              data-slot="person-memberships-incomplete"
            >
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{t("explorer.memberships.incomplete")}</span>
            </p>
          )}
          <ul className="space-y-0.5">
            {items.map((membership) => (
              <li key={membership.object.id}>
                <MembershipItem membership={membership} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </>
      )}
      {memberships.hasNextPage ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full"
          onClick={() => void memberships.fetchNextPage()}
          loading={memberships.isFetchingNextPage}
          data-slot="person-memberships-more"
        >
          {t("explorer.memberships.more", { count: Math.max(total - items.length, 0) })}
        </Button>
      ) : null}
    </section>
  );
}

function MembershipItem({
  membership,
  onOpen,
}: {
  membership: PersonMembership;
  onOpen: (object: SnapshotObject) => void;
}) {
  const { t } = useTranslation("restore");
  const { object, role } = membership;
  const name = objectLabel(object);
  return (
    <button
      type="button"
      onClick={() => onOpen(object)}
      data-slot="person-membership"
      data-kind={object.kind}
      data-role={role}
      className={cn(
        "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left",
        "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <ObjectIcon kind={object.kind} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {t(`explorer.object.kinds.${object.kind}`)}
          {object.latestSnapshotAt ? (
            <>
              {" · "}
              <RelativeTime value={object.latestSnapshotAt} focusable={false} />
            </>
          ) : null}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        {/* A role, not a state: neutral. */}
        <StatusBadge tone="neutral">{t(`explorer.memberships.roles.${role}`)}</StatusBadge>
        {object.status === "orphaned" ? (
          <StatusBadge tone="warning">{t("explorer.areas.gone")}</StatusBadge>
        ) : object.snapshotCount === 0 ? (
          <StatusBadge tone="muted">{t("explorer.areas.noBackup")}</StatusBadge>
        ) : null}
      </span>
      {/* The accessible name is the content (name, kind, role, state), plus where it leads. */}
      <span className="sr-only">{t("explorer.memberships.open")}</span>
      <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}
