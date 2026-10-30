import {
  Check,
  Globe,
  HardDrive,
  Inbox,
  Server,
  ShieldAlert,
  Users,
  UsersRound,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, ErrorState, RelativeTime, StatusBadge } from "@/components/kit";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { ObjectKind, SnapshotObject } from "@/features/restore/api";
import { ObjectIcon, objectLabel } from "@/features/restore/explorer/entry-icon";
import { type AccountTypeFilter, accountAddress } from "@/features/restore/lib/accounts";
import {
  firstAreaOf,
  latestBackupOf,
  type Person,
  readinessOf,
} from "@/features/restore/lib/people";
import { usePeople } from "@/features/restore/use-restore-data";
import "@/features/suspicion/i18n";
import type { ObjectState } from "@/features/verify/api";
import { StateBadge } from "@/features/verify/components/status";
import { cn } from "@/lib/utils";

const TYPE_ICONS: Record<ObjectKind, typeof Inbox> = {
  mailbox: Inbox,
  onedrive: HardDrive,
  site: Globe,
  group: UsersRound,
  imap: Server,
};

/** How long the search waits after the last keystroke before it asks the API. */
export const SEARCH_DEBOUNCE_MS = 300;

interface AccountListProps {
  /** The object the explorer shows. */
  value: string | null;
  /** Show another object; `path` opens it at that folder (a person's first area). */
  onChange: (objectId: string, path?: string) => void;
  /** Accounts whose newest restore point shows signs of ransomware (docs/RANSOMWARE.md). */
  suspicious?: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * The explorer's left column: one entry per person (#49), their mailbox, OneDrive and IMAP
 * account together, and SharePoint and Teams sites with the group mailboxes (group calendar and
 * conversations) of Microsoft 365 groups in a section of their own. The API groups,
 * orders (the viewer's own entry first, then by name), searches (names, addresses and account
 * ids) and filters, and hands out a page at a time: more load when the end of a section scrolls
 * into view or on "Show more", so a tenant of tens of thousands of people stays quick. Each
 * entry shows its protection and readiness; display names only, never a raw id.
 */
export function AccountList({ value, onChange, suspicious = NONE }: AccountListProps) {
  const { t } = useTranslation("restore");
  const [typeFilter, setTypeFilter] = React.useState<AccountTypeFilter>("all");
  const [query, setQuery] = React.useState("");
  const search = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const kind = typeFilter === "all" ? null : typeFilter;

  // SharePoint sites and Microsoft 365 group mailboxes belong to no person: they make up the
  // "SharePoint & Teams" section; every other kind lists people.
  const teamsKind = typeFilter === "site" || typeFilter === "group";
  const showPeople = !teamsKind;
  const showSites = typeFilter === "all" || teamsKind;
  const peopleQuery = usePeople("people", search, kind, showPeople);
  const sitesQuery = usePeople("sites", search, teamsKind ? kind : null, showSites);
  const people = showPeople ? (peopleQuery.data?.pages.flatMap((page) => page.items) ?? []) : [];
  const sites = showSites ? (sitesQuery.data?.pages.flatMap((page) => page.items) ?? []) : [];
  const peopleTotal = peopleQuery.data?.pages[0]?.total ?? 0;
  const sitesTotal = sitesQuery.data?.pages[0]?.total ?? 0;
  const loading = (showPeople && peopleQuery.isPending) || (showSites && sitesQuery.isPending);
  // A failed read must not pass for a tenant without accounts: the restore starts here. Entries
  // that did load stay visible; the error shows only while nothing else can be listed.
  const failed = (showPeople && peopleQuery.isError) || (showSites && sitesQuery.isError);

  const activePerson = value
    ? (people.find((person) => person.objects.some((object) => object.id === value)) ?? null)
    : null;
  const activeKey = activePerson ? `person:${activePerson.key}` : value ? `site:${value}` : "";

  // cmdk highlights its own current item independently of `value` (the
  // *active* entry) — left uncontrolled, it defaults to the first row, so the
  // first row and the active entry could both look selected at once.
  // Controlling it keeps cmdk's highlight following the active entry, while
  // still letting the user move it with the arrow keys.
  const [highlighted, setHighlighted] = React.useState("");
  React.useEffect(() => {
    setHighlighted(activeKey);
  }, [activeKey]);

  const choosePerson = (person: Person) => {
    if (activePerson?.key === person.key) {
      return;
    }
    const first = firstAreaOf(person);
    if (first) {
      onChange(first.object.id, first.path || undefined);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-3 py-2.5">
        <h2 className="text-sm font-semibold">{t("explorer.accounts.title")}</h2>
      </div>
      <div className="border-b border-border p-2">
        <Select
          value={typeFilter}
          onValueChange={(next) => setTypeFilter(next as AccountTypeFilter)}
        >
          <SelectTrigger size="sm" className="w-full" aria-label={t("explorer.accounts.typeLabel")}>
            <SelectValue>
              {typeFilter === "all"
                ? t("explorer.accounts.typeAll")
                : t(`explorer.accounts.types.${typeFilter}`)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              <Users />
              {t("explorer.accounts.typeAll")}
            </SelectItem>
            {(Object.keys(TYPE_ICONS) as ObjectKind[]).map((kind) => {
              const Icon = TYPE_ICONS[kind];
              return (
                <SelectItem key={kind} value={kind}>
                  <Icon />
                  {t(`explorer.accounts.types.${kind}`)}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
      <Command
        className="min-h-0 flex-1 bg-transparent"
        loop
        // The list filters itself (people by every name and address they have): cmdk only
        // keeps the keyboard highlight.
        shouldFilter={false}
        // cmdk gives its own hidden `<label>` (built from this `label` prop)
        // to the input via `aria-labelledby`, which wins over any `aria-label`
        // `CommandInput` is given below — so the input's accessible name has
        // to be set *here*, not on `CommandInput` itself.
        label={t("explorer.accounts.searchLabel")}
        value={highlighted}
        onValueChange={setHighlighted}
      >
        <CommandInput
          placeholder={t("explorer.accounts.searchPlaceholder")}
          value={query}
          onValueChange={setQuery}
        />
        <CommandList className="max-h-none flex-1">
          {loading ? (
            <div className="space-y-2 p-2" aria-busy="true">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : people.length === 0 && sites.length === 0 && failed ? (
            <div className="p-2">
              <ErrorState
                title={t("explorer.accounts.loadError")}
                error={peopleQuery.error ?? sitesQuery.error}
                onRetry={() => {
                  if (peopleQuery.isError) {
                    void peopleQuery.refetch();
                  }
                  if (sitesQuery.isError) {
                    void sitesQuery.refetch();
                  }
                }}
                retrying={peopleQuery.isFetching || sitesQuery.isFetching}
              />
            </div>
          ) : people.length === 0 && sites.length === 0 ? (
            <CommandEmpty>
              <EmptyState
                icon={Users}
                title={t("explorer.accounts.empty")}
                description={t("explorer.accounts.emptyDescription")}
                variant="plain"
              />
            </CommandEmpty>
          ) : null}
          {people.length > 0 ? (
            <CommandGroup
              heading={sites.length > 0 ? t("explorer.accounts.people") : undefined}
              data-slot="account-people"
            >
              {people.map((person) => (
                <PersonItem
                  key={person.key}
                  person={person}
                  active={activePerson?.key === person.key}
                  suspicious={person.objects.some((object) => suspicious.has(object.id))}
                  onSelect={() => choosePerson(person)}
                />
              ))}
              {peopleQuery.hasNextPage ? (
                <ShowMore
                  rest={peopleTotal - people.length}
                  loading={peopleQuery.isFetchingNextPage}
                  onMore={() => void peopleQuery.fetchNextPage()}
                />
              ) : null}
            </CommandGroup>
          ) : null}
          {sites.length > 0 ? (
            <CommandGroup heading={t("explorer.accounts.sites")} data-slot="account-sites">
              {sites.flatMap((entry) => {
                const site = entry.objects[0];
                return site
                  ? [
                      <SiteItem
                        key={entry.key}
                        site={site}
                        active={site.id === value}
                        suspicious={suspicious.has(site.id)}
                        onSelect={() => {
                          // A group opens on its first area (the group calendar), a site at its root.
                          const area = site.kind === "group" ? firstAreaOf(entry) : null;
                          onChange(site.id, area?.path || undefined);
                        }}
                      />,
                    ]
                  : [];
              })}
              {sitesQuery.hasNextPage ? (
                <ShowMore
                  rest={sitesTotal - sites.length}
                  loading={sitesQuery.isFetchingNextPage}
                  onMore={() => void sitesQuery.fetchNextPage()}
                />
              ) : null}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </div>
  );
}

/**
 * The end of a section that has more: loads the next page when it scrolls into view (where the
 * browser can tell) and on a click.
 */
function ShowMore({
  rest,
  loading,
  onMore,
}: {
  rest: number;
  loading: boolean;
  onMore: () => void;
}) {
  const { t } = useTranslation("restore");
  const ref = React.useRef<HTMLDivElement>(null);
  const more = React.useRef(onMore);
  more.current = onMore;
  React.useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        more.current();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="px-2 py-1.5">
      <Button
        variant="ghost"
        size="sm"
        className="w-full"
        onClick={onMore}
        loading={loading}
        data-slot="account-more"
      >
        {t("explorer.accounts.more", { count: Math.max(rest, 0) })}
      </Button>
    </div>
  );
}

function PersonItem({
  person,
  active,
  suspicious,
  onSelect,
}: {
  person: Person;
  active: boolean;
  suspicious: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("restore");
  const kinds = [...new Set(person.objects.map((object) => object.kind))];
  const kindText = kinds.map((kind) => t(`explorer.object.kinds.${kind}`)).join(", ");
  const address = person.address && person.address !== person.name ? person.address : null;
  const m365 = person.objects.some((object) => object.sourceKind === "m365");

  return (
    <CommandItem
      value={`person:${person.key}`}
      onSelect={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn("items-start gap-2 py-2", active && "bg-accent text-accent-foreground")}
      data-slot="account-person"
    >
      <ObjectIcon kind={person.objects[0]?.kind ?? "mailbox"} className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex items-baseline gap-1.5 text-sm font-medium">
          <span className="min-w-0 [overflow-wrap:anywhere]">{person.name}</span>
          {person.own ? (
            <span className="shrink-0 text-xs font-normal text-muted-foreground">
              · {t("explorer.object.own")}
            </span>
          ) : null}
        </p>
        <p className="truncate text-xs text-muted-foreground" data-slot="account-address">
          {kindText}
          {address ? ` · ${address}` : ""}
        </p>
        <EntryStatus
          objects={person.objects}
          deleted={person.accountDeleted ? (m365 ? "account" : "source") : null}
          suspicious={suspicious}
        />
      </div>
      {active ? <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
    </CommandItem>
  );
}

function SiteItem({
  site,
  active,
  suspicious,
  onSelect,
}: {
  site: SnapshotObject;
  active: boolean;
  suspicious: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("restore");
  const address = accountAddress(site);
  return (
    <CommandItem
      value={`site:${site.id}`}
      onSelect={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn("items-start gap-2 py-2", active && "bg-accent text-accent-foreground")}
      data-slot="account-site"
    >
      <ObjectIcon kind={site.kind} className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium [overflow-wrap:anywhere]">{objectLabel(site)}</p>
        <p className="truncate text-xs text-muted-foreground" data-slot="account-address">
          {t(`explorer.object.kinds.${site.kind}`)}
          {address ? ` · ${address}` : ""}
        </p>
        <EntryStatus
          objects={[site]}
          deleted={site.status === "orphaned" ? "source" : null}
          suspicious={suspicious}
        />
      </div>
      {active ? <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
    </CommandItem>
  );
}

/**
 * Protected/excluded, gone (the account deleted, or the object removed from the source), the
 * least proven readiness among the entry's restore points, the newest backup, or "no restore
 * point yet". A deleted account still keeps every restore point it ever made, so its readiness
 * and last backup are exactly as relevant as for an active one — only the badge in front differs.
 */
function EntryStatus({
  objects,
  deleted,
  suspicious,
}: {
  objects: readonly SnapshotObject[];
  deleted: "account" | "source" | null;
  suspicious: boolean;
}) {
  const { t } = useTranslation("restore");
  const { t: ts } = useTranslation("suspicion");
  const imported = objects.every((object) => object.sourceKind === "import");
  const active = objects.some((object) => object.status === "active");
  const backups = objects.some((object) => object.snapshotCount > 0);
  const readiness: ObjectState = readinessOf(objects);

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {deleted === "account" ? (
        <StatusBadge tone="warning" data-slot="account-deleted">
          {t("explorer.accounts.accountDeleted")}
        </StatusBadge>
      ) : deleted === "source" ? (
        <StatusBadge tone="warning">{t("explorer.object.orphaned")}</StatusBadge>
      ) : imported ? (
        // Nothing is backed up from an imported mailbox: it is imported, never "not protected".
        <StatusBadge tone="info">{t("explorer.accounts.imported")}</StatusBadge>
      ) : (
        // Protected is a state (in scope, backed up), not a proof: neutral. The readiness
        // badge below carries the green of a passed restore check.
        <StatusBadge tone={active ? "neutral" : "muted"}>
          {t(active ? "explorer.accounts.protected" : "explorer.accounts.excluded")}
        </StatusBadge>
      )}
      {suspicious ? (
        <StatusBadge tone="destructive" icon={ShieldAlert} title={ts("object.hint")}>
          {ts("object.suspicious")}
        </StatusBadge>
      ) : null}
      {!backups ? (
        <StatusBadge tone="muted">{t("explorer.restorePoint.none")}</StatusBadge>
      ) : (
        <>
          {imported ? null : <StateBadge state={readiness} />}
          <span className="text-muted-foreground">
            {t(imported ? "explorer.accounts.lastImport" : "explorer.accounts.lastBackup")}{" "}
            <RelativeTime value={latestBackupOf(objects)} focusable={false} />
          </span>
        </>
      )}
    </div>
  );
}
